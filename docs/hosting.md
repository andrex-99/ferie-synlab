# Mettere l'app online per davvero (e gratis)

Questa guida riguarda il **server Python** (`server.py`), per chi vuole ospitarlo
su una **macchina propria** con disco persistente. L'app in produzione non usa
più questo percorso: gira su **Cloudflare Worker + D1**, e la guida di
riferimento è [cloudflare.md](cloudflare.md).

- [Perché Render gratis non basta per il team](#perché-render-gratis-non-basta-per-il-team)
- [Quale host scegliere](#quale-host-scegliere)
- [Ricetta consigliata: Oracle Cloud Always Free](#ricetta-consigliata-oracle-cloud-always-free)
- [Alternativa: Google Cloud e2-micro](#alternativa-google-cloud-e2-micro)
- [Cloudflare: si può?](#cloudflare-si-può) · piano completo in [cloudflare.md](cloudflare.md)
- [Quale provider email usare](#quale-provider-email-usare)
- [Verificare che le email partano davvero](#verificare-che-le-email-partano-davvero)
- [Aggiornare e fare un backup](#aggiornare-e-fare-un-backup)

## Perché serve un disco persistente

| Cosa | Host senza disco persistente | Serve per l'uso reale |
| --- | --- | --- |
| Accensione | può spegnersi dopo 15 minuti di inattività (prima richiesta lenta) | sempre acceso |
| Disco | temporaneo: a ogni deploy o riavvio si perdono richieste, account creati, chiavi VAPID | disco che sopravvive |
| Notifiche push | i telefoni vanno riattivati a ogni riavvio (le chiavi cambiano) | chiavi stabili |
| Aggiornamenti | deploy manuale o automatico | `git pull` e riavvio |

Cloudflare risolve il problema alla radice (Worker + D1, niente disco da
montare); questa pagina spiega l'alternativa con una VM.

## Quale host scegliere

Verificato a **ottobre 2026**, solo opzioni gratuite:

| Host | Sempre acceso | Disco persistente | HTTPS | Carta | Note |
| --- | --- | --- | --- | --- | --- |
| **Oracle Cloud Always Free** | sì | sì (200 GB totali) | con Caddy (incluso qui) | per verifica | **consigliato**: 1–2 VM gratuite per sempre |
| Google Cloud e2-micro | sì | sì (30 GB) | con Caddy | per verifica | solo regioni USA, 1 GB/mese di traffico in uscita |
| Northflank Sandbox | sì | volumi a consumo | sì | probabilmente sì | $20/mese di risorse gratuite, ma dichiarato "non per produzione" |
| Koyeb | no (sleep dopo 1 h) | no | sì | $29 di preautorizzazione | non adatto |
| Fly.io | — | sì a pagamento | sì | sì | niente più piano gratuito |
| Railway | sì | volume 0,5 GB | **0 domini propri** | sì | credito di 1 $/mese |
| PythonAnywhere free | sì | 512 MB | solo sottodominio loro | no | niente Docker, rete in uscita limitata |
| Hugging Face Spaces (CPU) | va in pausa dopo 48 h | **no** (persistent storage a pagamento) | sì | no | i dati spariscono a ogni riavvio |
| Cloudflare Containers | sì (stop dopo 10 min) | **no** (disco azzerato) | sì | richiede piano a pagamento | non ospita l'app senza riscriverne i dati su D1/R2 — vedi [Cloudflare: si può?](#cloudflare-si-può) |

L'app è un singolo processo Python con un file `data/db.json`: su una VM ci sta
comodamente e non serve altro.

## Ricetta consigliata: Oracle Cloud Always Free

Tempo: 30–40 minuti, una volta sola.

### 1. Account e VM

1. Crea l'account su <https://cloud.oracle.com/free> (la carta serve solo per la
   verifica, le risorse "Always Free" non vengono addebitate). Scegli come
   *home region* una vicina (Milano o Francoforte): non si può cambiare dopo.
2. **Compute → Instances → Create instance**.
   - Image: **Ubuntu 24.04**
   - Shape: **Ampere A1.Flex** (Arm) con 1 OCPU / 6 GB, oppure **VM.Standard.E2.1.Micro**
   - Carica (o genera) la chiave SSH: ti serve per entrare.
3. Quando è accesa, annota l'**IP pubblico**.

L'intero account ha **2 OCPU e 12 GB** Always Free su A1 (più 200 GB di disco
condivisi con i volumi di avvio) e **due** VM.Standard.E2.1.Micro. Se compare
l'errore **"out of host capacity"** non è un tuo problema di configurazione: in
quella regione non ci sono shape libere in quel momento, riprova più tardi o in
un'altra availability domain (con le Micro capita spesso).

### 2. Apri le porte 80 e 443

Nel pannello: **Networking → Virtual Cloud Networks → la tua VCN → Security
Lists → Default Security List → Add Ingress Rules**, due regole:

| Source | IP Protocol | Destination Port Range |
| --- | --- | --- |
| 0.0.0.0/0 | TCP | 80 |
| 0.0.0.0/0 | TCP | 443 |

Poi sulla VM (le immagini Ubuntu di Oracle hanno anche regole `iptables` locali):

```bash
ssh ubuntu@IP_DELLA_VM
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo apt update && sudo apt install -y iptables-persistent
sudo netfilter-persistent save
```

### 3. Docker e l'app

```bash
sudo apt install -y docker.io docker-compose-v2 git
sudo systemctl enable --now docker
sudo usermod -aG docker $USER   # poi esci e rientra con ssh
git clone https://github.com/andrex-99/ferie-synlab.git
cd ferie-synlab
cp .env.example .env
```

Apri `.env` (`nano .env`) e imposta almeno:

```ini
# Indirizzo pubblico. Senza dominio tuo va benissimo un nome sslip.io che
# contiene l'IP con i trattini al posto dei punti:
SITE_ADDRESS=158-101-23-45.sslip.io
APP_BASE_URL=https://158-101-23-45.sslip.io
PORT=8080
HOST=0.0.0.0
# Email: vedi la sezione più sotto
```

Prepara la cartella dati (il container gira con un utente senza privilegi):

```bash
sudo mkdir -p data && sudo chown -R 10001:10001 data
sudo docker compose -f deploy/docker-compose.yml up -d --build
```

Apri `https://158-101-23-45.sslip.io`: Caddy richiede il certificato a
Let's Encrypt al primo accesso (pochi secondi). Da quel momento l'app è sempre
accesa, i dati restano in `data/` e le notifiche push non vanno più riattivate.

> **Con un dominio tuo** (10–15 €/anno, facoltativo): punta un record `A`
> (`ferie.tuodominio.it`) all'IP della VM, metti lo stesso valore in
> `SITE_ADDRESS` e `APP_BASE_URL`, poi riavvia con il comando sopra.

### 4. Controlli

```bash
curl -I https://IL_TUO_INDIRIZZO          # 200
sudo docker compose -f deploy/docker-compose.yml logs -f app
```

Entra come coordinatore, crea una richiesta, guarda che arrivi l'email e che il
calendario `.ics` si apra. Se l'email non parte, il pannello **Email** mostra
l'errore del provider.

### 5. Backup automatico (e istanze inattive)

Oracle può **recuperare le istanze Always Free rimaste inattive**: lo fa se, per
7 giorni di fila, l'utilizzo di CPU (95° percentile) e di rete restano sotto il
20%, e per le shape A1 anche la memoria sotto il 20%. Un'app di team è per
natura quasi sempre ferma, quindi la regola va tenuta presente.

Due contromisure, entrambe da fare:

**a) Un backup notturno fuori dal container.** Tutto lo stato è in `data/`:

```bash
sudo mkdir -p /var/backups/ferie
sudo tee /etc/cron.daily/ferie-backup >/dev/null <<'EOF'
#!/bin/sh
cd /home/ubuntu/ferie-synlab && tar czf /var/backups/ferie/$(date +%F).tar.gz data/
find /var/backups/ferie -name '*.tar.gz' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/ferie-backup
```

Copia il `.tar.gz` più recente sul tuo computer una volta a settimana: se la VM
sparisce, ricrearla e rimettere `data/` è questione di minuti.

**b) Un po' di attività periodica.** Una riga di cron che ogni 6 ore chiama
l'app e consuma qualche secondo di CPU abbassa la probabilità di finire
nell'elenco delle istanze inattive (non è una garanzia, ma è ciò che fa chi usa
questo piano da anni):

```bash
( crontab -l 2>/dev/null; echo '0 */6 * * * curl -s -o /dev/null https://IL_TUO_INDIRIZZO/api/health && timeout 20 sh -c "while :; do :; done"' ) | crontab -
```

Se la VM viene comunque recuperata, i dati non sono persi: sono nel backup.

## Alternativa: Google Cloud e2-micro

Stessa ricetta, cambia solo la creazione della macchina:

1. <https://console.cloud.google.com> con account di fatturazione (carta per la
   verifica, il tetto gratuito è reale).
2. **Compute Engine → Create instance**: serie **E2**, tipo **e2-micro**,
   regione **us-west1**, **us-central1** o **us-east1** (altrove si paga),
   disco standard 30 GB, Ubuntu 24.04.
3. **Firewall**: spunta *Allow HTTP traffic* e *Allow HTTPS traffic*.
4. Da lì in poi identico: Docker, clone, `.env`, `docker compose`.
5. Tieni d'occhio gli **1 GB/mese** di traffico in uscita: per un team va
   benissimo, ma non usarlo per video o file grossi.

## Cloudflare: è la strada di produzione

L'app **non gira più come processo Python in produzione**: è stata portata su
**Worker + D1**, quindi Cloudflare non è più solo una porta d'ingresso ma la
casa dell'app. Non serve nessuna VM, nessun tunnel e nessun disco da montare:

- il Worker serve interfaccia e API ([cloudflare/app.js](../cloudflare/app.js));
- i dati stanno in **D1** e sopravvivono a deploy e inattività;
- il Cron Trigger manda riepilogo settimanale e promemoria;
- le email passano da Resend o Mailjet in HTTPS (SMTP non esiste in un Worker).

Istruzioni complete: [cloudflare.md](cloudflare.md).

Quanto segue resta valido **solo per chi self-hospita il server Python** su una
macchina propria, eventualmente dietro un Cloudflare Tunnel:

| Prodotto Cloudflare | L'app ci gira? | Perché |
| --- | --- | --- |
| **Workers / Pages (Python)** | no | il Python dei Workers gira in un isolate senza processo: non può tenere in vita un `http.server`, e i file scritti spariscono con l'isolate |
| **Containers** | no, gratis | richiede il piano **Workers Paid (~5 $/mese)**; il disco è **azzerato a ogni stop/riavvio** (stop dopo 10 minuti di inattività), quindi `data/db.json`, account creati e chiavi VAPID si perderebbero: servirebbe riscrivere l'app su D1/R2 |
| **Tunnel (`cloudflared`)** | **sì, gratis** | collega in uscita una macchina tua e pubblica l'app in HTTPS su un hostname scelto da te, senza aprire porte sul router |

Quindi: **non sostituisce Oracle/GCP** per l'app così com'è (un processo Python con
un file su disco). Ha senso in un caso preciso: hai già un PC/NAS sempre acceso
in studio, dietro il router, e non vuoi aprire porte né gestire un certificato.
Se invece la macchina va accesa solo per l'app, la VM Oracle resta più semplice
e più affidabile.

Il **piano completo** — config del tunnel con nome già pronta
([deploy/cloudflare/tunnel.yml](../deploy/cloudflare/tunnel.yml)), variante
Docker che sostituisce Caddy, prova fatta con un quick tunnel e la mappa del
lavoro per arrivare a girare *dentro* Cloudflare (Worker + D1) — è in
[cloudflare.md](cloudflare.md).

### Ricetta: Cloudflare Tunnel su una macchina tua

Serve un **dominio con i nameserver su Cloudflare** (il piano DNS è gratuito) e
la macchina sempre accesa con Docker.

1. Su <https://one.dash.cloudflare.com> → **Networks → Tunnels → Create a tunnel**,
   tipo **Cloudflared**, dai un nome (`ferie`) e copia il **token**.
2. Nello stesso tunnel aggiungi una **Public Hostname**:
   - *Subdomain*: `ferie`, *Domain*: `tuodominio.it`
   - *Service*: **HTTP** → `app:8080`
3. Aggiungi il tunnel al compose, al posto di Caddy, e togli le porte pubblicate:

```yaml
  tunnel:
    image: cloudflare/cloudflared:latest
    restart: unless-stopped
    command: tunnel --no-autoupdate run --token ${CLOUDFLARE_TUNNEL_TOKEN}
    depends_on:
      - app
```

   `CLOUDFLARE_TUNNEL_TOKEN=...` va nel `.env`, e `APP_BASE_URL` diventa
   `https://ferie.tuodominio.it` (è l'indirizzo che finisce nei link delle email).
   `SITE_ADDRESS` non serve più: il certificato lo gestisce Cloudflare.
4. `sudo docker compose -f deploy/docker-compose.yml up -d --build` e apri
   `https://ferie.tuodominio.it`.

Cosa ottieni: HTTPS valido (quindi **notifiche push funzionanti** anche su
iPhone, che richiedono una connessione sicura), nessuna porta aperta, IP del
router irrilevante perché la connessione parte dalla macchina.
Cosa non ottieni: continuità. Se il PC si spegne, dorme o cade la linea, il sito
non risponde — è l'unico motivo per cui, per un'app di team, la VM resta la
scelta consigliata.

## Quale provider email usare

L'app supporta **Resend**, **Mailjet** (entrambi via API HTTPS) e un normale
**SMTP**: non serve modificare codice, solo variabili in `.env`.

| Provider | Gratis | Serve un dominio tuo? | Carta |
| --- | --- | --- | --- |
| **Gmail + password per le app** | 500 destinatari/giorno | **no** | no |
| **Brevo (SMTP)** | 300 email/giorno | no, ma un mittente su dominio gratuito può finire in spam | no |
| **Resend** | 3.000/mese, 100/giorno | **sì**, verificato con record DNS | no |
| **Mailjet (API HTTPS)** | 6.000/mese, 200/giorno | no: basta verificare l'indirizzo mittente via email; con il dominio si consegna meglio | no |

**Sul Worker SMTP non è un'opzione**: le connessioni in uscita passano solo da
HTTPS, quindi servono **Resend** (con dominio verificato) o **Mailjet** (anche
con solo l'indirizzo mittente verificato). Il server Python self-hosted accetta
invece anche SMTP, se l'host non blocca le porte 25/465/587.

**Consiglio pratico:** parti con **Gmail** (zero configurazione, arriva davvero a
colleghi su Gmail, Outlook, Libero, Tiscali), e passa a **Resend** quando avrai un
dominio tuo: è l'unico dei tre che garantisce buona consegna senza finire in spam.

### Gmail (5 minuti)

1. Sull'account Google: **Sicurezza → Verifica in due passaggi** attiva (senza
   questa, la voce successiva non esiste).
2. **Sicurezza → Password per le app** → crea una password per "Posta".
3. Nel `.env`:

```ini
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_STARTTLS=1
SMTP_USER=ferie.synlab@gmail.com
SMTP_PASS=la-password-di-16-caratteri
MAIL_FROM=ferie.synlab@gmail.com
MAIL_FROM_NAME=Synlab Manifattura Firenze
COORDINATOR_EMAILS=coordinatore@esempio.it
MAIL_REPLY_TO=coordinatore@esempio.it
```

Due dettagli che fanno perdere tempo: `MAIL_FROM` deve essere **lo stesso
indirizzo** di `SMTP_USER` (Gmail riscrive o rifiuta un mittente diverso), e se
preferisci la porta **465** va messo `SMTP_STARTTLS=0` (l'app passa a SSL
implicito da sola).

Limite da conoscere: 500 destinatari al giorno e qualche rischio di finire in
spam quando si scrive verso domini aziendali. Per un team di ~10 persone va
benissimo.

### Brevo (SMTP, 300 al giorno)

1. Account su <https://www.brevo.com> (senza carta), verifica il mittente che
   vuoi usare: **Senders, Domains & Dedicated IPs → Senders → Add a sender**.
2. **SMTP & API → SMTP**: host `smtp-relay.brevo.com`, porta `587`, utente la
   tua login SMTP, password la chiave SMTP generata.
3. Stesse variabili `SMTP_*` qui sopra con quei valori.

### Resend (3000 al mese, serve un dominio)

```ini
RESEND_API_KEY=re_xxxxxxxxxxxx
MAIL_FROM=ferie@tuodominio.it
MAIL_FROM_NAME=Synlab Manifattura Firenze
```

Su <https://resend.com> aggiungi il dominio e copia i record DNS (SPF, DKIM,
DMARC) che ti mostra: senza dominio verificato Resend consegna solo all'indirizzo
del tuo account. Con il dominio verificato, `MAIL_FROM` **deve** usare quel
dominio (`ferie@tuodominio.it`), non un indirizzo Gmail.

In tutti i casi, dopo aver salvato il `.env`:

```bash
sudo docker compose -f deploy/docker-compose.yml up -d
```

## Verificare che le email partano davvero

Tre controlli, in ordine, dalla radice del progetto:

1. **Il provider è configurato?** L'app considera pronto il servizio se esiste
   `RESEND_API_KEY` + `MAIL_FROM`, oppure `SMTP_HOST` + `MAIL_FROM`. Se manca
   qualcosa, le email vengono solo registrate e l'app avvisa che il servizio non
   è configurato (`"configured": false` in `GET /api/outbox`).
2. **La prova dal pannello.** Entra come coordinatore → sezione **Email del
   coordinatore** → **Invia email di prova**. Se compare un errore, è quasi
   sempre: password per le app sbagliata, `SMTP_PORT`/`SMTP_STARTTLS` incoerenti
   (587→1, 465→0), oppure mittente Brevo/Resend non verificato.
3. **Guarda cosa è partito.** `GET /api/outbox` (solo coordinatore) elenca le
   ultime email con destinatario, oggetto, allegati ed errore: utile per capire
   se il problema è nell'app o nella consegna. Se il registro è pieno ma la
   casella è vuota, cerca nello **spam** e aggiungi il mittente ai contatti.
   Con un account **Amministratore** (ruolo nell'app o email in `ADMIN_EMAILS`)
   la scheda **Diagnostica** mostra gli stessi errori insieme ai log del server,
   alla configurazione email e al tempo di attività: è il posto giusto quando
   qualcosa non torna senza dover entrare nel container.
4. **Riepilogo settimanale.** Nello stesso pannello, **Invia riepilogo
   settimanale** manda subito l'email con le assenze della settimana successiva
   (anche vuota, così vedi il formato). Anche senza un provider configurato il
   pulsante funziona: il messaggio si genera e resta nel **registro email**
   (provider `demo`), così il formato si controlla prima di attivare l'invio.
   L'invio automatico parte dal primo
   controllo utile dopo `WEEKLY_DIGEST_WEEKDAY` alle `WEEKLY_DIGEST_HOUR`
   (default giovedì alle 08:00, fuso `TZ`, default `Europe/Rome`) e una sola
   volta a settimana: se il processo era spento in quel momento, il riepilogo
   viene recuperato appena riparte, nella stessa settimana. Il giorno si può
   cambiare da **Riepilogo ogni** nello stesso pannello: la scelta resta in
   `db.json` e prevale su `WEEKLY_DIGEST_WEEKDAY`. Su un servizio che
   va in pausa da solo non c'è nessun processo attivo all'ora prevista, quindi
   l'email può non partire: su una VM sempre accesa il problema non esiste (e
   sul Worker ci pensa il Cron Trigger).

Per la consegna: con Gmail e Brevo non serve altro; con un dominio tuo, SPF e
DKIM devono risultare **verified** nel pannello del provider, altrimenti Gmail e
Outlook scartano o mettono in spam.

## Aggiornare e fare un backup

```bash
cd ferie-synlab
git pull
sudo docker compose -f deploy/docker-compose.yml up -d --build
```

Backup (tutto lo stato è in `data/`):

```bash
tar czf ~/ferie-$(date +%F).tar.gz data/
```

Ripristino: ferma i container, sostituisci `data/`, riavvia.

> Attenzione a Oracle: le risorse Always Free dichiarate inattive (CPU e rete
> sotto il 20% per una settimana) possono essere recuperate. Per un'app usata
> ogni giorno non è un problema; se resta ferma a lungo, tienine una copia.
