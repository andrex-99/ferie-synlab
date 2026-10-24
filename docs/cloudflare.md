# L'app su Cloudflare (Worker + D1)

Produzione: <https://ferie-synlab.espoandy99.workers.dev>

L'app **non ha backend esterni**. Un solo Worker fa tutto e i dati stanno in
**D1**, il database SQLite gestito da Cloudflare:

| Pezzo | Dove | File |
| --- | --- | --- |
| Interfaccia (HTML, CSS, JS, icone) | asset statici del Worker | `public/` |
| API, login, link di approvazione, `.ics`, avatar | codice del Worker | `cloudflare/app.js`, `cloudflare/lib/` |
| Dati (utenti, richieste, email, foto, push, log) | database D1 `ferie-db` | `cloudflare/schema.sql` |
| Riepilogo settimanale e promemoria | Cron Trigger ogni ora | `cloudflare/lib/tasks.js` |
| Invio email | Resend o Mailjet via HTTPS | `cloudflare/lib/mail.js` |

Niente Render, niente VM, niente tunnel: il Worker risponde su
`*.workers.dev` (o su un dominio tuo) e D1 conserva i dati tra un deploy e
l'altro e durante i periodi di inattività.

## Cosa regge il piano gratuito

- **100.000 richieste al giorno** al Worker: un team di 10-50 persone ne fa
  qualche migliaio.
- **10 ms di CPU per richiesta**: bastano per le normali API. Il login usa
  PBKDF2 a 10.000 iterazioni proprio per restare dentro questo budget.
- **D1**: 5 GB di spazio totale, più che sufficienti per richieste, email e
  foto (max 70 KB ciascuna).
- **Cron Trigger**: uno all'ora per riepilogo e promemoria.
- **Nessuna scadenza**: il Worker non va in pausa come i servizi gratuiti con
  disco temporaneo.

## Primo deploy

```bash
npm install                      # wrangler
npx wrangler login               # una volta sola, apre il browser

# 1. tabelle nel database remoto (idempotente: si può rieseguire)
npx wrangler d1 execute ferie-db --remote --file=cloudflare/schema.sql

# 2. segreti (mai nel repository)
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))' \
  | npx wrangler secret put SESSION_SECRET

# 3. pubblicazione
npx wrangler deploy
```

Il primo caricamento di `/api/config` crea i quattro account dimostrativi
(Giulia, Luca, Sara, Marco) con i PIN del README, così l'app è subito
provabile. Si eliminano o si cambiano dal pannello del coordinatore.

### Deploy automatico da GitHub

Il Worker `ferie-synlab` è collegato al repository tramite **Workers Builds**:
ogni push su `main` ricostruisce e ripubblica. La build legge `wrangler.jsonc`
nella radice — non spostarlo. D1 e segreti restano quelli già configurati, il
deploy non li tocca.

## Segreti e variabili

Si impostano con `npx wrangler secret put NOME` (valore incollato, non scritto
nei file né in chat). Servono:

| Segreto | A cosa serve |
| --- | --- |
| `SESSION_SECRET` | firma cookie di sessione, link di approvazione e feed `.ics` |
| `MAILJET_API_KEY`, `MAILJET_SECRET_KEY` | invio email via Mailjet |
| `RESEND_API_KEY` | alternativa a Mailjet (richiede un dominio verificato) |
| `VAPID_PRIVATE_JWK` | chiave privata delle notifiche push (JSON JWK) |

Variabili pubbliche in `wrangler.jsonc`: `ORG_NAME`, `ORG_SHORT`, `ORG_SITE`,
`ORG_BRAND`, `TZ`, `APP_BASE_URL` (URL usato nei link delle email),
`WEEKLY_DIGEST`, `WEEKLY_DIGEST_WEEKDAY`, `WEEKLY_DIGEST_HOUR`,
`REMINDER_HOURS`, `MAIL_FROM_NAME`, `VAPID_PUBLIC_KEY`, `VAPID_SUBJECT`.

`MAIL_FROM` va aggiunta alle variabili (o ai segreti, se preferisci non
mostrarla) quando si attiva l'invio: è l'indirizzo mittente verificato.

Chi usa GitHub può aggiungere i segreti anche da **Settings → Secrets and
variables → Actions**, ma il deploy da Workers Builds legge quelli del Worker:
restano nel pannello Cloudflare.

## Email

1. Crea l'account su [Mailjet](https://www.mailjet.com) (6.000 email/mese,
   200 al giorno, gratis).
2. **Sender domains & addresses → Add a sender address**: aggiungi l'indirizzo
   da cui vuoi scrivere e conferma il link che arriva in quella casella. Non
   serve un dominio tuo.
3. **API Key Management**: copia API Key e Secret Key.
4. Sul Worker:

```bash
npx wrangler secret put MAILJET_API_KEY
npx wrangler secret put MAILJET_SECRET_KEY
# MAIL_FROM nelle vars di wrangler.jsonc, poi:
npx wrangler deploy
```

Senza chiavi l'app resta in **modalità simulata**: le email vengono generate e
restano nel registro (*Coordinamento → Registro email*), perfette per provare
tutto il flusso. Con le chiavi, **Invia email di prova** dalla stessa sezione
conferma il collegamento e mostra l'eventuale errore del provider parola per
parola (mittente non verificato, chiave sbagliata...).

Da notare: Mailjet non permette SMTP dalle funzioni serverless e il Worker non
ha comunque accesso alle porte SMTP; l'API HTTPS è l'unica strada.

## Riepilogo settimanale e promemoria

Il Cron Trigger `0 * * * *` (in `wrangler.jsonc`) esegue ogni ora:

1. il **riepilogo settimanale** delle assenze approvate per la settimana
   successiva, ai coordinatori, una sola volta per settimana. Il giorno si
   sceglie dall'app (*Registro email → Riepilogo ogni*): la scelta è salvata in
   D1, quindi vale per tutti e sopravvive ai deploy. L'ora resta quella di
   `WEEKLY_DIGEST_HOUR` (default 8);
2. i **promemoria** per le richieste in attesa da più di `REMINDER_HOURS` ore
   (default 24), una sola volta per richiesta.

Con `SET`/`GET` in D1 il conteggio della settimana già inviata
(`weekly_digest_week`) impedisce doppi invii anche se il Worker si riavvia.

## Dati, backup, ripristino

```bash
# esporta tutto in SQL
npx wrangler d1 export ferie-db --remote --output backup.sql

# ripristino su un database nuovo
npx wrangler d1 execute ferie-db --remote --file=cloudflare/schema.sql
npx wrangler d1 execute ferie-db --remote --file=backup.sql
```

Stesse operazioni dal pannello: **Workers & Pages → D1 → ferie-db → Export**.

Tabelle: `users`, `requests`, `meta`, `outbox`, `avatars`, `push_subscriptions`,
`logs`, `login_attempts`.

## Notifiche push

Le chiavi VAPID sono state generate una volta e messe nei segreti del Worker:
`VAPID_PUBLIC_KEY` (pubblica, nelle vars) e `VAPID_PRIVATE_JWK` (segreta). Ogni
dispositivo che attiva le notifiche viene salvato in `push_subscriptions`; gli
endpoint scaduti (404/410) vengono rimossi da soli.

Per rigenerarle (tutti i dispositivi vanno riattivati):

```bash
npm install web-push --no-save
npx web-push generate-vapid-keys
```

## Dominio tuo

Il Worker risponde già su
`https://ferie-synlab.espoandy99.workers.dev`. Per usare un dominio:

1. **Add a site** su Cloudflare e cambia i nameserver del registrar;
2. **Workers & Pages → ferie-synlab → Settings → Domains & Routes → Add custom
   domain** (es. `ferie.esempio.it`): certificato e DNS sono automatici;
3. aggiorna `APP_BASE_URL` in `wrangler.jsonc` e ridepòia: i link nelle email
   devono puntare al nuovo indirizzo.

## Sviluppo in locale

```bash
npx wrangler d1 execute ferie-db --local --file=cloudflare/schema.sql
echo "SESSION_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" > .dev.vars
npx wrangler dev
```

`.dev.vars` è ignorato da git. Il database locale sta in `.wrangler/` e si può
azzerare cancellando quella cartella (poi si riapplica lo schema).

Per una **versione di prova separata** che non tocca il sito pubblico c'è
`wrangler.port.jsonc` (Worker `ferie-cloud`, stessa D1):

```bash
npx wrangler deploy --config wrangler.port.jsonc
```

## Verifiche fatte

- **50 controlli end-to-end** su Worker locale e su quello pubblico: login e
  cookie, ruoli, creazione richiesta, sovrapposizioni, approvazione e rifiuto,
  pagina `decide` con token, notifiche, calendario, feed `.ics`, registro email,
  avatar protetti, cambio PIN, compleanni, disponibilità con orario, ritiro e
  riapertura, riepilogo immediato, diagnostica, blocco dopo dieci tentativi.
- **Persistenza**: i dati scritti su D1 restano dopo un nuovo `wrangler deploy`
  e dopo un riavvio del Worker.
- **Email**: con credenziali finte la richiesta arriva davvero a Mailjet, che
  risponde 401; l'errore viene riportato nel registro e nella Diagnostica. La
  consegna reale richiede le chiavi dell'account.

## Se qualcosa non torna

- **`error code: 1010`** su una chiamata da script: Cloudflare blocca alcune
  firme non-browser sullo stile `*.workers.dev`. Basta inviare un
  `User-Agent` di browser (i browser e le app di calendario non hanno problemi).
- **`/api/config` risponde 500 `SESSION_SECRET non configurato`**: manca il
  segreto (`npx wrangler secret put SESSION_SECRET`).
- **Login sempre rifiutato**: dopo 10 tentativi per IP l'accesso resta bloccato
  per 15 minuti (`login_attempts` in D1).
- **Email non parte**: guarda *Registro email* o *Diagnostica → Errori
  recenti*: il messaggio del provider dice cosa manca (mittente non verificato,
  chiave errata, dominio non attivo).
