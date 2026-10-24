// Configurazione del Worker: variabili pubbliche (wrangler.jsonc) e segreti.
// Le stesse variabili del server Python, così il passaggio non cambia nulla
// per chi amministra l'app.

import { cleanText } from "./util.js";

function integer(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function list(value) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
}

export function config(env, url) {
  const baseUrl = (env.APP_BASE_URL || (url ? url.origin : "")).replace(/\/$/, "");
  return {
    orgName: env.ORG_NAME || "Synlab Manifattura Firenze",
    orgShort: env.ORG_SHORT || "Synlab",
    orgSite: env.ORG_SITE || "Manifattura Firenze",
    orgBrand: env.ORG_BRAND || "SYNLAB",
    baseUrl,
    timezone: env.TZ || "Europe/Rome",
    sessionSecret: env.SESSION_SECRET || "",
    mailFrom: (env.MAIL_FROM || "").trim(),
    mailFromName: (env.MAIL_FROM_NAME || "Synlab Manifattura Firenze").trim(),
    mailReplyTo: (env.MAIL_REPLY_TO || "").trim(),
    resendKey: (env.RESEND_API_KEY || "").trim(),
    mailjetKey: (env.MAILJET_API_KEY || "").trim(),
    mailjetSecret: (env.MAILJET_SECRET_KEY || "").trim(),
    reminderHours: integer(env.REMINDER_HOURS, 24, 0, 720),
    weeklyDigest: !["0", "false", "no"].includes(String(env.WEEKLY_DIGEST ?? "1").toLowerCase()),
    digestWeekday: integer(env.WEEKLY_DIGEST_WEEKDAY, 3, 0, 6),
    digestHour: integer(env.WEEKLY_DIGEST_HOUR, 8, 0, 23),
    coordinatorEmails: list(env.COORDINATOR_EMAILS),
    adminEmails: list(env.ADMIN_EMAILS),
    vapidPublicKey: (env.VAPID_PUBLIC_KEY || "").trim(),
    vapidPrivateJwk: (env.VAPID_PRIVATE_JWK || "").trim(),
    vapidSubject: (env.VAPID_SUBJECT || "").trim() || `mailto:${(env.MAIL_FROM || "ferie@localhost").trim()}`,
  };
}

const LOCAL_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "UTC",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hour12: false,
  weekday: "short",
});

/** Data e ora locali dell'organizzazione (il Worker gira in UTC). */
export function localNow(cfg, when = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: cfg.timezone || "Europe/Rome",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  }).formatToParts(when);
  const get = (type) => {
    const part = parts.find((item) => item.type === type);
    return part ? part.value : "";
  };
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour") === "24" ? "0" : get("hour"));
  const names = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    date: new Date(Date.UTC(year, month - 1, day)),
    year,
    month,
    day,
    hour,
    weekday: names[get("weekday")] ?? 0,
    iso: `${get("year")}-${get("month")}-${get("day")}T${String(hour).padStart(2, "0")}:${get("minute")}:00`,
  };
}

/** Il giorno scelto dal coordinatore, altrimenti quello delle variabili. */
export function digestSettings(state, cfg) {
  const stored = Number.parseInt(state.meta.weekly_digest_weekday, 10);
  const weekday = Number.isFinite(stored) && stored >= 0 && stored <= 6 ? stored : cfg.digestWeekday;
  return { weekday, hour: cfg.digestHour };
}

export function clean(value, limit) {
  return cleanText(value, limit);
}
