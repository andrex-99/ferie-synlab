// Funzioni pure condivise da tutta l'app: date in italiano, etichette,
// serializzazione delle richieste. Sono la trasposizione di quelle in server.py,
// senza dipendenze: così il comportamento del frontend resta identico.

export const WEEKDAYS = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
export const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
  "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];

export const ROLE_EMPLOYEE = "dipendente";
export const ROLE_FREELANCE = "professionista";
export const ROLE_COORD = "coordinatore";
export const ROLE_ADMIN = "admin";
export const ROLES = [ROLE_EMPLOYEE, ROLE_FREELANCE, ROLE_COORD, ROLE_ADMIN];

export const COLORS = [
  "#2f7d63", "#3b6fd4", "#b56a2a", "#7a59c4", "#b0466b", "#2b8a9c",
  "#8a7a20", "#5c6b76", "#a4483f", "#3f7fa8", "#6b8f2a", "#8f5f8f",
];

export const TYPE_LABELS = { ferie: "Ferie", permesso: "Permesso", disponibilita: "Disponibilità" };
export const AVAIL_LABELS = { non_disponibile: "Non disponibile", disponibile: "Disponibile" };
export const SLOT_CUSTOM = "orario";
export const SLOT_LABELS = {
  giornata: "Giornata intera", mattina: "Mattina", pomeriggio: "Pomeriggio",
  [SLOT_CUSTOM]: "Orario personalizzato",
};

export const MAX_SESSION_DAYS = 30;
export const AVATAR_MAX_BYTES = 70_000;

export function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export function escapeAttr(value) {
  return escapeHtml(value);
}

/** Testo ripulito come in server.py: solo stringhe, spazi ai bordi, limite. */
export function cleanText(value, limit = 500) {
  if (typeof value !== "string") return "";
  return value.replace(/\r\n/g, "\n").trim().slice(0, limit);
}

export function validEmail(value) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value || "");
}

export function newId(prefix = "") {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (const byte of bytes) out += alphabet[byte % alphabet.length];
  return prefix + out;
}

export function nowIso(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/Z$/, "+00:00");
}

export function parseIso(value) {
  if (!value) return null;
  const date = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(date.getTime()) ? null : date;
}

/* --------------------------------- date --------------------------------- */

export function parseDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

export function isoDay(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return value.toISOString().slice(0, 10);
}

export function todayUtc() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

export function weekdayIndex(date) {
  return (date.getUTCDay() + 6) % 7;
}

export function fmtDay(value) {
  return `${WEEKDAYS[weekdayIndex(value)]} ${value.getUTCDate()} ${MONTHS[value.getUTCMonth()]} ${value.getUTCFullYear()}`;
}

export function fmtRange(start, end) {
  if (isoDay(start) === isoDay(end)) return fmtDay(start);
  if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
    return `${WEEKDAYS[weekdayIndex(start)]} ${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  }
  return `${fmtDay(start)} – ${fmtDay(end)}`;
}

export function groupDayRuns(days) {
  const sorted = [...new Set(days.filter(Boolean).map(isoDay))].sort();
  const runs = [];
  for (const iso of sorted) {
    const last = runs[runs.length - 1];
    if (last && iso === isoDay(addDays(parseDay(last[1]), 1))) last[1] = iso;
    else runs.push([iso, iso]);
  }
  return runs;
}

/** Periodo leggibile anche con giorni non consecutivi: “3–5 nov e 10 nov”. */
export function fmtDates(days) {
  const runs = groupDayRuns(days).map(([start, end]) => fmtRange(parseDay(start), parseDay(end)));
  if (!runs.length) return "";
  if (runs.length === 1) return runs[0];
  return runs.slice(0, -1).join(", ") + " e " + runs[runs.length - 1];
}

export function normalizeTime(value) {
  const match = /^(\d{1,2}):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour > 23) return null;
  return `${String(hour).padStart(2, "0")}:${match[2]}`;
}

export function slotDisplay(req) {
  if (req.slot === SLOT_CUSTOM) {
    const start = normalizeTime(req.time_from);
    const end = normalizeTime(req.time_to);
    if (start && end) return `${start}–${end}`;
  }
  return SLOT_LABELS[req.slot || ""] || "";
}

/** Fascia da mostrare accanto al periodo, quando non è la giornata intera. */
export function slotDetail(req) {
  if (!req.slot || req.slot === "giornata") return "";
  return slotDisplay(req);
}

export function normalizeBirthday(value) {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(String(value || "").trim());
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const probe = new Date(Date.UTC(2000, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Il compleanno in un dato anno; il 29 febbraio cade il 28 negli anni non bisestili. */
export function birthdayOn(year, birthday) {
  const [month, day] = birthday.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return new Date(Date.UTC(year, 1, 28));
  return date;
}

export function birthdaysInRange(users, start, end) {
  const found = [];
  for (const user of users) {
    const birthday = normalizeBirthday(user.birthday);
    if (!birthday) continue;
    for (const year of new Set([start.getUTCFullYear(), end.getUTCFullYear()])) {
      const day = birthdayOn(year, birthday);
      if (day >= start && day <= end) {
        found.push({
          date: isoDay(day), user_id: user.id, user_name: user.name,
          user_color: user.color || COLORS[0], day_month: birthday,
        });
      }
    }
  }
  found.sort((a, b) => (a.date + a.user_name.toLowerCase()).localeCompare(b.date + b.user_name.toLowerCase()));
  return found;
}

/* ------------------------------- permessi ------------------------------- */

export function isCoordinator(user, cfg) {
  if (!user) return false;
  const email = String(user.email || "").toLowerCase();
  return user.role === ROLE_COORD || (cfg && cfg.coordinatorEmails.includes(email));
}

export function isAdmin(user, cfg) {
  if (!user) return false;
  const email = String(user.email || "").toLowerCase();
  return user.role === ROLE_ADMIN || (cfg && cfg.adminEmails.includes(email));
}

/** Tipi di richiesta ammessi per ruolo (l'amministratore è un account tecnico). */
export function allowedTypes(user) {
  const role = (user || {}).role;
  if (role === ROLE_ADMIN) return [];
  if (role === ROLE_FREELANCE) return ["disponibilita"];
  return ["ferie", "permesso"];
}

export function avatarUrl(user) {
  return user && user.avatar ? `/avatar/${user.avatar}` : null;
}

export function publicUser(user, cfg) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    color: user.color || COLORS[0],
    birthday: user.birthday || null,
    admin: isAdmin(user, cfg),
    avatar: avatarUrl(user),
    initials: String(user.name || "").split(/\s+/).slice(0, 2).map((part) => part[0] || "").join("").toUpperCase(),
  };
}

/** Sceglie il colore meno usato, così le persone restano distinguibili. */
export function pickColor(users, excludeId = null) {
  const counts = Object.fromEntries(COLORS.map((color) => [color, 0]));
  for (const user of users) {
    if (user.id === excludeId) continue;
    const color = user.color;
    if (color in counts) counts[color] += 1;
  }
  return COLORS.reduce((best, color) => (counts[color] < counts[best] ? color : best), COLORS[0]);
}

export function findUser(users, uid = null, email = null) {
  for (const user of users) {
    if (uid && user.id === uid) return user;
    if (email && String(user.email).toLowerCase() === String(email).toLowerCase()) return user;
  }
  return null;
}

export function coordinators(users, cfg) {
  return users.filter((user) => isCoordinator(user, cfg));
}

export function requestDayList(req) {
  return (req.dates || []).map(parseDay).filter(Boolean);
}

export function serializeRequest(users, req) {
  const user = findUser(users, req.user_id) || {};
  const decider = req.decided_by ? findUser(users, req.decided_by) : null;
  const days = requestDayList(req).sort((a, b) => a - b);
  const start = days[0] || null;
  const end = days[days.length - 1] || null;
  return {
    id: req.id,
    user_id: req.user_id,
    user_name: user.name || "Utente rimosso",
    user_color: user.color || COLORS[0],
    user_avatar: avatarUrl(user),
    type: req.type || "ferie",
    availability: req.availability || null,
    slot: req.slot || null,
    slot_label: slotDisplay(req),
    time_from: req.time_from || null,
    time_to: req.time_to || null,
    dates: req.dates || [],
    start: isoDay(start),
    end: isoDay(end),
    days: days.length,
    range_label: days.length ? fmtDates(days) : "",
    note: req.note || "",
    status: req.status || "pending",
    created_at: req.created_at || null,
    decided_at: req.decided_at || null,
    decided_by_name: decider ? decider.name : null,
    decision_note: req.decision_note || "",
    reopenable: req.status === "approved" || req.status === "rejected",
    label: TYPE_LABELS[req.type] || "Richiesta",
    availability_label: AVAIL_LABELS[req.availability || ""] || null,
  };
}

export function overlapsAny(req, dates) {
  const own = new Set(req.dates || []);
  return dates.some((day) => own.has(day));
}

/** Statistiche della schermata coordinatore: mese corrente, in attesa, assenti oggi. */
export function computeStats(users, requests, today) {
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));
  let pending = 0;
  let approvedDaysMonth = 0;
  const awayToday = new Set();
  for (const req of requests) {
    const status = req.status;
    if (status === "pending") {
      pending += 1;
      continue;
    }
    if (status !== "approved" || !["ferie", "permesso"].includes(req.type)) continue;
    for (const value of req.dates || []) {
      const day = parseDay(value);
      if (!day) continue;
      if (day >= monthStart && day < nextMonth) approvedDaysMonth += 1;
      if (isoDay(day) === isoDay(today)) awayToday.add(req.user_id);
    }
  }
  return {
    pending,
    approved_days_month: approvedDaysMonth,
    away_today: awayToday.size,
    team: users.length,
    month: MONTHS[today.getUTCMonth()],
  };
}

/* ------------------------------ iCalendar ------------------------------ */

export function icsEscape(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

/** Spezza le righe a 75 ottetti senza rompere i caratteri UTF-8. */
export function foldIcs(text) {
  const out = [];
  for (const line of text.split("\r\n")) {
    let limit = 73;
    let chunk = "";
    let size = 0;
    let first = true;
    for (const char of line) {
      const width = new TextEncoder().encode(char).length;
      if (size + width > limit) {
        out.push((first ? "" : " ") + chunk);
        first = false;
        chunk = "";
        size = 0;
        limit = 72;
      }
      chunk += char;
      size += width;
    }
    out.push((first ? "" : " ") + chunk);
  }
  return out.join("\r\n");
}

export function icsStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function icsDate(value) {
  return value.toISOString().slice(0, 10).replace(/-/g, "");
}

/** Evento calendario di una richiesta approvata, un VEVENT per periodo continuo. */
export function requestIcs(req, user, stamp = icsStamp()) {
  const days = requestDayList(req).sort((a, b) => a - b);
  if (!days.length) return "";
  let title = TYPE_LABELS[req.type] || "Richiesta";
  if (req.type === "disponibilita") title = "Disponibilità: " + (AVAIL_LABELS[req.availability] || "");
  if (slotDetail(req)) title += " · " + slotDetail(req);
  const summary = `${title} — ${(user && user.name) || ""}`;
  const description = String(req.note || "").replace(/\n/g, "\\n");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ferie e Disponibilita//IT",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
  ];
  const runs = groupDayRuns(days);
  runs.forEach(([start, end], index) => {
    const uid = runs.length === 1 ? req.id : `${req.id}-${index + 1}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${uid}@ferie-disponibilita`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start.replace(/-/g, "")}`,
      `DTEND;VALUE=DATE:${icsDate(addDays(parseDay(end), 1))}`,
      `SUMMARY:${icsEscape(summary)}`,
      `DESCRIPTION:${description}`,
      "STATUS:CONFIRMED",
      "END:VEVENT",
    );
  });
  lines.push("END:VCALENDAR");
  return foldIcs(lines.join("\r\n") + "\r\n");
}

/** Feed ICS completo: tutte le assenze approvate, con token nell'URL. */
export function feedIcs(orgName, users, requests, stamp = icsStamp()) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ferie e Disponibilita//IT",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(orgName + " — ferie e disponibilità")}`,
  ];
  for (const req of requests) {
    if (req.status !== "approved") continue;
    const user = findUser(users, req.user_id);
    if (!user) continue;
    const days = requestDayList(req).sort((a, b) => a - b);
    if (!days.length) continue;
    let label = "Ferie";
    if (req.type === "permesso") label = "Permesso" + (req.slot ? " · " + slotDisplay(req) : "");
    else if (req.type === "disponibilita") label = "Disponibilità: " + (AVAIL_LABELS[req.availability] || "");
    if (slotDetail(req)) label += " · " + slotDetail(req);
    groupDayRuns(days).forEach(([start, end], index, runs) => {
      const uid = runs.length === 1 ? req.id : `${req.id}-${index + 1}`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}@ferie-disponibilita`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${start.replace(/-/g, "")}`,
        `DTEND;VALUE=DATE:${icsDate(addDays(parseDay(end), 1))}`,
        `SUMMARY:${icsEscape(`${label} — ${user.name}`)}`,
        `DESCRIPTION:${icsEscape(req.note || "")}`,
        "STATUS:CONFIRMED",
        "END:VEVENT",
      );
    });
  }
  lines.push("END:VCALENDAR");
  return foldIcs(lines.join("\r\n") + "\r\n");
}
