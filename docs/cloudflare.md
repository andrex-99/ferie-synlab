# Portare l'app su Cloudflare

Questa è la mappa del lavoro per spostare l'app su Cloudflare, con quello che è
già pronto e quello che manca. **Non è una migrazione da un comando:** l'app è un
processo Python con un database su file, e Cloudflare non esegue processi.

## 1. Tre modi, tre risultati diversi

| Modo | Dove gira l'app | Costo | Cosa cambia nel codice | Dati |
| --- | --- | --- | --- | --- |
| **Tunnel** (`cloudflared`) | sulla tua macchina / VM come oggi | **gratis** | **niente** | restano su disco, come ora |
| **Workers + D1 + R2 + Cron** | dentro Cloudflare | gratis (limiti) o ~5 $/mese | **riscrittura** del server in Worker Python | D1 (dati) e R2 (file) |
| **Containers** | contenitore Linux dentro Cloudflare | piano Workers Paid, da ~5 $/mese | poca, ma il disco è **effimero** | servono comunque D1/R2 |

In sintesi: il **Tunnel** mette l'app «dietro e sotto» Cloudflare in un'ora e
senza toccare il codice, ma la macchina deve restare accesa. Per averla **dentro**
Cloudflare bisogna riscrivere il server: è un lavoro di più giornate, non una
configurazione.

### Se hai già un progetto Cloudflare Pages

Pages collegato a GitHub pubblica da solo a ogni push, ma **non esegue questo
backend**:

- le **Pages Functions** sono documentate per JavaScript/TypeScript; Python è un
  linguaggio dei **Worker**, non delle Functions. Una Function può chiamare un
  Worker Python con un *service binding*, ma è un secondo pezzo da scrivere;
- su Pages **non esistono i Cron Trigger**, quindi promemoria e riepilogo
  settimanale non potrebbero girare lì;
- D1 e R2 invece sono disponibili come binding anche su Pages, e il progetto ha
  un URL `*.pages.dev` gratis, senza dominio;
- un dominio personalizzato su un sottodominio si può agganciare anche con un
  CNAME esterno, ma per un dominio *apex* serve la zona su Cloudflare.

Quindi Pages va bene per **servire il frontend** (`public/` è già tutto statico),
mentre l'API resta sul server Python raggiunto dal tunnel; in alternativa si
riscrive l'API come Worker. Il frontend oggi chiama `/api/...` in modo relativo
con `credentials: "same-origin"`: per separare i due pezzi servirebbe lo stesso
dominio (Pages + Function che inoltra `/api` al tunnel) oppure CORS, cookie
`SameSite=None; Secure` e una base URL configurabile nel client.

## 2. Fase 0 — Worker su `workers.dev` (fatto, online)

Il sito è pubblicato su Cloudflare e **funziona**: `https://ferie-synlab.espoandy99.workers.dev`
serve l'interfaccia e inoltra le API al server Python, sullo stesso hostname
(quindi cookie di sessione compresi).

Come è fatto:

- [`cloudflare/worker.js`](../cloudflare/worker.js) — serve i file di `public/` con
  il binding `ASSETS` e inoltra solo `/api/*` e `/calendar.ics` a `ORIGIN`.
  Riscrive `Origin` (altrimenti il server risponde `403` ai `POST`) e
  `X-Forwarded-Proto` (così il cookie è `Secure` in HTTPS e non in locale).
- [`cloudflare/wrangler.jsonc`](../cloudflare/wrangler.jsonc) — nome `ferie-synlab`,
  asset da `../public`, `run_worker_first: true`, variabile `ORIGIN`.
- [`cloudflare/package.json`](../cloudflare/package.json) — solo `wrangler` come
  dipendenza di sviluppo.

Comandi (Node e `wrangler` non sono installati nel sistema: sono in `.tools/`,
ignorato da git — `export PATH="$PWD/../.tools/node/bin:$PATH"`):

```bash
cd cloudflare
npx wrangler dev --var ORIGIN:http://127.0.0.1:8080   # locale, senza login
npx wrangler deploy                                  # pubblica su workers.dev
npx wrangler deploy --var ORIGIN:https://ferie.tuodominio.it
```

Cambiare `ORIGIN` è l'unico passaggio per spostare il backend da Render a una VM
o a un tunnel: il frontend e i cookie restano su Cloudflare.

Cosa **non** risolve: il backend continua a girare su Render (piano gratuito),
quindi si addormenta dopo 15 minuti e azzera i dati a ogni deploy. Il passo
successivo per l'uso reale è mettere `ORIGIN` su una VM con disco persistente
(fase 1) e, se si vuole, riscrivere tutto dentro Cloudflare (fase 2).

Verificato il 24 ottobre 2026 su quell'URL: pagina `200`, CSS/JS `200`,
`/api/config` `200`, login `200` con cookie, `/api/session` con il nome utente,
`POST /api/requests` `201`, approvazione `200`, riepilogo `200`, logout che
cancella il cookie; anche dal browser la schermata di accesso e la vista
coordinatore caricano (4 persone, registro email, selettore del riepilogo).

## 3. Fase 1 — Cloudflare davanti all'app (pronta)

Già preparato in questo repository:

- [`deploy/cloudflare/tunnel.yml`](../deploy/cloudflare/tunnel.yml) — tunnel con
  nome, hostname pubblico, `httpHostHeader` corretto per i link nelle email.
  Validato con `cloudflared tunnel --config … ingress validate`.
- [`deploy/docker-compose.tunnel.yml`](../deploy/docker-compose.tunnel.yml) —
  variante del compose che sostituisce Caddy con `cloudflared` (nessuna porta
  pubblicata, nessun certificato da rinnovare).
- `CLOUDFLARE_TUNNEL_TOKEN` documentato in [`.env.example`](../.env.example).

Passi, una volta sola (servono account Cloudflare e un dominio con i nameserver
su Cloudflare):

```bash
# 1. tunnel creato dal pannello: Zero Trust → Networks → Tunnels → Create
#    tipo "Cloudflared", Public Hostname: ferie.tuodominio.it → HTTP app:8080
#    poi nel .env della radice:
#      CLOUDFLARE_TUNNEL_TOKEN=...      (token del tunnel)
#      APP_BASE_URL=https://ferie.tuodominio.it

# 2. app + tunnel (al posto di Caddy)
sudo docker compose --env-file .env \
  -f deploy/docker-compose.yml -f deploy/docker-compose.tunnel.yml up -d --build
```

`--env-file .env` non è un dettaglio: le variabili `${...}` dei file compose
vengono lette da lì, non dai `env_file` dei container.

Senza Docker, con `cloudflared` installato sulla macchina:

```bash
cloudflared tunnel login
cloudflared tunnel create ferie
cloudflared tunnel route dns ferie ferie.tuodominio.it
cloudflared tunnel --config deploy/cloudflare/tunnel.yml run ferie
```

**Demo senza dominio** (URL temporaneo, cambia a ogni avvio, nessuna garanzia di
uptime):

```bash
python3 server.py serve --port 8080 --no-open &
cloudflared tunnel --url http://127.0.0.1:8080
```

Verificato davvero il 24 ottobre 2026 con un quick tunnel: pagina iniziale `200`,
`/styles.css` e `/app.js` con il tipo corretto, `/api/config` che restituisce
`base_url` **https** (i link nelle email restano validi), login con cookie di
sessione e `/api/requests/pending` autenticato `200` attraverso l'edge Cloudflare.

Limite della fase 1: se la macchina si spegne o dorme, il sito non risponde. È
il motivo per cui per un'app di team resta consigliata una VM sempre accesa
(vedi [hosting.md](hosting.md)).

## 4. Fase 2 — L'app dentro Cloudflare (da fare)

Riferimenti verificati sulla documentazione Cloudflare: Python Workers è **GA**
dal 21 settembre 2026 e gira su **Pyodide** (WebAssembly) dentro l'isolate, con
handler `fetch` e `scheduled`; **non** c'è filesystem persistente, **non** ci
sono thread, la porta SMTP 25 è bloccata; D1, R2, KV e Durable Objects sono
usabili dai Worker Python via FFI. Containers è **GA** dal 13 aprile 2026 ma è
sul piano a pagamento e il disco locale è azzerato a ogni stop.

### Cosa diventa cosa

| Pezzo di oggi | Su Cloudflare | Note |
| --- | --- | --- |
| `http.server` + `handle_api` (28 rotte) | Worker Python con handler `fetch` + router | si riusa la logica, cambia il trasporto |
| `data/db.json` + `save_db` | **D1** (SQLite) | `users`, `requests`, `outbox`, `push`, `meta` |
| `data/outbox/*.html`, avatar | **R2** | un oggetto per email, uno per avatar |
| `data/vapid.json` | **variabili segrete** del Worker | niente file |
| `reminder_loop`, `digest_loop` (thread) | **Cron Triggers** | ogni 15 minuti + un trigger per il riepilogo |
| `smtplib` / `urllib` verso Resend | **solo Resend via `fetch`** | SMTP non è una strada praticabile |
| cookie `sess` firmato con HMAC | identico, HMAC da `crypto.subtle` o `hashlib` | la sessione è già stateless: nessuna tabella |
| `webpush.py` (VAPID, AES-GCM) | `crypto.subtle` (ECDSA P-256, ECDH, HKDF, AES-GCM) | **il pezzo più delicato**: le primitive ci sono, non esiste una ricetta ufficiale pronta |
| Diagnostica admin | D1 + log in una tabella | spariscono pid, uptime di processo e dimensione dei file: quei riquadri vanno ripensati |
| `public/` (HTML/CSS/JS/icone) | **Workers Assets** (o Pages) | nessuna modifica, basta il binding `ASSETS` |

### Ordine di lavoro proposto

1. **Scheletro**: progetto Worker Python con `wrangler`, binding `ASSETS`, D1 e
   R2; una rotta di prova `/api/health` per verificare il deploy.
2. **Dati**: schema D1 (cinque tabelle, indici su `requests.status` e
   `requests.user_id`) e script di import da `db.json`, così i dati attuali si
   possono caricare e confrontare.
3. **Autenticazione**: login/logout/sessione con lo stesso formato di cookie
   firmato; PIN con lo stesso `pbkdf2` già usato oggi.
4. **Richieste**: creazione, decisione, annullamento, rivalutazione, calendario e
   `.ics` — la parte più corposa, con i test che già esistono come specifica.
5. **Email**: invio solo via Resend (`fetch`), registro in D1 + HTML in R2,
   reinvio, email di prova.
6. **Cron**: promemoria ogni 15 minuti e riepilogo settimanale (stessa logica di
   `weekly_digest_due`, con `meta` su D1 al posto del file).
7. **Push**: VAPID con WebCrypto. Se non regge, si può partire senza push e
   aggiungerlo dopo: è l'unico pezzo con rischio tecnico alto.
8. **Verifica**: gli stessi scenari dei 40 test attuali contro `wrangler dev`, più
   il doppio utente e il `403` dell'admin.

### Rischi da mettere in conto

- **CPU**: il piano gratuito dà **10 ms di CPU per invocazione**; con Python su
  Pyodide è il limite che salta per primo. Se salta, serve Workers Paid
  (~5 $/mese) o un runtime JS.
- **Cold start**: il primo avvio di un isolate Pyodide è più lento di una
  richiesta Python normale; per un team piccolo è accettabile, per un'app
  «scatto» no.
- **Push**: da rifare e da testare su iOS e Android, non è copiato e incollato.
- **Diagnostica**: alcuni dati di oggi (PID, uptime, dimensione su disco) non
  esistono in un Worker e vanno sostituiti, non finti.
- **Doppio codice**: durante la migrazione convivono `server.py` e il Worker.
  Meglio finire la fase 2 su un branch e tenere Render/VM come fallback finché i
  test non passano tutti.

## 5. Cosa serve da te

1. **Account Cloudflare** (c'è, l'hai autorizzato con `wrangler login`) — serve
   solo per pubblicare: da qui in avanti `npx wrangler deploy` è sufficiente.
2. **Dominio**, se vuoi `ferie.qualcosa.it` al posto di `workers.dev`: un
   sottodominio si può agganciare anche senza spostare i nameserver; per l'apex
   serve la zona su Cloudflare.
3. Per l'uso reale del team: **una VM sempre accesa** con `data/` sul disco, che
   diventa l'`ORIGIN` del Worker.
4. Solo per la fase 2 (riscrittura): carta per Workers Paid se il piano gratuito
   non basta di CPU.

## 6. Percorso scelto (24 ottobre 2026)

- **Scelto e già attivo**: Cloudflare serve il sito e inoltra le API
  (`worker.js` + asset), backend su Render per ora. URL:
  `https://ferie-synlab.espoandy99.workers.dev`.
- **Dominio**: `radiologiamf.it` non è registrato (il registro `.it` risponde
  `Status: AVAILABLE`, il DNS `NXDOMAIN`). Finché non esiste, non c'è nessuna
  zona da mettere su Cloudflare né record da puntare a un tunnel: si resta su
  `workers.dev`, che funziona ed è gratis.
- Quando il dominio esisterà, in ordine:
  1. registrarlo presso un registrar che gestisca `.it`;
  2. **Add a site** su Cloudflare e prendere i nameserver assegnati;
  3. cambiare i nameserver dal registrar e attendere l'attivazione della zona;
  4. **Workers → ferie-synlab → Settings → Domains & Routes → Add custom domain**
     (in alternativa, tunnel con `deploy/cloudflare/tunnel.yml` verso la VM);
  5. aggiornare `APP_BASE_URL` sul backend con l'indirizzo pubblico, così i link
     nelle email puntano lì.
- Il token del tunnel o qualsiasi altro segreto va solo nel `.env` della VM o nei
  Secrets di Cloudflare, mai nel repository.

## 7. Stato del lavoro

- [x] Ricognizione di cosa Cloudflare sa fare oggi (Workers Python GA, Containers
      GA a pagamento, Tunnel gratuito).
- [x] Config del tunnel con nome + variante Docker + token nel `.env.example`.
- [x] Prova end-to-end con quick tunnel (HTTP, asset, cookie, login).
- [x] Worker su Cloudflare con asset statici + proxy API, online su
      `https://ferie-synlab.espoandy99.workers.dev`.
- [ ] `APP_BASE_URL` sul backend uguale all'URL pubblico, così i link nelle
      email puntano al sito su Cloudflare e non a Render.
- [ ] Backend su una VM con disco persistente (`ORIGIN` aggiornato).
- [ ] Dominio personalizzato per il Worker (facoltativo: si può agganciare anche
      senza spostare i nameserver).
- [ ] Decisione sulla fase 2 (riscrittura su D1).
- [ ] Schema D1, import dei dati, Worker, cron, push.

## Fonti

- Python Workers GA: <https://blog.cloudflare.com/python-workers-ga/>
- Come funzionano i Python Workers: <https://developers.cloudflare.com/workers/languages/python/how-python-workers-work/>
- Standard library e filesystem effimero: <https://developers.cloudflare.com/workers/languages/python/stdlib/>
- Binding dai Worker Python (D1/R2/KV/DO): <https://developers.cloudflare.com/workers/languages/python/ffi/>
- Cron Triggers: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- Limiti del piano gratuito: <https://developers.cloudflare.com/workers/platform/limits/>
- Socket TCP e porta 25 bloccata: <https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/>
- Containers GA e prezzi: <https://developers.cloudflare.com/containers/platform/pricing/>
- Ciclo di vita Containers (disco effimero): <https://developers.cloudflare.com/containers/concepts/architecture/>
- Quick Tunnels: <https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/>
- Tunnel con hostname e requisiti DNS: <https://developers.cloudflare.com/tunnel/get-started/>
