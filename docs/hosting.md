# Mettere l'app online per davvero (e gratis)

Questa guida serve per il passaggio dalla **demo** su Render (piano gratuito) a un
indirizzo **sempre acceso con dati che non si azzerano**, spendendo zero.

- [Perché Render gratis non basta per il team](#perché-render-gratis-non-basta-per-il-team)
- [Quale host scegliere](#quale-host-scegliere)
- [Ricetta consigliata: Oracle Cloud Always Free](#ricetta-consigliata-oracle-cloud-always-free)
- [Alternativa: Google Cloud e2-micro](#alternativa-google-cloud-e2-micro)
- [Quale provider email usare](#quale-provider-email-usare)
- [Aggiornare e fare un backup](#aggiornare-e-fare-un-backup)

## Perché Render gratis non basta per il team

| Cosa | Render gratuito | Serve per l'uso reale |
| --- | --- | --- |
| Accensione | si spegne dopo 15 minuti di inattività (prima richiesta lenta di ~1 minuto) | sempre acceso |
| Disco | temporaneo: a ogni deploy o riavvio si perdono richieste, account creati, chiavi VAPID | disco che sopravvive |
| Notifiche push | i telefoni vanno riattivati a ogni riavvio (le chiavi cambiano) | chiavi stabili |
| Aggiornamenti | click su **Manual Deploy** | un comando |

Per la beta va benissimo così; per il team serve una VM (o un piano a pagamento,
~7 $/mese su Render).

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

## Quale provider email usare

L'app supporta **Resend** e un normale **SMTP**: non serve modificare codice,
solo variabili in `.env`.

| Provider | Gratis | Serve un dominio tuo? | Carta |
| --- | --- | --- | --- |
| **Gmail + password per le app** | 500 destinatari/giorno | **no** | no |
| **Brevo (SMTP)** | 300 email/giorno | no, ma un mittente su dominio gratuito può finire in spam | no |
| **Resend** | 3.000/mese, 100/giorno | **sì**, verificato con record DNS | no |

**Consiglio pratico:** parti con **Gmail** (zero configurazione, arriva davvero a
colleghi su Gmail, Outlook, Libero, Tiscali), e passa a **Resend** quando avrai un
dominio tuo: è l'unico dei tre che garantisce buona consegna senza finire in spam.

### Gmail (5 minuti)

1. Sull'account Google: **Sicurezza → Verifica in due passaggi** attiva.
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
```

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
del tuo account.

In tutti i casi, dopo aver salvato il `.env`:

```bash
sudo docker compose -f deploy/docker-compose.yml up -d
```

e dal pannello **Email del coordinatore** usa **Invia email di prova** per
verificare che il provider risponda.

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
