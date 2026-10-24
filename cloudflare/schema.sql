-- Schema D1 dell'app: le stesse entità di data/db.json, in tabelle.
-- Le date sono stringhe ISO (YYYY-MM-DD), gli orari HH:MM.
--
--   npx wrangler d1 execute ferie-db --remote --file=cloudflare/schema.sql
--
-- Lo schema è idempotente: si può rieseguire senza perdere dati.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  color TEXT,
  birthday TEXT,
  avatar TEXT,
  created_at TEXT,
  seen_at TEXT,
  demo_pin TEXT
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  availability TEXT,
  slot TEXT,
  time_from TEXT,
  time_to TEXT,
  dates TEXT NOT NULL,              -- JSON array di giorni ISO
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  reminded_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_user ON requests(user_id);
CREATE INDEX IF NOT EXISTS idx_requests_status ON requests(status);

-- Piccoli valori globali: giorno del riepilogo, settimana già inviata, ecc.
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Registro delle email: il corpo resta qui, così si può rileggere e reinviare.
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  provider TEXT,
  error TEXT,
  created_at TEXT,
  reply_to TEXT,
  html TEXT,
  text_body TEXT,
  attachments TEXT                 -- JSON [{filename, content(base64)}]
);

CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);

-- Foto profilo: piccole (max 70 KB), una riga per file.
CREATE TABLE IF NOT EXISTS avatars (
  name TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  body BLOB NOT NULL,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  p256dh TEXT,
  auth TEXT,
  device TEXT,
  created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);

-- Log leggibile dall'amministratore nella Diagnostica (Workers non tiene
-- memoria tra le richieste: le ultime righe vivono in D1).
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  clock TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL
);

-- Tentativi di accesso falliti, per frenare i PIN provati a tappeto.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  reset_at INTEGER NOT NULL
);
