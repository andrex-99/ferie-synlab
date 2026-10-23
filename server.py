#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ferie — Synlab Manifattura Firenze
=====================================
Server locale senza dipendenze esterne (solo Python 3.8+).

  python3 server.py                      avvia l'app su http://localhost:8080
  python3 server.py adduser ...          aggiunge un utente
  python3 server.py listusers            elenca gli utenti
  python3 server.py setpin ...           cambia il PIN di un utente
  python3 server.py removeuser ...       rimuove un utente

Configurazione tramite variabili d'ambiente o file .env (vedi README.md).
"""

import argparse
import base64
import binascii
import collections
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import smtplib
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage
from email.utils import formataddr
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

import webpush

ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"

AGENDA = {
    "giorni": ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"],
    "mesi": ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
             "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
}
ROLE_EMPLOYEE = "dipendente"
ROLE_FREELANCE = "professionista"
ROLE_COORD = "coordinatore"
ROLE_ADMIN = "admin"
ROLES = (ROLE_EMPLOYEE, ROLE_FREELANCE, ROLE_COORD, ROLE_ADMIN)
COLORS = [
    "#2f7d63", "#3b6fd4", "#b56a2a", "#7a59c4", "#b0466b", "#2b8a9c",
    "#8a7a20", "#5c6b76", "#a4483f", "#3f7fa8", "#6b8f2a", "#8f5f8f",
]

TYPE_LABELS = {"ferie": "Ferie", "permesso": "Permesso", "disponibilita": "Disponibilità"}
AVAIL_LABELS = {"non_disponibile": "Non disponibile", "disponibile": "Disponibile"}
SLOT_CUSTOM = "orario"
SLOT_LABELS = {"giornata": "Giornata intera", "mattina": "Mattina", "pomeriggio": "Pomeriggio",
               SLOT_CUSTOM: "Orario personalizzato"}


def normalize_time(value):
    """Accetta 9:05 o 09:05 e restituisce sempre HH:MM."""
    match = re.match(r"^(\d{1,2}):([0-5]\d)$", str(value or "").strip())
    if not match:
        return None
    hour = int(match.group(1))
    if hour > 23:
        return None
    return "%02d:%s" % (hour, match.group(2))


def slot_display(req):
    """Etichetta della fascia: per l'orario personalizzato mostra Dalle–Alle."""
    slot = req.get("slot")
    if slot == SLOT_CUSTOM:
        start = normalize_time(req.get("time_from"))
        end = normalize_time(req.get("time_to"))
        if start and end:
            return "%s–%s" % (start, end)
    return SLOT_LABELS.get(slot or "", "")


def slot_detail(req):
    """Fascia da mostrare accanto al periodo, quando non è la giornata intera.

    Vale per i permessi e per la disponibilità: un professionista può essere
    disponibile solo dalle 8 alle 13, e la fascia oraria deve comparire ovunque
    (email, calendario, pagina di conferma).
    """
    if req.get("type") not in ("permesso", "disponibilita"):
        return ""
    if not req.get("slot") or req.get("slot") == "giornata":
        return ""
    return slot_display(req)


# --------------------------------------------------------------------------
# Configurazione
# --------------------------------------------------------------------------

def _load_dotenv():
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    try:
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value
    except OSError:
        pass


_load_dotenv()

DATA_DIR = Path(os.environ.get("DATA_DIR") or (ROOT / "data")).expanduser().resolve()
DB_PATH = DATA_DIR / "db.json"
SECRET_PATH = DATA_DIR / "secret.key"
OUTBOX_DIR = DATA_DIR / "outbox"
AVATAR_DIR = DATA_DIR / "avatars"
VAPID_PATH = DATA_DIR / "vapid.json"

# Le foto sono già ridimensionate dal browser: il limite protegge il database
# e il server da file enormi o contraffatti.
AVATAR_MAX_BYTES = 70_000
AVATAR_NAME_RE = re.compile(r"^[a-z0-9_]+-[0-9a-f]{10}\.(jpg|png|webp)$")
AVATAR_DATA_RE = re.compile(r"^data:(image/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$")
AVATAR_MIME = {".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}

PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "127.0.0.1")
ORG_NAME = os.environ.get("ORG_NAME", "Synlab Manifattura Firenze")
ORG_SHORT = os.environ.get("ORG_SHORT", "Synlab")
ORG_SITE = os.environ.get("ORG_SITE", "Manifattura Firenze")
ORG_BRAND = os.environ.get("ORG_BRAND", "SYNLAB")
APP_BASE_URL = os.environ.get("APP_BASE_URL", "").rstrip("/")
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "").strip()
MAIL_FROM = os.environ.get("MAIL_FROM", "").strip()
MAIL_FROM_NAME = os.environ.get("MAIL_FROM_NAME", "Synlab Manifattura Firenze").strip()
MAIL_REPLY_TO = os.environ.get("MAIL_REPLY_TO", "").strip()
SMTP_HOST = os.environ.get("SMTP_HOST", "").strip()
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "").strip()
SMTP_PASS = os.environ.get("SMTP_PASS", "")
SMTP_STARTTLS = os.environ.get("SMTP_STARTTLS", "1") not in ("0", "false", "no")
COORDINATOR_EMAILS = [e.strip().lower() for e in os.environ.get("COORDINATOR_EMAILS", "").split(",") if e.strip()]
# Account che vedono la diagnostica (log, email, errori) senza poteri da
# coordinatore: utenti con ruolo admin oppure email elencate qui.
ADMIN_EMAILS = [e.strip().lower() for e in os.environ.get("ADMIN_EMAILS", "").split(",") if e.strip()]
MAX_SESSION_DAYS = 30
REMINDER_HOURS = int(os.environ.get("REMINDER_HOURS", "24") or 0)

# Riepilogo settimanale delle assenze ai coordinatori.
# 0 = lunedì, 1 = martedì, 2 = mercoledì, 3 = giovedì, ... 6 = domenica.
WEEKLY_DIGEST = os.environ.get("WEEKLY_DIGEST", "1") not in ("0", "false", "no")
WEEKLY_DIGEST_WEEKDAY = int(os.environ.get("WEEKLY_DIGEST_WEEKDAY", "3") or 0)
WEEKLY_DIGEST_HOUR = int(os.environ.get("WEEKLY_DIGEST_HOUR", "8") or 0)
WEEKLY_DIGEST_WEEKDAY = min(max(WEEKLY_DIGEST_WEEKDAY, 0), 6)
WEEKLY_DIGEST_HOUR = min(max(WEEKLY_DIGEST_HOUR, 0), 23)

# Fuso orario usato per decidere quando parte il riepilogo: il server in
# container gira in UTC, il team ragiona in ora italiana.
ORG_TZ = os.environ.get("TZ", "Europe/Rome").strip() or "Europe/Rome"

# Contatto richiesto da VAPID nelle notifiche push (mailto: o https:).
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "").strip()


def email_configured():
    return bool(RESEND_API_KEY and MAIL_FROM) or bool(SMTP_HOST and MAIL_FROM)


def local_now():
    """Ora locale dell'organizzazione: TZ se disponibile, altrimenti ora di sistema."""
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(ORG_TZ))
    except Exception:
        return datetime.now()


# --------------------------------------------------------------------------
# Database JSON con scrittura atomica
# --------------------------------------------------------------------------

DB_LOCK = threading.RLock()


def _atomic_write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(text)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)


def _read_secret():
    if not SECRET_PATH.exists():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write(SECRET_PATH, secrets.token_hex(48))
        try:
            os.chmod(SECRET_PATH, 0o600)
        except OSError:
            pass
    return SECRET_PATH.read_text(encoding="utf-8").strip()


SECRET = _read_secret()


def hash_pin(pin, salt=None):
    """Restituisce (salt, digest) usando scrypt se disponibile, altrimenti PBKDF2."""
    salt = salt or secrets.token_hex(16)
    raw = pin.encode("utf-8")
    if hasattr(hashlib, "scrypt"):
        try:
            digest = hashlib.scrypt(raw, salt=salt.encode("utf-8"), n=2 ** 14, r=8, p=1, dklen=32)
            return salt, "scrypt$" + base64.b64encode(digest).decode("ascii")
        except (ValueError, AttributeError):
            pass
    digest = hashlib.pbkdf2_hmac("sha256", raw, salt.encode("utf-8"), 200_000, dklen=32)
    return salt, "pbkdf2$" + base64.b64encode(digest).decode("ascii")


def verify_pin(pin, salt, expected):
    try:
        algorithm, _, encoded = (expected or "").partition("$")
        raw = pin.encode("utf-8")
        if algorithm == "scrypt":
            digest = hashlib.scrypt(raw, salt=salt.encode("utf-8"), n=2 ** 14, r=8, p=1, dklen=32)
            value = base64.b64encode(digest).decode("ascii")
        elif algorithm == "pbkdf2":
            digest = hashlib.pbkdf2_hmac("sha256", raw, salt.encode("utf-8"), 200_000, dklen=32)
            value = base64.b64encode(digest).decode("ascii")
        else:
            return False
        return hmac.compare_digest(value, encoded)
    except (ValueError, TypeError, AttributeError):
        return False


def new_id(prefix=""):
    return prefix + secrets.token_urlsafe(9).replace("-", "").replace("_", "")[:12].lower()


def blank_db():
    return {"users": [], "requests": [], "outbox": [], "push": [], "seeded": True,
            "meta": {}, "created_at": now_iso()}


def load_db():
    with DB_LOCK:
        if not DB_PATH.exists():
            db = blank_db()
            seed_demo_users(db)
            save_db(db)
            return db
        try:
            with open(DB_PATH, "r", encoding="utf-8") as handle:
                db = json.load(handle)
        except (OSError, ValueError) as exc:
            raise RuntimeError("Impossibile leggere %s: %s" % (DB_PATH, exc))
        db.setdefault("users", [])
        db.setdefault("requests", [])
        db.setdefault("outbox", [])
        db.setdefault("push", [])
        db.setdefault("seeded", False)
        db.setdefault("meta", {})
        return db


def save_db(db):
    with DB_LOCK:
        _atomic_write(DB_PATH, json.dumps(db, ensure_ascii=False, indent=2))


def seed_demo_users(db):
    demo = [
        ("Giulia Rossi", "giulia@studio.it", ROLE_EMPLOYEE, "1111"),
        ("Luca Ferrari", "luca@studio.it", ROLE_EMPLOYEE, "2222"),
        ("Sara Conti", "sara@studio.it", ROLE_FREELANCE, "3333"),
        ("Marco Bianchi", "coordinatore@studio.it", ROLE_COORD, "1234"),
    ]
    for index, (name, email, role, pin) in enumerate(demo):
        salt, digest = hash_pin(pin)
        db["users"].append({
            "id": new_id("u_"),
            "name": name,
            "email": email,
            "role": role,
            "salt": salt,
            "pin_hash": digest,
            "color": COLORS[index % len(COLORS)],
            "created_at": now_iso(),
            "seen_at": None,
            "demo_pin": pin,
        })


def now_iso():
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def parse_iso(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


# --------------------------------------------------------------------------
# Utilità
# --------------------------------------------------------------------------

def clean_text(value, limit=500):
    if not isinstance(value, str):
        return ""
    return value.replace("\r\n", "\n").strip()[:limit]


def valid_email(value):
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", value or ""))


def is_coordinator(user):
    return bool(user) and (user.get("role") == ROLE_COORD or user.get("email", "").lower() in COORDINATOR_EMAILS)


def is_admin(user):
    """Amministratore di diagnostica: legge log ed email, non approva nulla."""
    return bool(user) and (user.get("role") == ROLE_ADMIN
                           or user.get("email", "").lower() in ADMIN_EMAILS)


def allowed_types(user):
    """Tipi di richiesta ammessi per ruolo.

    I professionisti comunicano solo la disponibilità, i dipendenti chiedono
    ferie e permessi. Il coordinatore chiede ferie e permessi come i dipendenti:
    la disponibilità riguarda solo chi lavora su turni o a chiamata.
    L'amministratore è un account tecnico: vede la diagnostica e non invia
    richieste.
    """
    role = (user or {}).get("role")
    if role == ROLE_ADMIN:
        return []
    if role == ROLE_FREELANCE:
        return ["disponibilita"]
    return ["ferie", "permesso"]


def avatar_url(user):
    name = user.get("avatar")
    return "/avatar/" + name if name else None


def public_user(user):
    return {
        "id": user["id"],
        "name": user["name"],
        "email": user["email"],
        "role": user["role"],
        "color": user.get("color") or COLORS[0],
        "birthday": user.get("birthday"),
        "admin": is_admin(user),
        "avatar": avatar_url(user),
        "initials": "".join(part[0] for part in user["name"].split()[:2]).upper(),
    }


def pick_color(db, exclude_id=None):
    """Sceglie il colore meno usato, così le persone restano distinguibili."""
    counts = {color: 0 for color in COLORS}
    for user in db.get("users", []):
        if user.get("id") == exclude_id:
            continue
        color = user.get("color")
        if color in counts:
            counts[color] += 1
    return min(COLORS, key=lambda color: counts[color])


def avatar_path(name):
    """Percorso sicuro di un avatar già salvato (niente traversal)."""
    if not name or not AVATAR_NAME_RE.match(name):
        return None
    target = (AVATAR_DIR / name).resolve()
    try:
        target.relative_to(AVATAR_DIR.resolve())
    except ValueError:
        return None
    return target


def decode_avatar(value):
    """Valida un data URL immagine e restituisce (estensione, byte)."""
    match = AVATAR_DATA_RE.match(value or "")
    if not match:
        raise ApiError(400, "L'immagine non è valida: usa JPG, PNG o WebP")
    try:
        blob = base64.b64decode(match.group(3), validate=True)
    except (ValueError, binascii.Error):
        raise ApiError(400, "L'immagine non è valida")
    if not blob:
        raise ApiError(400, "L'immagine è vuota")
    if len(blob) > AVATAR_MAX_BYTES:
        raise ApiError(400, "L'immagine è troppo grande: massimo 70 KB")
    kind = match.group(2)
    signatures = {
        "jpeg": blob[:3] == b"\xff\xd8\xff",
        "png": blob[:8] == b"\x89PNG\r\n\x1a\n",
        "webp": blob[:4] == b"RIFF" and blob[8:12] == b"WEBP",
    }
    if not signatures.get(kind):
        raise ApiError(400, "Il contenuto del file non è un'immagine valida")
    return ".jpg" if kind == "jpeg" else "." + kind, blob


def prepare_avatar(user, value):
    """Restituisce (nuovo nome file, vecchio nome file) senza cancellare nulla.

    `value` assente (None) lascia l'avatar com'è; stringa vuota lo rimuove.
    """
    if value is None:
        return user.get("avatar"), None
    previous = user.get("avatar")
    if value == "":
        return None, previous
    extension, blob = decode_avatar(value)
    AVATAR_DIR.mkdir(parents=True, exist_ok=True)
    name = "%s-%s%s" % (user["id"], secrets.token_hex(5), extension)
    temporary = AVATAR_DIR / (name + ".part")
    temporary.write_bytes(blob)
    os.replace(temporary, AVATAR_DIR / name)
    return name, previous


def remove_avatar(name):
    target = avatar_path(name)
    if not target:
        return
    try:
        target.unlink()
    except OSError:
        pass


def iso_day(value):
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def parse_day(value):
    try:
        return date.fromisoformat(str(value)[:10])
    except (ValueError, TypeError):
        return None


def fmt_day(value):
    return "%s %d %s %d" % (AGENDA["giorni"][value.weekday()], value.day,
                            AGENDA["mesi"][value.month - 1], value.year)


def normalize_birthday(value):
    """Compleanno come MM-DD: l'anno non serve e non viene conservato."""
    match = re.match(r"^(\d{1,2})-(\d{1,2})$", str(value or "").strip())
    if not match:
        return None
    month, day = int(match.group(1)), int(match.group(2))
    try:
        date(2000, month, day)  # il 2000 è bisestile: il 29 febbraio è valido
    except ValueError:
        return None
    return "%02d-%02d" % (month, day)


def birthday_on(year, birthday):
    """Il compleanno in un dato anno; il 29 febbraio cade il 28 negli anni non bisestili."""
    month, day = (int(part) for part in birthday.split("-"))
    try:
        return date(year, month, day)
    except ValueError:
        return date(year, 2, 28)


def birthdays_in_range(db, start, end):
    """Compleanni (solo giorno e mese) che cadono nel periodo mostrato."""
    found = []
    for user in db.get("users", []):
        birthday = normalize_birthday(user.get("birthday"))
        if not birthday:
            continue
        for year in {start.year, end.year}:
            day = birthday_on(year, birthday)
            if start <= day <= end:
                found.append({"date": iso_day(day), "user_id": user["id"],
                              "user_name": user["name"],
                              "user_color": user.get("color") or COLORS[0],
                              "day_month": birthday})
    found.sort(key=lambda item: (item["date"], item["user_name"].casefold()))
    return found


def fmt_range(start, end):
    if start == end:
        return fmt_day(start)
    if start.year == end.year and start.month == end.month:
        return "%s %d–%d %s %d" % (AGENDA["giorni"][start.weekday()], start.day, end.day,
                                   AGENDA["mesi"][start.month - 1], start.year)
    return "%s – %s" % (fmt_day(start), fmt_day(end))


def group_day_runs(days):
    """Raggruppa giorni ordinati in intervalli contigui [(inizio, fine), ...]."""
    runs = []
    for day in sorted(set(d for d in days if d)):
        if runs and day == runs[-1][1] + timedelta(days=1):
            runs[-1][1] = day
        else:
            runs.append([day, day])
    return [(start, end) for start, end in runs]


def fmt_dates(days):
    """Periodo leggibile anche con giorni non consecutivi: “3–5 nov e 10 nov”."""
    runs = group_day_runs(days)
    if not runs:
        return ""
    if len(runs) == 1:
        return fmt_range(runs[0][0], runs[0][1])
    labels = [fmt_range(start, end) for start, end in runs]
    return ", ".join(labels[:-1]) + " e " + labels[-1]


def signed_token(rid, days=30):
    expires = int(time.time()) + days * 86400
    payload = "%s.%s" % (rid, expires)
    sig = hmac.new(SECRET.encode(), ("decide|" + payload).encode(), hashlib.sha256).hexdigest()[:40]
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=") + "." + sig


def verify_token(rid, token):
    if not token or "." not in token:
        return False
    try:
        encoded, sig = token.rsplit(".", 1)
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = base64.urlsafe_b64decode(padded.encode()).decode()
        token_rid, expires = payload.split(".", 1)
        if token_rid != rid:
            return False
        if int(expires) < int(time.time()):
            return False
        expected = hmac.new(SECRET.encode(), ("decide|" + payload).encode(),
                            hashlib.sha256).hexdigest()[:40]
        return hmac.compare_digest(sig, expected)
    except (ValueError, TypeError):
        return False


def ics_feed_token():
    return hmac.new(SECRET.encode(), b"ics-feed", hashlib.sha256).hexdigest()[:32]


def session_signature(uid, expires, user):
    tag = hashlib.sha256(("%s" % user.get("pin_hash", "")).encode()).hexdigest()[:12]
    message = "sess|%s|%s|%s" % (uid, expires, tag)
    return hmac.new(SECRET.encode(), message.encode(), hashlib.sha256).hexdigest()[:32]


def make_session(user):
    expires = int(time.time()) + MAX_SESSION_DAYS * 86400
    return "%s.%s.%s" % (user["id"], expires, session_signature(user["id"], expires, user))


def read_session(db, cookie_value):
    if not cookie_value:
        return None
    parts = cookie_value.split(".")
    if len(parts) != 3:
        return None
    uid, expires, sig = parts
    try:
        if int(expires) < time.time():
            return None
    except ValueError:
        return None
    user = find_user(db, uid=uid)
    if not user:
        return None
    if not hmac.compare_digest(sig, session_signature(uid, expires, user)):
        return None
    return user


def find_user(db, uid=None, email=None):
    for user in db["users"]:
        if uid and user["id"] == uid:
            return user
        if email and user["email"].lower() == email.lower():
            return user
    return None


def coordinators(db):
    result = [u for u in db["users"] if is_coordinator(u)]
    if not result and COORDINATOR_EMAILS:
        return []
    return result


def request_dates(req):
    return [parse_day(d) for d in req.get("dates", []) if parse_day(d)]


def serialize_request(db, req):
    user = find_user(db, uid=req["user_id"]) or {}
    decider = find_user(db, uid=req.get("decided_by")) if req.get("decided_by") else None
    days = sorted(parse_day(d) for d in req.get("dates", []) if parse_day(d))
    start = days[0] if days else None
    end = days[-1] if days else None
    return {
        "id": req["id"],
        "user_id": req["user_id"],
        "user_name": user.get("name", "Utente rimosso"),
        "user_color": user.get("color", COLORS[0]),
        "user_avatar": avatar_url(user),
        "type": req.get("type", "ferie"),
        "availability": req.get("availability"),
        "slot": req.get("slot"),
        "slot_label": slot_display(req),
        "time_from": req.get("time_from"),
        "time_to": req.get("time_to"),
        "dates": req.get("dates", []),
        "start": iso_day(start) if start else None,
        "end": iso_day(end) if end else None,
        "days": len(days),
        "range_label": fmt_dates(days) if days else "",
        "note": req.get("note", ""),
        "status": req.get("status", "pending"),
        "created_at": req.get("created_at"),
        "decided_at": req.get("decided_at"),
        "decided_by_name": decider.get("name") if decider else None,
        "decision_note": req.get("decision_note", ""),
        "reopenable": req.get("status") in ("approved", "rejected"),
        "label": TYPE_LABELS.get(req.get("type"), "Richiesta"),
        "availability_label": AVAIL_LABELS.get(req.get("availability", "")),
    }


def serialize_events(db, req):
    """Eventi calendario: un evento per richiesta, il frontend lo espande sui giorni."""
    return [serialize_request(db, r) for r in req]


def overlaps_any(req, dates):
    days = set(req.get("dates", []))
    return bool(days.intersection(dates))


def request_ics(req, user, stamp=None):
    days = sorted(parse_day(d) for d in req.get("dates", []) if parse_day(d))
    if not days:
        return ""
    runs = group_day_runs(days)
    title = TYPE_LABELS.get(req["type"], "Richiesta")
    if req["type"] == "disponibilita":
        title = "Disponibilità: " + AVAIL_LABELS.get(req.get("availability"), "")
    if slot_detail(req):
        title += " · " + slot_detail(req)
    summary = "%s — %s" % (title, user.get("name", ""))
    description = (req.get("note") or "").replace("\n", "\\n")
    stamp = stamp or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Ferie e Disponibilita//IT",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    # Un evento per ogni periodo continuo: due giorni separati non diventano
    # un'assenza di una settimana nel calendario di chi riceve l'invito.
    for index, (start, end) in enumerate(runs):
        uid = req["id"] if len(runs) == 1 else "%s-%d" % (req["id"], index + 1)
        lines += [
            "BEGIN:VEVENT",
            "UID:%s@ferie-disponibilita" % uid,
            "DTSTAMP:%s" % stamp,
            "DTSTART;VALUE=DATE:%s" % start.strftime("%Y%m%d"),
            "DTEND;VALUE=DATE:%s" % (end + timedelta(days=1)).strftime("%Y%m%d"),
            "SUMMARY:%s" % ics_escape(summary),
            "DESCRIPTION:%s" % description,
            "STATUS:CONFIRMED",
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return fold_ics("\r\n".join(lines) + "\r\n")


def ics_escape(value):
    return str(value).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def fold_ics(text):
    """Spezza le righe a 75 ottetti senza rompere i caratteri UTF-8."""
    out = []
    for line in text.split("\r\n"):
        limit = 73
        chunk, size = "", 0
        first = True
        for char in line:
            width = len(char.encode("utf-8"))
            if size + width > limit:
                out.append(("" if first else " ") + chunk)
                first = False
                chunk, size, limit = "", 0, 72
            chunk += char
            size += width
        out.append(("" if first else " ") + chunk)
    return "\r\n".join(out)


# --------------------------------------------------------------------------
# Email
# --------------------------------------------------------------------------

def email_shell(title, eyebrow, body_html, footer="", preheader="", accent="#005f96"):
    """Layout email responsive, solo CSS inline (funziona su Gmail/Outlook/Apple Mail)."""
    mark = "".join(part[0] for part in ORG_NAME.split()[:3]).upper() or "F"
    brand_line = ("%s · Ferie e disponibilità" % ORG_BRAND) if ORG_BRAND else "Ferie e disponibilità"
    return """<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>%(title)s</title>
</head>
<body style="margin:0;padding:0;background:#eef3f7;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">%(preheader)s</div>
<table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="background:#eef3f7;">
<tr><td align="center" style="padding:30px 12px 34px;">
  <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

    <tr><td style="padding:0 4px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="40" height="40" style="width:40px;height:40px;border-radius:12px;background:#005f96;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;text-align:center;vertical-align:middle;letter-spacing:.5px;">%(mark)s</td>
        <td style="padding-left:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div style="font-size:15px;font-weight:700;color:#1b2321;letter-spacing:-.01em;">%(org)s</div>
          <div style="font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#7c8178;padding-top:2px;">%(brand_line)s</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="background:#ffffff;border:1px solid #dfe8ef;border-radius:20px;overflow:hidden;box-shadow:0 18px 40px -32px rgba(27,35,33,.45);">
      <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="height:5px;background:%(accent)s;font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:30px 34px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#8a8172;">%(eyebrow)s</div>
          <h1 style="margin:9px 0 0;font-size:25px;line-height:1.22;letter-spacing:-.025em;font-weight:700;color:#1b2321;">%(title)s</h1>
        </td></tr>
        <tr><td style="padding:18px 34px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f4a45;">
          %(body)s
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:18px 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.6;color:#7c8178;text-align:center;">
      %(footer)s
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>""" % {
        "title": html.escape(title), "eyebrow": html.escape(eyebrow), "body": body_html,
        "footer": footer, "preheader": html.escape(preheader), "accent": accent,
        "mark": html.escape(mark), "org": html.escape(ORG_NAME),
        "brand_line": html.escape(brand_line),
    }


def button(url, label, color="#005f96"):
    return ('<a href="%s" style="display:inline-block;background:%s;color:#ffffff;text-decoration:none;'
            'font-weight:600;font-size:15px;line-height:1;padding:14px 24px;border-radius:999px;'
            'margin:4px 8px 4px 0;">%s</a>'
            % (html.escape(url, quote=True), color, html.escape(label)))


def ghost_link(url, label):
    return ('<a href="%s" style="color:#3f4a45;text-decoration:none;font-weight:600;font-size:14px;'
            'border-bottom:1px solid #cfd8ce;padding-bottom:2px;">%s</a>'
            % (html.escape(url, quote=True), html.escape(label)))


def details_table(req, requester):
    rows = [("Richiedente", requester.get("name", ""))]
    role = requester.get("role", "")
    if role:
        rows.append(("Ruolo", role.capitalize()))
    type_label = TYPE_LABELS.get(req["type"], req["type"])
    if slot_detail(req):
        type_label += " · " + slot_detail(req)
    rows.append(("Tipo", type_label))
    if req["type"] == "disponibilita":
        rows.append(("Disponibilità", AVAIL_LABELS.get(req.get("availability"), "")))
    rows.append(("Periodo", fmt_dates([parse_day(d) for d in req["dates"]])))
    rows.append(("Giorni", str(len(req["dates"]))))
    if req.get("note"):
        rows.append(("Nota", req["note"]))
    cells = []
    for index, (label, value) in enumerate(rows):
        border = "border-bottom:1px solid #edf0ea;" if index < len(rows) - 1 else ""
        cells.append(
            '<tr><td style="padding:11px 0;%s color:#7c8178;font-size:13px;width:38%%;vertical-align:top;">%s</td>'
            '<td style="padding:11px 0;%s color:#1b2321;font-size:14px;font-weight:600;vertical-align:top;">%s</td></tr>'
            % (border, html.escape(label), border,
               html.escape(str(value)).replace("\n", "<br>")))
    return ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
            'style="background:#f5f9fc;border-radius:14px;padding:0;margin:0 0 22px;">'
            '<tr><td style="padding:4px 18px;"><table role="presentation" width="100%" cellpadding="0" '
            'cellspacing="0" border="0">' + "".join(cells) + "</table></td></tr></table>")


def note_block(note):
    if not note:
        return ""
    return ('<div style="border-left:3px solid #c8d4c9;padding:2px 0 2px 14px;margin:0 0 20px;'
            'color:#4b554e;font-size:14px;line-height:1.6;font-style:italic;">%s</div>'
            % html.escape(note).replace("\n", "<br>"))


def send_mail(to, subject, html_body, text_body=None, attachments=None,
              reply_to=None, idempotency_key=None):
    """Invia via Resend o SMTP. Senza credenziali salva nella posta simulata."""
    entry = {
        "id": new_id("m_"),
        "to": to,
        "subject": subject,
        "html": html_body,
        "text": text_body or "",
        "created_at": now_iso(),
        "error": None,
        "provider": None,
        "reply_to": reply_to or "",
        "attachments": [{"filename": name, "content": content}
                        for name, content in (attachments or [])],
    }
    with DB_LOCK:
        db = load_db()
        db["outbox"].insert(0, entry)
        del db["outbox"][100:]
        save_db(db)
    provider = None
    try:
        if RESEND_API_KEY and MAIL_FROM:
            payload = {
                "from": formataddr((MAIL_FROM_NAME, MAIL_FROM)),
                "to": [to],
                "subject": subject,
                "html": html_body,
            }
            if text_body:
                payload["text"] = text_body
            if reply_to:
                payload["reply_to"] = reply_to
            elif MAIL_REPLY_TO:
                payload["reply_to"] = MAIL_REPLY_TO
            if attachments:
                payload["attachments"] = [{"filename": name, "content": content} for name, content in attachments]
            headers = {"Authorization": "Bearer " + RESEND_API_KEY,
                       "Content-Type": "application/json"}
            if idempotency_key:
                headers["Idempotency-Key"] = idempotency_key[:256]
            request = urllib.request.Request(
                "https://api.resend.com/emails",
                data=json.dumps(payload).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=20) as response:
                response.read()
            provider = "resend"
        elif SMTP_HOST and MAIL_FROM:
            message = EmailMessage()
            message["From"] = formataddr((MAIL_FROM_NAME, MAIL_FROM))
            message["To"] = to
            message["Subject"] = subject
            if reply_to:
                message["Reply-To"] = reply_to
            elif MAIL_REPLY_TO:
                message["Reply-To"] = MAIL_REPLY_TO
            message.set_content(text_body or "Per visualizzare il messaggio usa un client HTML.")
            message.add_alternative(html_body, subtype="html")
            for name, content in attachments or []:
                raw = base64.b64decode(content)
                message.add_attachment(raw, maintype="text", subtype="calendar", filename=name)
            if SMTP_STARTTLS:
                server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=20)
                server.starttls()
            else:
                server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=20)
            try:
                if SMTP_USER:
                    server.login(SMTP_USER, SMTP_PASS)
                server.send_message(message)
            finally:
                try:
                    server.quit()
                except Exception:
                    pass
            provider = "smtp"
        else:
            provider = "demo"
    except Exception as exc:  # l'errore non deve far fallire la richiesta
        entry["error"] = "%s: %s" % (exc.__class__.__name__, exc)
        log("Invio email fallito per %s: %s" % (to, entry["error"]), error=True)

    entry["provider"] = provider
    with DB_LOCK:
        db = load_db()
        for stored in db["outbox"]:
            if stored["id"] == entry["id"]:
                stored["provider"] = provider
                stored["error"] = entry["error"]
                break
        save_db(db)
    try:
        OUTBOX_DIR.mkdir(parents=True, exist_ok=True)
        _atomic_write(OUTBOX_DIR / ("%s.html" % entry["id"]), html_body)
    except OSError:
        pass
    return entry


def email_footer(req=None):
    bits = ["Email automatica di %s." % html.escape(ORG_NAME)]
    if req:
        bits.append("Richiesta <span style='font-family:ui-monospace,Menlo,monospace;'>%s</span>" % html.escape(req["id"]))
    return " · ".join(bits)


def coordinator_email(requester, req, decide_url, app_url):
    period = fmt_dates([parse_day(d) for d in req["dates"]])
    type_label = TYPE_LABELS.get(req["type"], "Richiesta")
    if slot_detail(req):
        type_label = "%s (%s)" % (type_label, slot_detail(req).lower())
    is_avail = req["type"] == "disponibilita"
    if is_avail:
        availability = AVAIL_LABELS.get(req.get("availability"), "")
        subject = "Disponibilità %s: %s · %s" % (availability.lower(), requester["name"], period)
        intro = ("%s ha comunicato la sua disponibilità: <strong>%s</strong> nei giorni indicati."
                 % (html.escape(requester["name"]), html.escape(availability.lower())))
        prompt_title = "Prendi visione"
        prompt_body = ("Apri la comunicazione per confermare di averla letta. La persona riceverà una "
                       "conferma di lettura, non un'approvazione.")
        approve_label = "Ho letto"
        reject_label = "Segnala da rivedere"
    else:
        subject = "Da approvare: %s di %s · %s" % (type_label.lower(), requester["name"], period)
        intro = "È arrivata una nuova richiesta da approvare."
        prompt_title = "Serve una tua decisione"
        prompt_body = ("Apri la richiesta per approvarla o rifiutarla. Il richiedente riceverà subito "
                       "un'email con l'esito.")
        approve_label = "Approva"
        reject_label = "Rifiuta"
    body = ('<p style="margin:0 0 20px;">' + intro + '</p>'
            + details_table(req, requester)
            + note_block(req.get("note")))
    body += ('<p style="margin:0 0 8px;font-weight:600;color:#1b2321;">' + prompt_title + '</p>'
             '<p style="margin:0 0 20px;color:#5a655e;font-size:14px;">' + prompt_body + '</p>')
    approve_url = decide_url + "&action=approve"
    reject_url = decide_url + "&action=reject"
    body += '<p style="margin:0 0 10px;font-weight:600;color:#1b2321;">Decidi ora</p>'
    body += ('<p style="margin:0 0 4px;">%s %s</p>'
             % (button(approve_url, approve_label, "#2f7d63"),
                button(reject_url, reject_label, "#a4483f")))
    body += ('<p style="margin:0 0 18px;font-size:12.5px;color:#8a8172;">Si apre la pagina di conferma: '
             'nessuna decisione viene registrata senza un ultimo clic.</p>')
    body += '<p style="margin:18px 0 0;">%s</p>' % ghost_link(app_url, "Apri il coordinamento")
    text = (("Nuova disponibilità di %s\n%s\n%s\nGiorni: %d\nNota: %s\n\n" % (requester["name"], type_label, period,
                                                                         len(req["dates"]), req.get("note") or "-"))
            if is_avail else
            ("Nuova richiesta di %s\n%s\n%s\nGiorni: %d\nNota: %s\n\n" % (requester["name"], type_label, period,
                                                                      len(req["dates"]), req.get("note") or "-")))
    text += ("%s: %s\n%s: %s\nApri e decidi: %s\nApp: %s\n"
             % (approve_label, approve_url, reject_label, reject_url, decide_url, app_url))
    page = email_shell("Richiesta da approvare", "Ferie & disponibilità", body,
                       email_footer(req),
                       preheader="%s di %s, %s" % (type_label, requester["name"], period),
                       accent="#b4842a")
    return subject, page, text


def availability_outcome_email(requester, req, coordinator_name, decision_note, app_url):
    """Risposta alla disponibilità: una conferma di lettura, non un'approvazione.

    La disponibilità non è una richiesta da concedere: il coordinatore conferma
    solo di averla vista (o segnala che va rivista) e la persona ne riceve atto.
    """
    read = req["status"] == "approved"
    period = fmt_dates([parse_day(d) for d in req["dates"]])
    availability = AVAIL_LABELS.get(req.get("availability"), "")
    who = html.escape(coordinator_name or "il coordinatore")
    if read:
        subject = "✓ Comunicazione letta · %s" % period
        headline = "Il coordinatore ha preso visione della tua comunicazione"
        tint, ink, icon = "#eaf2f8", "#075a8a", "✓"
        accent = "#005f96"
        explain = ("Hai comunicato <strong>%s</strong> e il coordinatore l'ha letta. "
                   "Non serve nessuna azione da parte tua." % html.escape(availability.lower()))
        preheader = "Comunicazione letta, %s" % period
    else:
        subject = "✕ Comunicazione da rivedere · %s" % period
        headline = "Il coordinatore ha letto la tua comunicazione e ti chiede di verificarla"
        tint, ink, icon = "#fbf2e0", "#8a6a1f", "!"
        accent = "#b4842a"
        explain = ("Hai comunicato <strong>%s</strong> e il coordinatore segnala che va rivista."
                   % html.escape(availability.lower()))
        preheader = "Comunicazione da rivedere, %s" % period
    body = ('<div style="background:%s;border-radius:14px;padding:16px 18px;margin:0 0 22px;">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            '<td width="34" height="34" style="width:34px;height:34px;border-radius:50%%;background:%s;color:#fff;'
            'font-size:17px;font-weight:700;text-align:center;vertical-align:middle;">%s</td>'
            '<td style="padding-left:12px;font-size:15px;line-height:1.4;color:%s;font-weight:700;">'
            '%s<br><span style="font-weight:500;font-size:13px;color:#5a655e;">da %s</span>'
            '</td></tr></table></div>'
            % (tint, ink, icon, ink, headline, who))
    body += details_table(req, requester)
    body += '<p style="margin:0 0 18px;color:#5a655e;font-size:14px;">%s</p>' % explain
    if decision_note:
        body += ('<p style="margin:0 0 6px;font-weight:600;color:#1b2321;">Nota del coordinatore</p>'
                 + note_block(decision_note))
    body += '<p style="margin:0 0 6px;">%s</p>' % button(app_url, "Apri il calendario", accent)
    text = ("Conferma di lettura: il coordinatore ha letto la tua comunicazione di disponibilità "
            "(%s, %s).\n%s\n%s\n"
            % (availability.lower(), period,
               ("Nota: " + decision_note) if decision_note else "", app_url))
    page = email_shell("Conferma di lettura", "Ferie & disponibilità", body,
                       email_footer(req), preheader=preheader, accent=accent)
    return subject, page, text


def outcome_email(requester, req, coordinator_name, decision_note, app_url):
    # La disponibilità non si approva: ha una risposta dedicata, senza esito.
    if req["type"] == "disponibilita":
        return availability_outcome_email(requester, req, coordinator_name, decision_note, app_url)
    approved = req["status"] == "approved"
    type_label = TYPE_LABELS.get(req["type"], "Richiesta")
    request_label = type_label + ((" · " + slot_detail(req)) if slot_detail(req) else "")
    period = fmt_dates([parse_day(d) for d in req["dates"]])
    outcome_word = "approvata" if approved else "rifiutata"
    subject = "%s %s · %s" % ("✓" if approved else "✕",
                              "Richiesta approvata" if approved else "Richiesta rifiutata", period)
    accent = "#2f7d63" if approved else "#a4483f"
    tint = "#e9f4ec" if approved else "#fbeceb"
    ink = "#1f6f57" if approved else "#a4483f"
    icon = "✓" if approved else "✕"
    body = ('<div style="background:%s;border-radius:14px;padding:16px 18px;margin:0 0 22px;">'
            '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
            '<td width="34" height="34" style="width:34px;height:34px;border-radius:50%%;background:%s;color:#fff;'
            'font-size:17px;font-weight:700;text-align:center;vertical-align:middle;">%s</td>'
            '<td style="padding-left:12px;font-size:15px;line-height:1.4;color:%s;font-weight:700;">'
            'La tua %s è stata %s<br><span style="font-weight:500;font-size:13px;color:#5a655e;">da %s</span>'
            '</td></tr></table></div>'
            % (tint, ink, icon, ink, "richiesta", outcome_word,
               html.escape(coordinator_name or "il coordinatore")))
    body += details_table(req, requester)
    if decision_note:
        body += ('<p style="margin:0 0 6px;font-weight:600;color:#1b2321;">Nota del coordinatore</p>'
                 + note_block(decision_note))
    if approved:
        body += ('<p style="margin:0 0 18px;color:#5a655e;font-size:14px;">I giorni sono ora visibili nel '
                 'calendario condiviso. In allegato trovi il file <strong>.ics</strong> per aggiungerli al tuo '
                 'calendario personale.</p>')
    body += '<p style="margin:0 0 6px;">%s</p>' % button(app_url, "Apri il calendario", accent)
    subject_what = "la tua richiesta di " + request_label.lower()
    text = ("%s (%s) è stata %s da %s.\n%s\n%s\n"
            % (subject_what.capitalize(), period, outcome_word,
               coordinator_name or "il coordinatore",
               ("Nota: " + decision_note) if decision_note else "", app_url))
    page = email_shell("Esito della richiesta", "Ferie & disponibilità", body,
                       email_footer(req),
                       preheader="%s %s" % (subject_what.capitalize(), outcome_word),
                       accent=accent)
    return subject, page, text


def reminder_email(requester, req, decide_url, app_url, hours):
    period = fmt_dates([parse_day(d) for d in req["dates"]])
    type_label = TYPE_LABELS.get(req["type"], "Richiesta")
    if slot_detail(req):
        type_label = "%s (%s)" % (type_label, slot_detail(req).lower())
    hours = max(1, int(hours))
    hour_word = "ora" if hours == 1 else "ore"
    subject = "Promemoria: %s di %s in attesa" % (type_label.lower(), requester["name"])
    body = ('<p style="margin:0 0 18px;">Questa richiesta è in attesa di una decisione da circa '
            '<strong>%d %s</strong>.</p>' % (hours, hour_word))
    body += details_table(req, requester)
    body += '<p style="margin:0 0 8px;">%s</p>' % button(decide_url, "Apri e decidi", "#b4842a")
    body += '<p style="margin:16px 0 0;font-size:12.5px;color:#8a8172;">Ricevi questo promemoria una sola volta per richiesta.</p>'
    text = ("Promemoria: la richiesta di %s (%s) attende una decisione da %d %s.\n%s\n%s\n"
            % (requester["name"], period, hours, hour_word, decide_url, app_url))
    page = email_shell("Richiesta in attesa", "Promemoria", body,
                       email_footer(req),
                       preheader="%s di %s, %s" % (type_label, requester["name"], period),
                       accent="#b4842a")
    return subject, page, text


def next_week_bounds(today=None):
    """Lunedì e domenica della settimana successiva."""
    today = today or local_now().date()
    monday = today + timedelta(days=7 - today.weekday())
    return monday, monday + timedelta(days=6)


def digest_period_label(start, end):
    if start.year == end.year and start.month == end.month:
        return "%d–%d %s %d" % (start.day, end.day, AGENDA["mesi"][start.month - 1], start.year)
    return "%d %s – %d %s %d" % (start.day, AGENDA["mesi"][start.month - 1],
                                 end.day, AGENDA["mesi"][end.month - 1], end.year)


def weekly_absences(db, start, end):
    """Assenze approvate (ferie e permessi) dei giorni indicati, raggruppate per giorno."""
    grouped = {}
    for req in db.get("requests", []):
        if req.get("status") != "approved" or req.get("type") not in ("ferie", "permesso"):
            continue
        requester = find_user(db, uid=req.get("user_id"))
        if not requester:
            continue
        for value in req.get("dates", []):
            day = parse_day(value)
            if day and start <= day <= end:
                grouped.setdefault(day, {}).setdefault(requester["id"], (requester, req))
    rows = []
    for day in sorted(grouped):
        entries = sorted(grouped[day].values(), key=lambda pair: pair[0].get("name", "").casefold())
        rows.append({"day": day, "entries": entries})
    return rows


def weekly_digest_email(rows, start, end, app_url):
    """Riepilogo leggibile: un blocco per giorno con chi manca e perché."""
    total = sum(len(row["entries"]) for row in rows)
    people = {}
    for row in rows:
        for requester, _req in row["entries"]:
            people[requester["name"]] = people.get(requester["name"], 0) + 1
    period = digest_period_label(start, end)
    if total:
        subject = "%d %s la settimana prossima · %s" % (
            total, "assenza programmata" if total == 1 else "assenze programmate", period)
        intro = ('<p style="margin:0 0 16px;">Ecco le assenze già approvate per la settimana '
                 '<strong>%s</strong>.</p>' % html.escape(fmt_range(start, end)))
    else:
        subject = "Settimana prossima senza assenze · %s" % period
        intro = ('<p style="margin:0 0 16px;">Per la settimana <strong>%s</strong> non ci sono '
                 'assenze approvate.</p>' % html.escape(fmt_range(start, end)))

    cells = []
    for row in rows:
        day = row["day"]
        day_label = "%s %d %s" % (AGENDA["giorni"][day.weekday()].capitalize(), day.day,
                                   AGENDA["mesi"][day.month - 1])
        names = []
        for requester, req in row["entries"]:
            what = TYPE_LABELS.get(req.get("type"), "Assenza")
            if slot_detail(req):
                what += " · " + slot_detail(req)
            names.append('<div style="margin:3px 0;"><strong>%s</strong> <span style="color:#7c8178;'
                         'font-size:13px;">— %s</span></div>'
                         % (html.escape(requester.get("name", "")), html.escape(what)))
        border = "border-bottom:1px solid #edf0ea;" if row is not rows[-1] else ""
        cells.append('<tr><td style="padding:11px 0;%s color:#1b2321;font-size:13px;font-weight:700;'
                     'width:38%%;vertical-align:top;">%s</td><td style="padding:11px 0;%s '
                     'color:#3f4a45;font-size:14px;vertical-align:top;">%s</td></tr>'
                     % (border, html.escape(day_label), border, "".join(names)))

    body = intro
    if cells:
        body += ('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
                 'style="background:#f5f9fc;border-radius:14px;padding:0;margin:0 0 16px;">'
                 '<tr><td style="padding:4px 18px;"><table role="presentation" width="100%" '
                 'cellpadding="0" cellspacing="0" border="0">' + "".join(cells)
                 + '</table></td></tr></table>')
    if people:
        bits = ["%s %d %s" % (name, count, "giorno" if count == 1 else "giorni")
                for name, count in sorted(people.items(), key=lambda item: item[0].casefold())]
        body += ('<p style="margin:0 0 20px;font-size:13.5px;color:#5a655e;">In totale: %s.</p>'
                 % html.escape(", ".join(bits)))
    body += '<p style="margin:0;">%s</p>' % button(app_url + "/", "Apri il calendario")

    lines = ["Assenze della settimana prossima (%s)" % fmt_range(start, end), ""]
    if not rows:
        lines.append("Nessuna assenza approvata.")
    for row in rows:
        lines.append("%s %d %s" % (AGENDA["giorni"][row["day"].weekday()], row["day"].day,
                                     AGENDA["mesi"][row["day"].month - 1]))
        for requester, req in row["entries"]:
            what = TYPE_LABELS.get(req.get("type"), "Assenza")
            if slot_detail(req):
                what += " (%s)" % slot_detail(req)
            lines.append("  · %s — %s" % (requester.get("name", ""), what))
        lines.append("")
    if people:
        lines.append("In totale: %s." % ", ".join(
            "%s %d %s" % (name, count, "giorno" if count == 1 else "giorni")
            for name, count in sorted(people.items(), key=lambda item: item[0].casefold())))
    lines.append("Apri il calendario: %s/" % app_url)
    text = "\n".join(lines)

    page = email_shell("Assenze della settimana prossima", "Riepilogo settimanale", body,
                       "Riepilogo automatico inviato ai coordinatori.",
                       preheader=subject, accent="#005f96")
    return subject, page, text


def deliver_weekly_digest(db, when=None, force=False):
    """Invia il riepilogo ai coordinatori. Non decide se è il momento giusto."""
    when = when or local_now()
    start, end = next_week_bounds(when.date())
    rows = weekly_absences(db, start, end)
    total = sum(len(row["entries"]) for row in rows)
    recipients = coordinators(db)
    result = {"week_start": iso_day(start), "week_end": iso_day(end), "absences": total,
              "sent": 0, "recipients": [], "subject": "", "errors": [], "skipped": ""}
    if not rows and not force:
        result["skipped"] = "nessuna assenza la settimana prossima"
        return result
    if not recipients:
        result["skipped"] = "nessun coordinatore configurato"
        return result
    app_url = APP_BASE_URL or "http://localhost:%d" % PORT
    subject, body, text = weekly_digest_email(rows, start, end, app_url)
    result["subject"] = subject
    for coord in recipients:
        key = new_id("digest-") if force else "digest-%s-%s" % (start.isoformat(), coord["id"])
        mail = send_mail(coord["email"], subject, body, text, reply_to=MAIL_REPLY_TO or None,
                         idempotency_key=key)
        if mail.get("error"):
            result["errors"].append("%s (%s)" % (coord["email"], mail["error"]))
            continue
        result["recipients"].append(coord["email"])
        result["sent"] += 1
    return result


def weekly_digest_settings(db=None):
    """Giorno e ora del riepilogo: quelli scelti dal coordinatore, altrimenti dal .env."""
    db = load_db() if db is None else db
    weekday = (db.get("meta") or {}).get("weekly_digest_weekday")
    if not isinstance(weekday, int) or isinstance(weekday, bool) or not 0 <= weekday <= 6:
        weekday = WEEKLY_DIGEST_WEEKDAY
    return {"weekday": weekday, "hour": WEEKLY_DIGEST_HOUR}


def weekly_digest_due(now=None, db=None):
    """Vero dal giorno configurato, una sola volta per settimana."""
    if not (WEEKLY_DIGEST and email_configured()):
        return False
    now = now or local_now()
    db = load_db() if db is None else db
    settings = weekly_digest_settings(db)
    if now.weekday() < settings["weekday"]:
        return False
    if now.weekday() == settings["weekday"] and now.hour < settings["hour"]:
        return False
    sent_week = (db.get("meta") or {}).get("weekly_digest_week")
    return sent_week != next_week_bounds(now.date())[0].isoformat()


def run_weekly_digest(now=None, force=False):
    """Invia il riepilogo se è il giorno giusto (o subito con force)."""
    now = now or local_now()
    if not force and not weekly_digest_due(now):
        return {"sent": 0, "skipped": "non è il momento del riepilogo", "absences": 0,
                "recipients": [], "errors": []}
    result = deliver_weekly_digest(load_db(), now, force=force)
    if result["sent"]:
        with DB_LOCK:
            fresh = load_db()
            meta = fresh.setdefault("meta", {})
            meta["weekly_digest_week"] = result["week_start"]
            meta["weekly_digest_sent_at"] = now_iso()
            save_db(fresh)
        log("Riepilogo settimanale inviato a %d coordinatori (%d assenze)"
            % (result["sent"], result["absences"]))
    elif result.get("skipped"):
        log("Riepilogo settimanale non inviato: %s" % result["skipped"])
    return result


def digest_loop(stop_event):
    while True:
        try:
            run_weekly_digest()
        except Exception as exc:  # pragma: no cover - difensivo
            log("Riepilogo settimanale non inviato: %r" % exc, error=True)
        if stop_event.wait(900):
            break


def test_email_html(to):
    body = ('<p style="margin:0 0 18px;">Se stai leggendo questo messaggio, l\'invio email è configurato '
            'correttamente.</p>')
    body += ('<div style="background:#f5f9fc;border-radius:14px;padding:16px 18px;margin:0 0 18px;font-size:14px;">'
             '<strong>Destinatario:</strong> %s<br><strong>Server:</strong> %s'
             '</div>' % (html.escape(to), html.escape("Resend" if RESEND_API_KEY else "SMTP")))
    body += '<p style="margin:0;font-size:14px;color:#5a655e;">Da ora il team riceve '
    body += 'notifiche ed esiti delle richieste.</p>'
    page = email_shell("Email di prova", "Configurazione", body,
                       "Email di prova richiesta dal coordinatore.", accent="#005f96")
    text = "Email di prova: l'invio è configurato correttamente. Destinatario: %s" % to
    return "Email di prova · %s" % ORG_NAME, page, text


class ApiError(Exception):
    def __init__(self, status, message, code=None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code


# --------------------------------------------------------------------------
# Handler HTTP
# --------------------------------------------------------------------------

LOG_LOCK = threading.Lock()

# Ultime righe di log tenute in memoria per la diagnostica dell'amministratore.
LOG_BUFFER = collections.deque(maxlen=400)
STARTED_AT = time.time()


def log(message, error=False):
    stamp = datetime.now().strftime("%H:%M:%S")
    entry = {"time": datetime.now().isoformat(timespec="seconds"), "clock": stamp,
             "level": "error" if error else "info", "message": str(message)}
    with LOG_LOCK:
        LOG_BUFFER.append(entry)
        stream = sys.stderr if error else sys.stdout
        stream.write("[%s] %s\n" % (stamp, message))
        stream.flush()


class Handler(BaseHTTPRequestHandler):
    server_version = "FerieDisponibilita/1.0"
    protocol_version = "HTTP/1.1"

    # ----------------------------- helpers -----------------------------

    def log_message(self, fmt, *args):
        pass

    def client_ip(self):
        return self.client_address[0] if self.client_address else "?"

    def read_body(self):
        """Legge (una sola volta) il corpo della richiesta.

        Va letto sempre, anche quando non serve: con HTTP keep-alive un corpo
        non consumato finirebbe nel prefisso della richiesta successiva.
        """
        if getattr(self, "_raw_body", None) is not None:
            return self._raw_body
        self._raw_body = b""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self._raw_body
        if length > 100_000:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
            raise ApiError(413, "La richiesta è troppo grande")
        self._raw_body = self.rfile.read(length)
        return self._raw_body

    def read_json(self):
        raw = self.read_body()
        if not raw:
            return {}
        try:
            data = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise ApiError(400, "I dati non sono validi")
        if not isinstance(data, dict):
            raise ApiError(400, "I dati non sono validi")
        return data

    def read_form(self):
        raw = self.read_body().decode("utf-8", "replace")
        if not raw:
            return {}
        parsed = parse_qs(raw, keep_blank_values=True)
        return {key: values[0] for key, values in parsed.items()}

    def cookies(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return {}
        return {key: morsel.value for key, morsel in cookie.items()}

    def current_user(self, db=None):
        db = db or load_db()
        return read_session(db, self.cookies().get("sess"))

    def require_user(self, db=None):
        user = self.current_user(db)
        if not user:
            raise ApiError(401, "Sessione scaduta. Accedi di nuovo.")
        return user

    def require_coordinator(self, db=None):
        db = db or load_db()
        user = self.require_user(db)
        if not is_coordinator(user):
            raise ApiError(403, "Questa azione è riservata al coordinatore.")
        return user

    def require_admin(self, db=None):
        db = db or load_db()
        user = self.require_user(db)
        if not is_admin(user):
            raise ApiError(403, "Questa sezione è riservata all'amministratore.")
        return user

    def require_staff(self, db=None):
        """Lettura di log ed email: coordinatore o amministratore."""
        db = db or load_db()
        user = self.require_user(db)
        if not (is_coordinator(user) or is_admin(user)):
            raise ApiError(403, "Questa azione è riservata al coordinatore.")
        return user

    def same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True  # richieste same-origin senza Origin (alcuni browser mobili)
        try:
            return urlparse(origin).netloc == self.headers.get("Host", "")
        except ValueError:
            return False

    def base_url(self):
        if APP_BASE_URL:
            return APP_BASE_URL
        host = self.headers.get("Host", "localhost:%d" % PORT)
        # Dietro un reverse proxy (Render, nginx, tunnel) la richiesta arriva in
        # HTTP ma il link pubblico deve restare HTTPS.
        forwarded = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        scheme = "https" if forwarded == "https" else "http"
        return "%s://%s" % (scheme, host)

    def send_bytes(self, data, content_type="application/octet-stream", status=200,
                   headers=None, download_name=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        if download_name:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % download_name)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def send_json(self, data, status=200, cookie=None, clear_cookie=False):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        headers = {"Cache-Control": "no-store"}
        if cookie is not None:
            secure = "; Secure" if self.base_url().startswith("https://") else ""
            headers["Set-Cookie"] = ("sess=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d%s"
                                     % (cookie, MAX_SESSION_DAYS * 86400, secure))
        if clear_cookie:
            headers["Set-Cookie"] = "sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        self.send_bytes(body, "application/json; charset=utf-8", status, headers)

    def send_page(self, markup, status=200, cookie=None, clear_cookie=False):
        headers = {"Cache-Control": "no-store",
                   "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                                              "img-src 'self' data:; script-src 'none'; base-uri 'none'"}
        if cookie is not None:
            headers["Set-Cookie"] = "sess=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d" % (
                cookie, MAX_SESSION_DAYS * 86400)
        if clear_cookie:
            headers["Set-Cookie"] = "sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        self.send_bytes(markup.encode("utf-8"), "text/html; charset=utf-8", status, headers)

    def redirect(self, location):
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ----------------------------- routing -----------------------------

    def do_HEAD(self):
        self.handle_any("GET")

    def do_GET(self):
        self.handle_any("GET")

    def do_POST(self):
        self.handle_any("POST")

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Allow", "GET, POST, HEAD, OPTIONS")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def handle_any(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        self._raw_body = None
        try:
            if method in ("POST", "PUT", "PATCH"):
                # consuma subito il corpo per non corrompere la connessione keep-alive
                self.read_body()
            if path.startswith("/api/"):
                self.handle_api(method, path[len("/api/"):], parse_qs(parsed.query))
            elif path.startswith("/decide/"):
                self.handle_decide(method, path[len("/decide/"):], parse_qs(parsed.query))
            elif path == "/calendar.ics":
                self.handle_ics(parse_qs(parsed.query))
            elif path.startswith("/avatar/"):
                self.handle_avatar(path[len("/avatar/"):])
            elif method == "GET":
                self.handle_static(path)
            else:
                raise ApiError(404, "Non trovato")
        except ApiError as exc:
            if path.startswith("/api/"):
                self.send_json({"error": exc.message, "code": exc.code}, exc.status)
            else:
                self.send_page(error_page(exc.status, exc.message), exc.status)
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as exc:  # pragma: no cover - difensivo
            log("Errore su %s %s: %r" % (method, path, exc), error=True)
            if path.startswith("/api/"):
                try:
                    self.send_json({"error": "Errore interno del server"}, 500)
                except Exception:
                    pass
            else:
                try:
                    self.send_page(error_page(500, "Errore interno del server"), 500)
                except Exception:
                    pass

    # ----------------------------- API -----------------------------

    def handle_api(self, method, route, query):
        if route == "config" and method == "GET":
            return self.api_config()
        if route == "session" and method == "GET":
            return self.api_session()
        if route == "login" and method == "POST":
            return self.api_login()
        if route == "logout" and method == "POST":
            if not self.same_origin():
                raise ApiError(403, "L'origine non è valida")
            return self.send_json({"ok": True}, cookie="", clear_cookie=True)
        if route == "health" and method == "GET":
            return self.send_json({"ok": True, "org": ORG_NAME})

        if not self.same_origin() and method == "POST":
            raise ApiError(403, "L'origine non è valida")

        if route == "calendar" and method == "GET":
            return self.api_calendar(query)
        if route == "requests" and method == "GET":
            return self.api_my_requests()
        if route == "requests" and method == "POST":
            return self.api_create_request()
        if route == "requests/pending" and method == "GET":
            return self.api_pending()
        if route == "notifications" and method == "GET":
            return self.api_notifications()
        if route == "notifications/seen" and method == "POST":
            return self.api_notifications_seen()
        if route == "pin" and method == "POST":
            return self.api_change_pin()
        if route == "test-email" and method == "POST":
            return self.api_test_email()
        if route == "weekly-digest" and method == "POST":
            return self.api_weekly_digest()
        if route == "weekly-digest/settings" and method == "POST":
            return self.api_weekly_digest_settings()
        if route == "admin/diagnostics" and method == "GET":
            return self.api_admin_diagnostics()
        if route == "users" and method == "GET":
            return self.api_users()
        if route == "users" and method == "POST":
            return self.api_create_user()
        if route.startswith("users/") and route.endswith("/appearance") and method == "POST":
            return self.api_update_appearance(route[len("users/"):-len("/appearance")])
        if route == "profile" and method == "POST":
            return self.api_update_profile()
        if route.startswith("users/") and route.endswith("/delete") and method == "POST":
            return self.api_delete_user(route[len("users/"):-len("/delete")])
        if route == "push/key" and method == "GET":
            return self.api_push_key()
        if route == "push/subscribe" and method == "POST":
            return self.api_push_subscribe()
        if route == "push/unsubscribe" and method == "POST":
            return self.api_push_unsubscribe()
        if route == "outbox" and method == "GET":
            return self.api_outbox()
        if route.startswith("outbox/") and route.endswith("/resend") and method == "POST":
            return self.api_resend_outbox(route[len("outbox/"):-len("/resend")])
        if route.startswith("outbox/") and method == "GET":
            return self.api_outbox_item(route[len("outbox/"):])
        if route.startswith("requests/"):
            parts = route.split("/")
            if len(parts) == 3 and parts[2] == "cancel" and method == "POST":
                return self.api_cancel(parts[1])
            if len(parts) == 3 and parts[2] == "decision" and method == "POST":
                return self.api_decision(parts[1])
            if len(parts) == 3 and parts[2] == "reopen" and method == "POST":
                return self.api_reopen(parts[1])
        raise ApiError(404, "Endpoint non trovato")

    def public_config(self):
        db = load_db()
        # Gli account dimostrativi compaiono quando non c'è un servizio email:
        # così anche la demo pubblica si può provare senza cercare le
        # credenziali nel README. Sono solo gli utenti creati dal seeding
        # (hanno demo_pin), mai le persone reali aggiunte dal coordinatore.
        demo = not email_configured()
        accounts = []
        if demo:
            accounts = [{"name": u["name"], "email": u["email"], "role": u["role"],
                         "pin": u.get("demo_pin")} for u in db["users"] if u.get("demo_pin")]
        digest_settings = weekly_digest_settings(db)
        return {
            "org_name": ORG_NAME,
            "org_short": ORG_SHORT,
            "org_site": ORG_SITE,
            "org_brand": ORG_BRAND,
            "base_url": self.base_url(),
            "email_configured": email_configured(),
            "demo_mode": not email_configured(),
            "reminders_enabled": email_configured() and REMINDER_HOURS > 0,
            "reminder_hours": REMINDER_HOURS,
            "weekly_digest": {
                "enabled": bool(WEEKLY_DIGEST and email_configured()),
                "weekday": digest_settings["weekday"],
                "weekday_label": AGENDA["giorni"][digest_settings["weekday"]],
                "hour": digest_settings["hour"],
                "custom_weekday": "weekly_digest_weekday" in (db.get("meta") or {}),
            },
            "demo_accounts": accounts,
            "ics_url": "/calendar.ics?t=" + ics_feed_token(),
            "roles": list(ROLES),
            "palette": COLORS,
            "types_by_role": {role: allowed_types({"role": role}) for role in ROLES},
        }

    def api_config(self):
        self.send_json(self.public_config())

    def api_session(self):
        db = load_db()
        user = self.current_user(db)
        if not user:
            raise ApiError(401, "Non autenticato")
        self.send_json({"user": public_user(user), "config": self.public_config(),
                        "notifications": build_notifications(db, user),
                        "allowed_types": allowed_types(user),
                        "push_devices": len(push_subscriptions(user))})

    def api_login(self):
        if not self.same_origin():
            raise ApiError(403, "L'origine non è valida")
        ip = self.client_ip()
        limit, reset = LOGIN_ATTEMPTS.get(ip, (0, 0))
        if time.time() < reset and limit >= 10:
            raise ApiError(429, "Troppi tentativi. Riprova tra qualche minuto.")
        data = self.read_json()
        email = clean_text(data.get("email"), 120).lower()
        pin = clean_text(data.get("pin"), 32)
        db = load_db()
        user = find_user(db, email=email)
        if not user or not pin:
            self._register_failure(ip)
            raise ApiError(401, "Email o PIN non corretti")
        if not verify_pin(pin, user["salt"], user["pin_hash"]):
            self._register_failure(ip)
            raise ApiError(401, "Email o PIN non corretti")
        LOGIN_ATTEMPTS.pop(ip, None)
        self.send_json({"user": public_user(user), "config": self.public_config(),
                        "notifications": build_notifications(db, user),
                        "allowed_types": allowed_types(user),
                        "push_devices": len(push_subscriptions(user))},
                       cookie=make_session(user))

    def _register_failure(self, ip):
        limit, reset = LOGIN_ATTEMPTS.get(ip, (0, 0))
        if time.time() > reset:
            limit, reset = 0, time.time() + 900
        LOGIN_ATTEMPTS[ip] = (limit + 1, reset)

    def api_calendar(self, query):
        db = load_db()
        user = self.require_user(db)
        try:
            start = parse_day(query.get("from", [None])[0]) or date.today().replace(day=1) - timedelta(days=31)
        except (ValueError, TypeError):
            start = date.today().replace(day=1) - timedelta(days=31)
        try:
            end = parse_day(query.get("to", [None])[0]) or (start + timedelta(days=200))
        except (ValueError, TypeError):
            end = start + timedelta(days=200)
        range_days = {iso_day(start + timedelta(days=i)) for i in range((end - start).days + 1)}
        visible = []
        for req in db["requests"]:
            status = req.get("status")
            mine = req["user_id"] == user["id"]
            if status == "approved":
                pass
            elif status == "pending" and (mine or is_coordinator(user)):
                pass
            else:
                continue
            if not range_days.intersection(req.get("dates", [])):
                continue
            visible.append(serialize_request(db, req))
        people = [public_user(u) for u in db["users"]]
        self.send_json({
            "me": public_user(user),
            "events": visible,
            "birthdays": birthdays_in_range(db, start, end),
            "people": people,
            "today": date.today().isoformat(),
            "server_time": now_iso(),
            "ics_url": "/calendar.ics?t=" + ics_feed_token(),
        })

    def api_my_requests(self):
        db = load_db()
        user = self.require_user(db)
        items = [serialize_request(db, r) for r in db["requests"] if r["user_id"] == user["id"]]
        items.sort(key=lambda r: (r["status"] != "pending", r.get("start") or ""), reverse=False)
        items.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        self.send_json({"requests": items})

    def api_pending(self):
        db = load_db()
        self.require_coordinator(db)
        items = [serialize_request(db, r) for r in db["requests"] if r.get("status") == "pending"]
        items.sort(key=lambda r: r.get("created_at") or "")
        history = [serialize_request(db, r) for r in db["requests"] if r.get("status") in ("approved", "rejected")]
        history.sort(key=lambda r: r.get("decided_at") or "", reverse=True)
        self.send_json({"pending": items, "history": history[:40], "stats": compute_stats(db)})

    def _validate_request(self, db, user, data):
        req_type = data.get("type")
        if req_type not in TYPE_LABELS:
            raise ApiError(400, "Il tipo di richiesta non è valido")
        if req_type not in allowed_types(user):
            allowed = allowed_types(user)
            if not allowed:
                raise ApiError(403, "Il tuo profilo non può inviare richieste")
            labels = " e ".join(TYPE_LABELS[t].lower() for t in allowed)
            raise ApiError(403, "Il tuo profilo può inviare solo: " + labels)
        raw_dates = data.get("dates")
        if not isinstance(raw_dates, list) or not raw_dates:
            raise ApiError(400, "Seleziona almeno un giorno sul calendario")
        days = sorted({parse_day(value) for value in raw_dates if parse_day(value)})
        if not days:
            raise ApiError(400, "Le date selezionate non sono valide")
        if len(days) > 90:
            raise ApiError(400, "Puoi selezionare al massimo 90 giorni per richiesta")
        today = date.today()
        if days[0] < today:
            raise ApiError(400, "Non puoi richiedere giorni già passati")
        availability = data.get("availability")
        if req_type == "disponibilita":
            if availability not in AVAIL_LABELS:
                raise ApiError(400, "Indica se il giorno è disponibile o non disponibile")
        else:
            availability = None
        slot = None
        time_from = None
        time_to = None
        # Permessi e disponibilità possono coprire solo una parte della giornata:
        # un professionista può essere disponibile dalle 8 alle 13, non dalle 8 alle 20.
        if req_type in ("permesso", "disponibilita"):
            slot = data.get("slot") or "giornata"
            if slot not in SLOT_LABELS:
                raise ApiError(400, "La fascia oraria non è valida")
            if slot == SLOT_CUSTOM:
                time_from = normalize_time(data.get("time_from"))
                time_to = normalize_time(data.get("time_to"))
                if not time_from or not time_to:
                    raise ApiError(400, "Indica l'orario di inizio e di fine")
                if time_to <= time_from:
                    raise ApiError(400, "L'orario di fine deve essere successivo a quello di inizio")
        note = clean_text(data.get("note"), 500)
        if len(note) > 500:
            raise ApiError(400, "La nota è troppo lunga")
        date_strings = [iso_day(d) for d in days]
        for existing in db["requests"]:
            if existing["user_id"] != user["id"] or existing.get("status") != "pending":
                continue
            if overlaps_any(existing, date_strings):
                raise ApiError(409, "Hai già una richiesta in attesa su uno di questi giorni")
        return req_type, days, availability, note, slot, time_from, time_to

    def api_create_request(self):
        data = self.read_json()
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            req_type, days, availability, note, slot, time_from, time_to = self._validate_request(db, user, data)
            req = {
                "id": new_id("r_"),
                "user_id": user["id"],
                "type": req_type,
                "availability": availability,
                "slot": slot,
                "time_from": time_from,
                "time_to": time_to,
                "dates": [iso_day(d) for d in days],
                "note": note,
                "status": "pending",
                "created_at": now_iso(),
                "decided_at": None,
                "decided_by": None,
                "decision_note": "",
            }
            db["requests"].append(req)
            save_db(db)
            recipients = coordinators(db)
            serialized = serialize_request(db, req)
            user_name = user["name"]

        app_url = self.base_url()
        decide_url = "%s/decide/%s?t=%s" % (app_url, req["id"], quote(signed_token(req["id"])))
        subject, body, text = coordinator_email(user, req, decide_url, app_url)
        errors = []
        for coord in recipients:
            mail = send_mail(coord["email"], subject, body, text, reply_to=user["email"],
                             idempotency_key="notify-%s-%s" % (req["id"], coord["id"]))
            if mail.get("error"):
                errors.append("%s (%s)" % (coord["email"], mail["error"]))
        if not recipients:
            errors.append("Nessun coordinatore configurato")
        log("Nuova richiesta %s da %s (%s)" % (req["id"], user_name, req_type))

        payload = {"request": serialized, "notified": [c["email"] for c in recipients],
                   "decision_link": decide_url}
        if errors:
            payload["warning"] = "Email non inviata: " + "; ".join(errors)
        self.send_json(payload, 201)

    def api_cancel(self, rid):
        """Annulla una richiesta: il richiedente può farlo anche dopo l'approvazione, il coordinatore sempre."""
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            req = next((r for r in db["requests"] if r["id"] == rid), None)
            if not req:
                raise ApiError(404, "Richiesta non trovata")
            owner = req["user_id"] == user["id"]
            if not owner and not is_coordinator(user):
                raise ApiError(403, "Non puoi annullare questa richiesta")
            status = req.get("status")
            if status == "cancelled":
                raise ApiError(409, "Questa richiesta è già annullata")
            if owner and status not in ("pending", "approved"):
                raise ApiError(409, "Puoi ritirare solo una richiesta in attesa o già approvata")
            if owner and status == "approved":
                note = "Ritirata dal richiedente dopo l'approvazione"
            elif owner:
                note = "Annullata dal richiedente"
            else:
                note = "Annullata dal coordinatore"
            req["status"] = "cancelled"
            req["decided_at"] = now_iso()
            req["decided_by"] = user["id"]
            req["decision_note"] = note
            save_db(db)
            serialized = serialize_request(db, req)
        log("Richiesta %s annullata da %s" % (rid, user.get("name")))
        self.send_json({"request": serialized})

    def api_decision(self, rid):
        data = self.read_json()
        decision = data.get("decision")
        note = clean_text(data.get("note"), 500)
        if decision not in ("approve", "reject"):
            raise ApiError(400, "La decisione non è valida")
        with DB_LOCK:
            db = load_db()
            coord = self.require_coordinator(db)
            req = next((r for r in db["requests"] if r["id"] == rid), None)
            if not req:
                raise ApiError(404, "Richiesta non trovata")
            if req.get("status") == "cancelled":
                raise ApiError(409, "Questa richiesta è stata annullata")
            requester = self._record_decision(db, req, coord, decision, note)
            serialized = serialize_request(db, req)
            outcome = (requester, dict(req), coord, note) if requester else None
        if outcome:
            self._send_outcome(*outcome)
        self.send_json({"request": serialized})

    def _record_decision(self, db, req, coord, decision, note):
        requester = find_user(db, uid=req["user_id"])
        req["status"] = "approved" if decision == "approve" else "rejected"
        req["decided_at"] = now_iso()
        req["decided_by"] = coord["id"]
        req["decision_note"] = note
        save_db(db)
        log("Richiesta %s %s da %s" % (req["id"], req["status"], coord.get("name")))
        return requester

    def _send_outcome(self, requester, req, coord, note):
        app_url = self.base_url()
        subject, body, text = outcome_email(requester, req, coord.get("name"), note, app_url)
        attachments = None
        # La disponibilità non è un'assenza: niente invito di calendario.
        if req["status"] == "approved" and req["type"] != "disponibilita":
            content = request_ics(req, requester)
            attachments = [("richiesta-%s.ics" % req["id"], base64.b64encode(content.encode()).decode())]
        decided = parse_iso(req.get("decided_at"))
        stamp = int(decided.timestamp()) if decided else int(time.time())
        send_mail(requester["email"], subject, body, text, attachments,
                  reply_to=(coord.get("email") or MAIL_REPLY_TO or None),
                  idempotency_key="outcome-%s-%s" % (req["id"], stamp))
        days = [parse_day(day) for day in req.get("dates", []) if parse_day(day)]
        approved = req["status"] == "approved"
        if req.get("type") == "disponibilita":
            push_title = "Comunicazione letta" if approved else "Comunicazione da rivedere"
            push_body = "Disponibilità: %s · %s" % (AVAIL_LABELS.get(req.get("availability"), ""),
                                                     fmt_dates(days))
            if slot_detail(req):
                push_body += " · " + slot_detail(req)
        else:
            push_title = "Richiesta approvata" if approved else "Richiesta rifiutata"
            push_body = "%s · %s" % (TYPE_LABELS.get(req.get("type"), "Richiesta"), fmt_dates(days))
        if note:
            push_body += " · " + note
        notify_push(requester.get("id"), push_payload(push_title, push_body, "/", "req-" + req["id"]))

    def api_change_pin(self):
        data = self.read_json()
        current = clean_text(data.get("current"), 32)
        new_pin = clean_text(data.get("new"), 32)
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            if not verify_pin(current, user["salt"], user["pin_hash"]):
                raise ApiError(401, "Il PIN attuale non è corretto")
            if not re.match(r"^\d{4,8}$", new_pin):
                raise ApiError(400, "Il nuovo PIN deve avere da 4 a 8 cifre")
            user["salt"], user["pin_hash"] = hash_pin(new_pin)
            db["seeded"] = False
            save_db(db)
            cookie = make_session(user)
        self.send_json({"ok": True}, cookie=cookie)

    def api_users(self):
        db = load_db()
        self.require_coordinator(db)
        users = sorted(db["users"], key=lambda u: (
            0 if u.get("role") == ROLE_COORD else 1, u.get("name", "").lower()))
        self.send_json({"users": [public_user(u) for u in users], "roles": list(ROLES),
                        "palette": COLORS})

    def api_create_user(self):
        data = self.read_json()
        name = clean_text(data.get("name"), 80)
        email = clean_text(data.get("email"), 120).lower()
        role = clean_text(data.get("role"), 30)
        pin = clean_text(data.get("pin"), 32)
        color = clean_text(data.get("color"), 9).lower()
        avatar = data.get("avatar") if isinstance(data.get("avatar"), str) else None
        if len(name) < 2:
            raise ApiError(400, "Inserisci nome e cognome")
        if not valid_email(email):
            raise ApiError(400, "L'email non è valida")
        if role not in ROLES:
            raise ApiError(400, "Il ruolo non è valido")
        if not re.match(r"^\d{4,8}$", pin):
            raise ApiError(400, "Il PIN deve avere da 4 a 8 cifre")
        with DB_LOCK:
            db = load_db()
            coord = self.require_coordinator(db)
            if find_user(db, email=email):
                raise ApiError(409, "Esiste già una persona con questa email")
            if len(db["users"]) >= 200:
                raise ApiError(400, "È stato raggiunto il limite di 200 utenti")
            salt, digest = hash_pin(pin)
            user = {
                "id": new_id("u_"), "name": name, "email": email, "role": role,
                "salt": salt, "pin_hash": digest,
                "color": color if color in COLORS else pick_color(db),
                "created_at": now_iso(), "seen_at": None,
            }
            user["avatar"], previous = prepare_avatar(user, avatar)
            db["users"].append(user)
            db["seeded"] = False
            save_db(db)
            if previous and previous != user.get("avatar"):
                remove_avatar(previous)
            log("Utente creato da %s: %s <%s> (%s)" % (coord.get("name"), name, email, role))
        self.send_json({"user": public_user(user)}, 201)

    def api_update_appearance(self, uid):
        """Cambia colore e foto: il coordinatore per chiunque, ognuno per sé."""
        data = self.read_json()
        color = data.get("color")
        if color is not None:
            color = clean_text(color, 9).lower()
            if color not in COLORS:
                raise ApiError(400, "Il colore scelto non è disponibile")
        avatar = data.get("avatar") if isinstance(data.get("avatar"), str) else None
        with DB_LOCK:
            db = load_db()
            me = self.require_user(db)
            target = find_user(db, uid=uid)
            if not target:
                raise ApiError(404, "Persona non trovata")
            if target["id"] != me["id"] and not is_coordinator(me):
                raise ApiError(403, "Puoi modificare solo il tuo aspetto")
            if color is not None:
                target["color"] = color
            new_avatar, previous = prepare_avatar(target, avatar)
            target["avatar"] = new_avatar
            db["seeded"] = False
            save_db(db)
            if previous and previous != new_avatar:
                remove_avatar(previous)
            updated = public_user(target)
            log("Aspetto aggiornato per %s" % target.get("name"))
        self.send_json({"user": updated, "palette": COLORS})

    def api_test_email(self):
        db = load_db()
        coord = self.require_coordinator(db)
        if not email_configured():
            raise ApiError(400, "Nessun servizio email configurato. Imposta RESEND_API_KEY o SMTP nel file .env e riavvia.")
        subject, body, text = test_email_html(coord["email"])
        mail = send_mail(coord["email"], subject, body, text,
                         reply_to=(MAIL_REPLY_TO or coord["email"]),
                         idempotency_key=new_id("test-"))
        if mail.get("error"):
            raise ApiError(502, "Invio non riuscito: " + mail["error"])
        self.send_json({"ok": True, "provider": mail.get("provider")})

    def api_weekly_digest(self):
        """Il coordinatore invia subito il riepilogo, senza aspettare il giorno previsto."""
        db = load_db()
        self.require_coordinator(db)
        if not email_configured():
            raise ApiError(400, "Nessun servizio email configurato. Imposta RESEND_API_KEY o SMTP nel file .env e riavvia.")
        result = run_weekly_digest(force=True)
        if result.get("errors") and not result.get("sent"):
            raise ApiError(502, "Invio non riuscito: " + "; ".join(result["errors"]))
        payload = {"ok": True, "sent": result.get("sent", 0),
                   "recipients": result.get("recipients", []),
                   "subject": result.get("subject", ""),
                   "absences": result.get("absences", 0),
                   "week_start": result.get("week_start")}
        if result.get("errors"):
            payload["warning"] = "; ".join(result["errors"])
        self.send_json(payload)

    def api_weekly_digest_settings(self):
        """Il coordinatore sceglie il giorno in cui parte il riepilogo settimanale."""
        data = self.read_json()
        try:
            weekday = int(data.get("weekday"))
        except (TypeError, ValueError):
            raise ApiError(400, "Indica un giorno della settimana")
        if isinstance(data.get("weekday"), bool) or not 0 <= weekday <= 6:
            raise ApiError(400, "Indica un giorno della settimana")
        with DB_LOCK:
            db = load_db()
            self.require_coordinator(db)
            db.setdefault("meta", {})["weekly_digest_weekday"] = weekday
            save_db(db)
            settings = weekly_digest_settings(db)
        log("Riepilogo settimanale spostato al %s" % AGENDA["giorni"][weekday])
        self.send_json({"ok": True, "weekly_digest": {
            "enabled": bool(WEEKLY_DIGEST and email_configured()),
            "weekday": settings["weekday"],
            "weekday_label": AGENDA["giorni"][settings["weekday"]],
            "hour": settings["hour"],
            "custom_weekday": True,
        }})

    def api_admin_diagnostics(self):
        """Log, email ed errori recenti per l'amministratore (sola lettura)."""
        db = load_db()
        self.require_admin(db)
        self.send_json(diagnostics_snapshot(db))

    def api_outbox(self):
        db = load_db()
        self.require_staff(db)
        items = [{"id": m["id"], "to": m["to"], "subject": m["subject"],
                  "created_at": m["created_at"], "error": m.get("error"),
                  "provider": m.get("provider"), "reply_to": m.get("reply_to", ""),
                  "attachments": len(m.get("attachments") or [])}
                 for m in db["outbox"]]
        self.send_json({"messages": items, "configured": email_configured()})

    def api_outbox_item(self, mid):
        db = load_db()
        self.require_staff(db)
        entry = next((m for m in db["outbox"] if m["id"] == mid), None)
        if not entry:
            raise ApiError(404, "Messaggio non trovato")
        self.send_page(entry["html"])

    def api_resend_outbox(self, mid):
        db = load_db()
        self.require_coordinator(db)
        entry = next((m for m in db["outbox"] if m["id"] == mid), None)
        if not entry:
            raise ApiError(404, "Messaggio non trovato")
        attachments = [(a["filename"], a["content"]) for a in (entry.get("attachments") or [])]
        mail = send_mail(entry["to"], entry["subject"], entry["html"], entry.get("text") or "",
                         attachments=attachments or None,
                         reply_to=entry.get("reply_to") or None,
                         idempotency_key=new_id("resend-"))
        if mail.get("error"):
            raise ApiError(502, "Reinvio non riuscito: " + mail["error"])
        self.send_json({"ok": True, "provider": mail.get("provider")})

    def api_notifications(self):
        db = load_db()
        user = self.require_user(db)
        self.send_json({"notifications": build_notifications(db, user)})

    def api_notifications_seen(self):
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            user["seen_at"] = now_iso()
            save_db(db)
        self.send_json({"ok": True})

    def api_reopen(self, rid):
        """Rimette in attesa una richiesta già decisa per rivalutarla."""
        with DB_LOCK:
            db = load_db()
            coord = self.require_coordinator(db)
            req = next((r for r in db["requests"] if r["id"] == rid), None)
            if not req:
                raise ApiError(404, "Richiesta non trovata")
            if req.get("status") not in ("approved", "rejected"):
                raise ApiError(409, "Solo una richiesta già decisa può tornare in attesa")
            req["status"] = "pending"
            req["decided_at"] = None
            req["decided_by"] = None
            req["decision_note"] = ""
            save_db(db)
            serialized = serialize_request(db, req)
        log("Richiesta %s riaperta da %s" % (rid, coord.get("name")))
        self.send_json({"request": serialized})

    def api_update_profile(self):
        """Nome, email e compleanno del proprio account (le credenziali restano invariate)."""
        data = self.read_json()
        name = clean_text(data.get("name"), 80)
        email = clean_text(data.get("email"), 120).lower()
        if len(name) < 2:
            raise ApiError(400, "Inserisci nome e cognome")
        if not valid_email(email):
            raise ApiError(400, "L'email non è valida")
        birthday = None
        if "birthday" in data and str(data.get("birthday") or "").strip():
            birthday = normalize_birthday(data.get("birthday"))
            if not birthday:
                raise ApiError(400, "Il compleanno non è valido: indica giorno e mese")
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            other = find_user(db, email=email)
            if other and other["id"] != user["id"]:
                raise ApiError(409, "Esiste già una persona con questa email")
            before = (user.get("name"), user.get("email"))
            user["name"], user["email"] = name, email
            if "birthday" in data:
                if birthday:
                    user["birthday"] = birthday
                else:
                    user.pop("birthday", None)
            save_db(db)
            updated = public_user(user)
        if before != (name, email):
            log("Dati account aggiornati per %s: %s <%s>" % (user["id"], name, email))
        self.send_json({"user": updated})

    def api_delete_user(self, uid):
        """Elimina un accesso e le sue richieste. Non si può eliminare l'ultimo coordinatore."""
        with DB_LOCK:
            db = load_db()
            coord = self.require_coordinator(db)
            target = find_user(db, uid=uid)
            if not target:
                raise ApiError(404, "Persona non trovata")
            if target["id"] == coord["id"]:
                raise ApiError(400, "Non puoi eliminare il tuo account: chiedilo a un altro coordinatore")
            if is_coordinator(target) and len(coordinators(db)) <= 1:
                raise ApiError(400, "Deve restare almeno un coordinatore")
            avatar = target.get("avatar")
            requests = [r for r in db["requests"] if r["user_id"] == uid]
            db["users"] = [u for u in db["users"] if u["id"] != uid]
            db["requests"] = [r for r in db["requests"] if r["user_id"] != uid]
            save_db(db)
            remove_avatar(avatar)
            name, email = target.get("name"), target.get("email")
        log("Accesso eliminato da %s: %s <%s> (%d richieste)" % (coord.get("name"), name, email, len(requests)))
        self.send_json({"ok": True, "removed_requests": len(requests)})

    def api_push_key(self):
        db = load_db()
        self.require_user(db)
        vapid = load_vapid()
        self.send_json({"public_key": vapid["public"], "enabled": True})

    def api_push_subscribe(self):
        data = self.read_json()
        endpoint = clean_text(data.get("endpoint"), 800)
        keys = data.get("keys") if isinstance(data.get("keys"), dict) else {}
        if not endpoint.startswith("https://"):
            raise ApiError(400, "Sottoscrizione push non valida")
        try:
            p256dh, auth = webpush.subscription_keys(keys.get("p256dh"), keys.get("auth"))
        except (ValueError, TypeError, KeyError):
            raise ApiError(400, "Chiavi push non valide")
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            devices = [s for s in (user.get("push") or []) if s.get("endpoint") != endpoint]
            devices.append({"endpoint": endpoint, "p256dh": p256dh, "auth": auth,
                            "created_at": now_iso(),
                            "device": clean_text(data.get("device"), 120)})
            user["push"] = devices[-PUSH_MAX_DEVICES:]
            save_db(db)
            count = len(user["push"])
        log("Notifiche push attive per %s (%d dispositivi)" % (user.get("name"), count))
        self.send_json({"ok": True, "devices": count})

    def api_push_unsubscribe(self):
        data = self.read_json()
        endpoint = clean_text(data.get("endpoint"), 800)
        with DB_LOCK:
            db = load_db()
            user = self.require_user(db)
            user["push"] = [s for s in (user.get("push") or [])
                            if s.get("endpoint") != endpoint]
            save_db(db)
            count = len(user["push"])
        self.send_json({"ok": True, "devices": count})

    # ----------------------------- decision page -----------------------------

    def handle_decide(self, method, rest, query):
        rid = rest.split("/")[0]
        db = load_db()
        req = next((r for r in db["requests"] if r["id"] == rid), None)
        data = self.read_form() if method == "POST" else {}
        token = data.get("t") or query.get("t", [None])[0]
        if not req:
            raise ApiError(404, "Richiesta non trovata o link non più valido")

        coord = self.current_user(db)
        via_token = verify_token(rid, token)
        if not via_token and not is_coordinator(coord):
            raise ApiError(403, "Link non valido o scaduto. Accedi all'app come coordinatore.")

        if method == "POST":
            decision = data.get("decision")
            note = clean_text(data.get("note"), 500)
            if decision not in ("approve", "reject"):
                raise ApiError(400, "Scegli se approvare o rifiutare")
            if req.get("status") != "pending":
                return self.send_page(decision_page(db, req, None, token, already=True))
            with DB_LOCK:
                db = load_db()
                req = next((r for r in db["requests"] if r["id"] == rid), req)
                if req.get("status") != "pending":
                    return self.send_page(decision_page(db, req, None, token, already=True))
                actor = coord if is_coordinator(coord) else self._fallback_coordinator(db)
                requester = self._record_decision(db, req, actor, decision, note)
                req_snapshot = dict(req)
            if requester:
                self._send_outcome(requester, req_snapshot, actor, note)
            return self.send_page(decision_page(db, req_snapshot, actor, token))

        action = (query.get("action", [""])[0] or "").strip()
        self.send_page(decision_page(db, req, coord, token, action=action))

    def _fallback_coordinator(self, db):
        found = coordinators(db)
        if found:
            return found[0]
        return {"id": "email-link", "name": "un coordinatore", "email": ""}

    # ----------------------------- ICS -----------------------------

    def handle_ics(self, query):
        token = query.get("t", [""])[0]
        if not hmac.compare_digest(token, ics_feed_token()):
            raise ApiError(403, "Il link del calendario non è valido")
        db = load_db()
        now_stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        lines = [
            "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ferie e Disponibilita//IT",
            "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
            "X-WR-CALNAME:%s" % ics_escape(ORG_NAME + " — ferie e disponibilità"),
        ]
        for req in db["requests"]:
            if req.get("status") != "approved":
                continue
            user = find_user(db, uid=req["user_id"])
            if not user:
                continue
            days = sorted(parse_day(d) for d in req.get("dates", []) if parse_day(d))
            if not days:
                continue
            if req["type"] == "ferie":
                label = "Ferie"
            elif req["type"] == "permesso":
                label = "Permesso" + (" · " + slot_display(req) if req.get("slot") else "")
            else:
                label = "Disponibilità: " + AVAIL_LABELS.get(req.get("availability"), "")
            if slot_detail(req):
                label += " · " + slot_detail(req)
            runs = group_day_runs(days)
            for index, (start, end) in enumerate(runs):
                uid = req["id"] if len(runs) == 1 else "%s-%d" % (req["id"], index + 1)
                lines += [
                    "BEGIN:VEVENT",
                    "UID:%s@ferie-disponibilita" % uid,
                    "DTSTAMP:%s" % now_stamp,
                    "DTSTART;VALUE=DATE:%s" % start.strftime("%Y%m%d"),
                    "DTEND;VALUE=DATE:%s" % (end + timedelta(days=1)).strftime("%Y%m%d"),
                    "SUMMARY:%s" % ics_escape("%s — %s" % (label, user["name"])),
                    "DESCRIPTION:%s" % ics_escape(req.get("note", "")),
                    "STATUS:CONFIRMED",
                    "END:VEVENT",
                ]
        lines.append("END:VCALENDAR")
        body = fold_ics("\r\n".join(lines) + "\r\n").encode("utf-8")
        self.send_bytes(body, "text/calendar; charset=utf-8", 200,
                        {"Cache-Control": "no-store"})

    # ----------------------------- avatar -----------------------------

    def handle_avatar(self, name):
        """Serve una foto profilo solo agli utenti autenticati."""
        try:
            self.require_user()
            target = avatar_path(name)
        except ApiError as exc:
            self.send_json({"error": exc.message}, exc.status)
            return
        if not target or not target.is_file():
            self.send_json({"error": "Immagine non trovata"}, 404)
            return
        data = target.read_bytes()
        self.send_bytes(data, AVATAR_MIME.get(target.suffix.lower(), "application/octet-stream"), 200,
                        {"Cache-Control": "private, max-age=31536000, immutable"})

    # ----------------------------- static -----------------------------

    def handle_static(self, path):
        if path in ("/", "/index.html"):
            target = PUBLIC_DIR / "index.html"
        else:
            relative = path.lstrip("/")
            target = (PUBLIC_DIR / relative).resolve()
            try:
                target.relative_to(PUBLIC_DIR.resolve())
            except ValueError:
                raise ApiError(404, "Non trovato")
        if not target.is_file():
            raise ApiError(404, "Non trovato")
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".webmanifest": "application/manifest+json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
            ".woff2": "font/woff2",
        }.get(target.suffix.lower(), "application/octet-stream")
        data = target.read_bytes()
        headers = {"Cache-Control": "no-cache"}
        if target.suffix == ".html":
            headers["Content-Security-Policy"] = (
                "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
                "script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'")
        if target.name == "sw.js":
            headers["Cache-Control"] = "no-cache"
        self.send_bytes(data, mime, 200, headers)


LOGIN_ATTEMPTS = {}


# --------------------------------------------------------------------------
# Notifiche push (Web Push / VAPID)
# --------------------------------------------------------------------------

_VAPID_CACHE = {}
PUSH_MAX_DEVICES = 10


def push_subject():
    if VAPID_SUBJECT:
        return VAPID_SUBJECT if VAPID_SUBJECT.startswith(("mailto:", "https://")) else "mailto:" + VAPID_SUBJECT
    address = MAIL_FROM or MAIL_REPLY_TO or "ferie@localhost"
    return address if address.startswith(("mailto:", "https://")) else "mailto:" + address


def load_vapid(force=False):
    """Chiavi VAPID persistenti in data/vapid.json (generate al primo uso)."""
    with DB_LOCK:
        if not force and _VAPID_CACHE.get("value"):
            return _VAPID_CACHE["value"]
        data = None
        if VAPID_PATH.exists():
            try:
                data = json.loads(VAPID_PATH.read_text(encoding="utf-8"))
                vapid = webpush.load_vapid(data)
            except (OSError, ValueError, KeyError, TypeError):
                data = None
        if not data:
            vapid = webpush.new_vapid(push_subject())
            _atomic_write(VAPID_PATH, json.dumps(vapid))
            try:
                os.chmod(VAPID_PATH, 0o600)
            except OSError:
                pass
        _VAPID_CACHE["value"] = vapid
        return vapid


def push_subscriptions(user):
    return [s for s in (user or {}).get("push", []) if s.get("endpoint")]


def push_payload(title, body, url="/", tag="ferie"):
    return {"title": title, "body": body, "url": url or "/", "tag": tag}


def notify_push(user_id, payload):
    """Invia la notifica in un thread: la richiesta HTTP non resta in attesa."""
    if not user_id:
        return
    thread = threading.Thread(target=_push_worker, args=(user_id, payload), daemon=True)
    thread.start()


def _push_worker(user_id, payload):
    try:
        vapid = load_vapid()
        db = load_db()
        devices = push_subscriptions(find_user(db, uid=user_id))
        if not devices:
            return
        stale = []
        for device in list(devices):
            try:
                webpush.send(device, payload, vapid, ttl=86400)
            except webpush.PushError as exc:
                if exc.gone:
                    stale.append(device.get("endpoint"))
                log("Push non recapitata (%s): %s" % (device.get("endpoint", "?")[:40], exc), error=True)
            except Exception as exc:  # pragma: no cover - difensivo
                log("Push non inviata: %r" % exc, error=True)
        if stale:
            with DB_LOCK:
                db = load_db()
                user = find_user(db, uid=user_id)
                if user:
                    user["push"] = [s for s in (user.get("push") or [])
                                    if s.get("endpoint") not in stale]
                    save_db(db)
            log("Rimosse %d sottoscrizioni push scadute" % len(stale))
    except Exception as exc:  # pragma: no cover - difensivo
        log("Errore nelle notifiche push: %r" % exc, error=True)



# --------------------------------------------------------------------------
# Notifiche in-app
# --------------------------------------------------------------------------

def build_notifications(db, user):
    seen = parse_iso(user.get("seen_at")) or datetime(1970, 1, 1, tzinfo=timezone.utc)
    items = []
    if is_coordinator(user):
        for req in db["requests"]:
            if req.get("status") != "pending":
                continue
            created = parse_iso(req.get("created_at"))
            if not created or created <= seen:
                continue
            requester = find_user(db, uid=req["user_id"]) or {}
            items.append({
                "id": "c_" + req["id"],
                "request_id": req["id"],
                "title": "Nuova richiesta da %s" % requester.get("name", ""),
                "body": "%s · %s" % (TYPE_LABELS.get(req["type"], ""),
                                     fmt_dates([parse_day(d) for d in req["dates"]])),
                "at": req.get("created_at"),
                "unread": True,
                "kind": "pending",
            })
    for req in db["requests"]:
        if req["user_id"] != user["id"] or req.get("status") not in ("approved", "rejected"):
            continue
        decided = parse_iso(req.get("decided_at"))
        if not decided or decided <= seen:
            continue
        items.append({
            "id": "o_" + req["id"],
            "request_id": req["id"],
            "title": "Richiesta %s" % ("approvata" if req["status"] == "approved" else "rifiutata"),
            "body": fmt_dates([parse_day(d) for d in req["dates"]]),
            "at": req.get("decided_at"),
            "unread": True,
            "kind": "approved" if req["status"] == "approved" else "rejected",
        })
    items.sort(key=lambda item: item.get("at") or "", reverse=True)
    return items[:20]


# --------------------------------------------------------------------------
# Pagine HTML server-rendered
# --------------------------------------------------------------------------

PAGE_CSS = """
:root{--paper:#f4f1ea;--card:#fff;--ink:#1e2523;--muted:#7c8178;--line:#e6e0d4;--accent:#005f96;--danger:#a4483f}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
padding:24px 16px calc(32px + env(safe-area-inset-bottom));min-height:100vh}
.card{max-width:560px;margin:0 auto;background:var(--card);border:1px solid var(--line);border-radius:20px;overflow:hidden;
box-shadow:0 18px 40px -30px rgba(30,37,35,.5)}
.top{padding:28px 28px 0}
.brand{display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent)}
h1{font-size:24px;line-height:1.2;margin:14px 0 4px;letter-spacing:-.02em}
.sub{color:var(--muted);font-size:14px;margin:0}
.body{padding:20px 28px 28px}
table{width:100%;border-collapse:collapse;font-size:14.5px;margin:14px 0 22px}
td{padding:10px 0;border-bottom:1px solid #f1ece2;vertical-align:top}
td:first-child{color:var(--muted);width:44%}
td:last-child{font-weight:500}
.note{background:#f8f5ee;border-radius:12px;padding:14px 16px;font-size:14px;color:#4b544f;margin:0 0 18px;white-space:pre-wrap}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px}
button{font:inherit;font-weight:600;border:0;border-radius:999px;padding:13px 22px;cursor:pointer;min-height:46px}
.approve{background:var(--accent);color:#fff}
.reject{background:#fbeceb;color:var(--danger)}
.is-suggested{box-shadow:0 0 0 3px rgba(31,111,87,.28)}
textarea{width:100%;min-height:84px;border:1px solid var(--line);border-radius:12px;padding:12px 14px;font:inherit;font-size:14px;resize:vertical;background:#fffdf9}
label{display:block;font-size:13px;font-weight:600;color:var(--muted);margin:0 0 6px}
.status{display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;font-size:13.5px;font-weight:600;margin-bottom:16px}
.status.ok{background:#e8f3ec;color:#1f6f57}
.status.no{background:#fbeceb;color:#a4483f}
.status.wait{background:#fbf2e0;color:#8a6a1f}
.meta{margin-top:22px;font-size:12px;color:var(--muted);line-height:1.6}
a{color:var(--accent)}
@media(max-width:520px){.top{padding:22px 20px 0}.body{padding:16px 20px 24px}h1{font-size:21px}body{padding:12px 10px 24px}}
"""


def decision_page(db, req, coord, token, already=False, action=""):
    requester = find_user(db, uid=req["user_id"]) or {}
    days = sorted(parse_day(d) for d in req["dates"])
    period = fmt_dates(days)
    label = TYPE_LABELS.get(req["type"], "Richiesta")
    is_avail = req["type"] == "disponibilita"
    if is_avail:
        label += " · " + AVAIL_LABELS.get(req.get("availability"), "")
    if slot_detail(req):
        label += " · " + slot_detail(req)
    escaped_note = html.escape(req.get("note") or "")
    approve_word = "Ho letto" if is_avail else "Approva"
    reject_word = "Segnala da rivedere" if is_avail else "Rifiuta"
    outcome_meta = ("Confermando la lettura, la disponibilità compare nel calendario del team." if is_avail
                    else "Se approvi, i giorni compariranno nel calendario condiviso dell'app.")
    outcome_hint = ("riceverà una conferma di lettura" if is_avail else "riceverà subito un'email con l'esito")
    status = req.get("status")
    chips = [
        '<span class="status wait">%s</span>' % ("In attesa di lettura" if is_avail else "In attesa di decisione"),
        '<span class="status ok">%s</span>' % ("Letta" if is_avail else "Approvata"),
        '<span class="status no">%s</span>' % ("Da rivedere" if is_avail else "Rifiutata"),
    ]
    status_map = {"pending": chips[0], "approved": chips[1], "rejected": chips[2], "cancelled": chips[2]}
    head = status_map.get(status, chips[0])
    if already or status != "pending":
        result_note = html.escape(req.get("decision_note") or "")
        body = ('<div class="body">%s<table>'
                '<tr><td>Richiedente</td><td>%s</td></tr>'
                '<tr><td>Tipo</td><td>%s</td></tr>'
                '<tr><td>Periodo</td><td>%s</td></tr>'
                '<tr><td>Giorni</td><td>%d</td></tr>'
                '</table>%s<p class="sub">%s '
                'Puoi consultare il calendario dall\'app.</p>'
                '<div class="actions"><a href="/" style="display:inline-block;background:#005f96;color:#fff;'
                'text-decoration:none;font-weight:600;padding:13px 22px;border-radius:999px;">Apri il calendario</a></div>'
                '</div>'
                % (head, html.escape(requester.get("name", "")), html.escape(label), html.escape(period),
                   len(days), ('<p class="note">%s</p>' % result_note) if result_note else "",
                   "La comunicazione è già stata gestita." if is_avail else "La richiesta è già stata gestita."))
    else:
        note_input = ('<label for="note">Nota per %s (facoltativa)</label>'
                      '<textarea id="note" name="note" maxlength="500" placeholder="%s"></textarea>'
                      % (html.escape(requester.get("name", "").split()[0] if requester.get("name") else "il richiedente"),
                         "Es. letta" if is_avail else "Es. approvata, buone ferie"))
        template = ('<div class="body">%s<table>'
                    '<tr><td>Richiedente</td><td>%s</td></tr>'
                    '<tr><td>Ruolo</td><td>%s</td></tr>'
                    '<tr><td>Tipo</td><td>%s</td></tr>'
                    '<tr><td>Periodo</td><td>%s</td></tr>'
                    '<tr><td>Giorni</td><td>%d</td></tr>'
                    '</table>%s'
                    '<form method="POST" action="/decide/%s">'
                    '<input type="hidden" name="t" value="%s">%s'
                    '<div class="actions">'
                    '<button class="approve%s" name="decision" value="approve" type="submit">@APPROVA@</button>'
                    '<button class="reject%s" name="decision" value="reject" type="submit">@RIFIUTA@</button>'
                    '</div></form>'
                    '<p class="meta">%s @ESITO@. @META@</p></div>')
        template = (template.replace("@APPROVA@", approve_word)
                    .replace("@RIFIUTA@", reject_word)
                    .replace("@ESITO@", outcome_hint)
                    .replace("@META@", outcome_meta))
        body = (template
                % (head, html.escape(requester.get("name", "")), html.escape(requester.get("role", "").capitalize()),
                   html.escape(label), html.escape(period), len(days),
                   ('<p class="note">%s</p>' % escaped_note) if escaped_note else "",
                   html.escape(req["id"]), html.escape(token or ""), note_input,
                   " is-suggested" if action == "approve" else "",
                   " is-suggested" if action == "reject" else "",
                   html.escape(requester.get("name", "Il richiedente"))))
    locked = "" if verify_token(req["id"], token) else " · accesso come coordinatore"
    return ('<!doctype html><html lang="it"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
            '<title>Richiesta di %s</title><style>%s</style></head><body>'
            '<main class="card"><div class="top"><div class="brand"><span class="dot"></span>%s</div>'
            '<h1>%s</h1><p class="sub">%s%s</p></div>%s</main></body></html>'
            % (html.escape(requester.get("name", "")), PAGE_CSS, html.escape(ORG_NAME), html.escape(label),
               html.escape(period), html.escape(locked), body))


def error_page(status, message):
    return ('<!doctype html><html lang="it"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width,initial-scale=1">'
            '<title>%d</title><style>%s</style></head><body><main class="card">'
            '<div class="top"><div class="brand"><span class="dot"></span>%s</div>'
            '<h1>%s</h1><p class="sub">%s</p></div>'
            '<div class="body"><a href="/">Torna all\'app</a></div></main></body></html>'
            % (status, PAGE_CSS, html.escape(ORG_NAME), html.escape(_http_label(status)), html.escape(message)))


def _http_label(status):
    return {400: "Richiesta non valida", 403: "Accesso non consentito", 404: "Non trovato",
            409: "Richiesta già gestita", 429: "Troppi tentativi"}.get(status, "Si è verificato un errore")


# --------------------------------------------------------------------------
# Statistiche e promemoria
# --------------------------------------------------------------------------

def compute_stats(db):
    today = date.today()
    month_start = today.replace(day=1)
    if month_start.month == 12:
        next_month = date(month_start.year + 1, 1, 1)
    else:
        next_month = date(month_start.year, month_start.month + 1, 1)
    pending = 0
    approved_days_month = 0
    away_today = set()
    for req in db["requests"]:
        status = req.get("status")
        if status == "pending":
            pending += 1
            continue
        if status != "approved" or req.get("type") not in ("ferie", "permesso"):
            continue
        for value in req.get("dates", []):
            day = parse_day(value)
            if not day:
                continue
            if month_start <= day < next_month:
                approved_days_month += 1
            if day == today:
                away_today.add(req["user_id"])
    return {
        "pending": pending,
        "approved_days_month": approved_days_month,
        "away_today": len(away_today),
        "team": len(db["users"]),
        "month": AGENDA["mesi"][today.month - 1],
    }


def diagnostics_snapshot(db=None):
    """Fotografia dello stato del server per l'area dell'amministratore."""
    db = load_db() if db is None else db
    now = local_now()
    try:
        stat = DB_PATH.stat()
        db_bytes = stat.st_size
        db_modified = datetime.fromtimestamp(stat.st_mtime, now.tzinfo).isoformat(timespec="seconds")
    except OSError:
        db_bytes, db_modified = 0, None
    with LOG_LOCK:
        log_entries = list(LOG_BUFFER)
    statuses = {}
    for req in db.get("requests", []):
        status = req.get("status") or "sconosciuto"
        statuses[status] = statuses.get(status, 0) + 1
    provider = "resend" if RESEND_API_KEY and MAIL_FROM else (
        "smtp" if SMTP_HOST and MAIL_FROM else "demo")
    digest_settings = weekly_digest_settings(db)
    meta = db.get("meta") or {}
    outbox = db.get("outbox", [])
    return {
        "generated_at": now_iso(),
        "server": {
            "org": ORG_NAME,
            "local_time": now.isoformat(timespec="seconds"),
            "timezone": ORG_TZ,
            "started_at": datetime.fromtimestamp(STARTED_AT, now.tzinfo).isoformat(timespec="seconds"),
            "uptime_seconds": int(time.time() - STARTED_AT),
            "python": sys.version.split()[0],
            "pid": os.getpid(),
            "base_url": APP_BASE_URL or "",
        },
        "storage": {
            "data_dir": str(DATA_DIR),
            "database": str(DB_PATH),
            "database_bytes": db_bytes,
            "database_modified": db_modified,
            "avatar_files": len(list(AVATAR_DIR.glob("*"))) if AVATAR_DIR.exists() else 0,
            "outbox_files": len(list(OUTBOX_DIR.glob("*.html"))) if OUTBOX_DIR.exists() else 0,
        },
        "counts": {
            "users": len(db.get("users", [])),
            "coordinators": len(coordinators(db)),
            "requests": len(db.get("requests", [])),
            "requests_by_status": statuses,
            "outbox": len(outbox),
            "push_subscriptions": len(db.get("push", [])),
        },
        "email": {
            "configured": email_configured(),
            "provider": provider,
            "from": MAIL_FROM,
            "from_name": MAIL_FROM_NAME,
            "reply_to": MAIL_REPLY_TO,
            "reminder_hours": REMINDER_HOURS,
            "weekly_digest": {
                "enabled": bool(WEEKLY_DIGEST and email_configured()),
                "weekday": digest_settings["weekday"],
                "weekday_label": AGENDA["giorni"][digest_settings["weekday"]],
                "hour": digest_settings["hour"],
                "last_week": meta.get("weekly_digest_week"),
                "last_sent_at": meta.get("weekly_digest_sent_at"),
            },
        },
        "push": {
            "vapid": VAPID_PATH.exists(),
            "subscriptions": len(db.get("push", [])),
            "subject": VAPID_SUBJECT,
        },
        "logs": log_entries[-120:],
        "errors": [entry for entry in log_entries if entry["level"] == "error"][-30:],
        "outbox_recent": [{"id": m.get("id"), "to": m.get("to"), "subject": m.get("subject"),
                           "created_at": m.get("created_at"), "provider": m.get("provider"),
                           "error": m.get("error")} for m in outbox[:20]],
    }


def run_reminders():
    """Invia un solo promemoria per ogni richiesta rimasta in attesa."""
    if not email_configured() or REMINDER_HOURS <= 0:
        return 0
    db = load_db()
    now = datetime.now(timezone.utc)
    due = []
    for req in db["requests"]:
        if req.get("status") != "pending" or req.get("reminded_at"):
            continue
        created = parse_iso(req.get("created_at"))
        if not created:
            continue
        hours = (now - created).total_seconds() / 3600.0
        if hours >= REMINDER_HOURS:
            due.append((req["id"], hours))
    if not due:
        return 0
    app_url = APP_BASE_URL or "http://localhost:%d" % PORT
    sent = 0
    for request_id, hours in due:
        requester = None
        req = None
        for item in db["requests"]:
            if item["id"] == request_id:
                req = dict(item)
                requester = find_user(db, uid=item["user_id"])
                break
        if not req or not requester:
            continue
        decide_url = "%s/decide/%s?t=%s" % (app_url, request_id, quote(signed_token(request_id)))
        subject, body, text = reminder_email(requester, req, decide_url, app_url, hours)
        for coord in coordinators(db):
            send_mail(coord["email"], subject, body, text, reply_to=requester["email"],
                      idempotency_key="reminder-%s-%s" % (request_id, coord["id"]))
        with DB_LOCK:
            fresh = load_db()
            for item in fresh["requests"]:
                if item["id"] == request_id and item.get("status") == "pending":
                    item["reminded_at"] = now_iso()
            save_db(fresh)
        sent += 1
    if sent:
        log("Inviati %d promemoria per richieste in attesa" % sent)
    return sent


def reminder_loop(stop_event):
    while not stop_event.wait(900):
        try:
            run_reminders()
        except Exception as exc:  # pragma: no cover - difensivo
            log("Promemoria non inviati: %r" % exc, error=True)


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------

def cli_adduser(args):
    db = load_db()
    email = args.email.strip().lower()
    if not valid_email(email):
        print("L'email non è valida")
        return 1
    if find_user(db, email=email):
        print("Esiste già un utente con questa email")
        return 1
    if args.role not in ROLES:
        print("Il ruolo non è valido: usa %s" % ", ".join(ROLES))
        return 1
    if not re.match(r"^\d{4,8}$", args.pin):
        print("Il PIN deve avere da 4 a 8 cifre")
        return 1
    salt, digest = hash_pin(args.pin)
    user = {
        "id": new_id("u_"), "name": args.name.strip(), "email": email, "role": args.role,
        "salt": salt, "pin_hash": digest,
        "color": pick_color(db),
        "created_at": now_iso(), "seen_at": None,
    }
    db["users"].append(user)
    db["seeded"] = False
    save_db(db)
    print("Aggiunto %s <%s> (%s) con colore %s" % (user["name"], user["email"], user["role"], user["color"]))
    return 0


def cli_listusers(_args):
    db = load_db()
    if not db["users"]:
        print("Nessun utente configurato.")
        return 0
    for user in db["users"]:
        print("%-24s %-30s %s" % (user["name"], user["email"], user["role"]))
    return 0


def cli_setpin(args):
    db = load_db()
    user = find_user(db, email=args.email)
    if not user:
        print("Utente non trovato")
        return 1
    if not re.match(r"^\d{4,8}$", args.pin):
        print("Il PIN deve avere da 4 a 8 cifre")
        return 1
    user["salt"], user["pin_hash"] = hash_pin(args.pin)
    db["seeded"] = False
    save_db(db)
    print("PIN aggiornato per %s" % user["email"])
    return 0


def cli_removeuser(args):
    db = load_db()
    user = find_user(db, email=args.email)
    if not user:
        print("Utente non trovato")
        return 1
    db["users"] = [u for u in db["users"] if u["id"] != user["id"]]
    save_db(db)
    remove_avatar(user.get("avatar"))
    print("Utente rimosso. Le sue richieste restano nello storico.")
    return 0


def lan_addresses():
    found = set()
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            found.add(probe.getsockname()[0])
        finally:
            probe.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                found.add(ip)
    except OSError:
        pass
    return sorted(found)


def serve(args):
    global HOST, PORT, ORG_NAME
    if args.port:
        PORT = args.port
    if args.host:
        HOST = args.host
    if getattr(args, "lan", False):
        HOST = "0.0.0.0"
    if args.org:
        ORG_NAME = args.org
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    url = "http://localhost:%d" % PORT if HOST in ("127.0.0.1", "0.0.0.0") else "http://%s:%d" % (HOST, PORT)
    print("\n  %s — Ferie & Disponibilità" % ORG_NAME)
    print("  In ascolto su %s" % url)
    if HOST in ("0.0.0.0", "::"):
        addresses = lan_addresses()
        print("  Dal telefono (stessa rete Wi-Fi):")
        if addresses:
            for address in addresses:
                print("    http://%s:%d" % (address, PORT))
        else:
            print("    http://IP-DEL-COMPUTER:%d" % PORT)
        print("  Se non si apre, controlla il firewall del computer.")
    else:
        print("  Per aprirla dal telefono: python3 server.py --lan")
    print("  Email: %s" % ("configurata" if email_configured() else "modalità simulata (vedi README)"))
    if email_configured() and REMINDER_HOURS > 0:
        stop_reminders = threading.Event()
        threading.Thread(target=reminder_loop, args=(stop_reminders,), daemon=True,
                         name="promemoria").start()
        print("  Promemoria: dopo %d %s di attesa" % (REMINDER_HOURS, "ora" if REMINDER_HOURS == 1 else "ore"))
    if WEEKLY_DIGEST and email_configured():
        stop_digest = threading.Event()
        digest_settings = weekly_digest_settings()
        threading.Thread(target=digest_loop, args=(stop_digest,), daemon=True,
                         name="riepilogo").start()
        print("  Riepilogo settimanale: %s dalle %02d:00 (%s)"
              % (AGENDA["giorni"][digest_settings["weekday"]], digest_settings["hour"], ORG_TZ))
    print("  Interrompi con Ctrl+C\n")
    if not args.no_open and HOST in ("127.0.0.1", "localhost"):
        try:
            threading.Timer(0.6, lambda: webbrowser.open(url)).start()
        except Exception:
            pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer arrestato.")
    finally:
        server.server_close()
    return 0


def main(argv=None):
    argv = argv if argv is not None else sys.argv[1:]
    parser = argparse.ArgumentParser(description="Ferie & Disponibilità — server locale")
    subparsers = parser.add_subparsers(dest="command")

    p_serve = subparsers.add_parser("serve", help="avvia il server (predefinito)")
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.add_argument("--host", default=None)
    p_serve.add_argument("--lan", action="store_true", help="rendi l'app raggiungibile dal telefono sulla rete locale")
    p_serve.add_argument("--org", default=None)
    p_serve.add_argument("--no-open", action="store_true")
    p_serve.set_defaults(func=serve)

    p_add = subparsers.add_parser("adduser", help="aggiungi un utente")
    p_add.add_argument("--name", required=True)
    p_add.add_argument("--email", required=True)
    p_add.add_argument("--role", default=ROLE_EMPLOYEE, choices=ROLES)
    p_add.add_argument("--pin", required=True)
    p_add.set_defaults(func=cli_adduser)

    p_list = subparsers.add_parser("listusers", help="elenca gli utenti")
    p_list.set_defaults(func=cli_listusers)

    p_pin = subparsers.add_parser("setpin", help="cambia il PIN")
    p_pin.add_argument("--email", required=True)
    p_pin.add_argument("--pin", required=True)
    p_pin.set_defaults(func=cli_setpin)

    p_rm = subparsers.add_parser("removeuser", help="rimuovi un utente")
    p_rm.add_argument("--email", required=True)
    p_rm.set_defaults(func=cli_removeuser)

    if not argv or argv[0].startswith("-") and argv[0] not in ("-h", "--help"):
        args = p_serve.parse_args(argv)
        if not getattr(args, "func", None):
            args.func = serve
    else:
        args = parser.parse_args(argv)
        if not getattr(args, "func", None):
            parser.print_help()
            return 0
    if args.func is serve:
        for attr, default in (("port", None), ("host", None), ("org", None), ("no_open", False), ("lan", False)):
            if not hasattr(args, attr):
                setattr(args, attr, default)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
