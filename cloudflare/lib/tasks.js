// Lavori periodici: riepilogo settimanale delle assenze e promemoria per le
// richieste ancora in attesa. Li avvia il Cron Trigger del Worker, oppure il
// coordinatore dal pannello ("Invia adesso").

import { addLog, loadState, saveMeta, saveRequest } from "./store.js";
import { localNow, digestSettings } from "./config.js";
import { emailConfigured, reminderEmail, sendMail, weeklyDigestEmail } from "./mail.js";
import { signedToken } from "./auth.js";
import { addDays, findUser, isoDay, nowIso, parseDay, parseIso, weekdayIndex } from "./util.js";

/** Lunedì e domenica della settimana successiva. */
export function nextWeekBounds(localDate) {
  const monday = addDays(localDate, 7 - weekdayIndex(localDate));
  return [monday, addDays(monday, 6)];
}

/** Assenze approvate (ferie e permessi) raggruppate per giorno. */
export function weeklyAbsences(state, start, end) {
  const grouped = new Map();
  for (const req of state.requests) {
    if (req.status !== "approved" || !["ferie", "permesso"].includes(req.type)) continue;
    const requester = findUser(state.users, req.user_id);
    if (!requester) continue;
    for (const value of req.dates || []) {
      const day = parseDay(value);
      if (!day || day < start || day > end) continue;
      const key = isoDay(day);
      if (!grouped.has(key)) grouped.set(key, new Map());
      grouped.get(key).set(requester.id, [requester, req]);
    }
  }
  return [...grouped.keys()].sort().map((key) => ({
    day: parseDay(key),
    entries: [...grouped.get(key).values()]
      .sort((a, b) => String(a[0].name).toLowerCase().localeCompare(String(b[0].name).toLowerCase())),
  }));
}

/** Invia il riepilogo ai coordinatori. Non decide se è il momento giusto. */
export async function deliverWeeklyDigest(env, cfg, state, when, force = false) {
  const [start, end] = nextWeekBounds(when.date);
  const rows = weeklyAbsences(state, start, end);
  const total = rows.reduce((sum, row) => sum + row.entries.length, 0);
  const recipients = state.users.filter((user) => user.role === "coordinatore"
    || cfg.coordinatorEmails.includes(String(user.email).toLowerCase()));
  const result = {
    week_start: isoDay(start), week_end: isoDay(end), absences: total,
    sent: 0, recipients: [], subject: "", errors: [], skipped: "",
  };
  if (!rows.length && !force) {
    result.skipped = "nessuna assenza la settimana prossima";
    return result;
  }
  if (!recipients.length) {
    result.skipped = "nessun coordinatore configurato";
    return result;
  }
  const { subject, html, text } = weeklyDigestEmail(cfg, rows, start, end, cfg.baseUrl);
  result.subject = subject;
  for (const coord of recipients) {
    const key = force ? `digest-${Date.now()}-${coord.id}` : `digest-${isoDay(start)}-${coord.id}`;
    const mail = await sendMail(env, cfg, {
      to: coord.email, subject, html, text, replyTo: cfg.mailReplyTo || null, idempotencyKey: key,
    });
    if (mail.error) {
      result.errors.push(`${coord.email} (${mail.error})`);
      continue;
    }
    result.recipients.push(coord.email);
    result.sent += 1;
  }
  return result;
}

export function weeklyDigestDue(cfg, state, now) {
  if (!(cfg.weeklyDigest && emailConfigured(cfg))) return false;
  const settings = digestSettings(state, cfg);
  if (now.weekday < settings.weekday) return false;
  if (now.weekday === settings.weekday && now.hour < settings.hour) return false;
  const sentWeek = state.meta.weekly_digest_week;
  return sentWeek !== isoDay(nextWeekBounds(now.date)[0]);
}

export async function runWeeklyDigest(env, cfg, { force = false } = {}) {
  const state = await loadState(env);
  const now = localNow(cfg);
  if (!force && !weeklyDigestDue(cfg, state, now)) {
    return { sent: 0, skipped: "non è il momento del riepilogo", absences: 0, recipients: [], errors: [] };
  }
  const result = await deliverWeeklyDigest(env, cfg, state, now, force);
  if (result.sent) {
    await saveMeta(env, {
      weekly_digest_week: result.week_start,
      weekly_digest_sent_at: nowIso(),
    });
    await addLog(env, "info", `Riepilogo settimanale inviato a ${result.sent} ${result.sent === 1 ? "coordinatore" : "coordinatori"} (${result.absences} ${result.absences === 1 ? "assenza" : "assenze"})`);
  } else if (result.skipped) {
    await addLog(env, "info", `Riepilogo settimanale non inviato: ${result.skipped}`);
  }
  return result;
}

/** Un solo promemoria per ogni richiesta rimasta in attesa. */
export async function runReminders(env, cfg, state) {
  if (!emailConfigured(cfg) || cfg.reminderHours <= 0) return 0;
  const now = new Date();
  const due = [];
  for (const req of state.requests) {
    if (req.status !== "pending" || req.reminded_at) continue;
    const created = parseIso(req.created_at);
    if (!created) continue;
    const hours = (now - created) / 3600000;
    if (hours >= cfg.reminderHours) due.push([req, hours]);
  }
  if (!due.length) return 0;
  let sent = 0;
  for (const [req, hours] of due) {
    const requester = findUser(state.users, req.user_id);
    if (!requester) continue;
    const decideUrl = `${cfg.baseUrl}/decide/${req.id}?t=${encodeURIComponent(await signedToken(cfg.sessionSecret, req.id))}`;
    const { subject, html, text } = reminderEmail(cfg, requester, req, decideUrl, cfg.baseUrl, hours);
    const coordinators = state.users.filter((user) => user.role === "coordinatore"
      || cfg.coordinatorEmails.includes(String(user.email).toLowerCase()));
    for (const coord of coordinators) {
      await sendMail(env, cfg, {
        to: coord.email, subject, html, text, replyTo: requester.email || null,
        idempotencyKey: `reminder-${req.id}-${coord.id}`,
      });
    }
    const fresh = state.requests.find((item) => item.id === req.id);
    if (fresh && fresh.status === "pending") {
      fresh.reminded_at = nowIso();
      await saveRequest(env, fresh);
    }
    sent += 1;
  }
  if (sent) await addLog(env, "info", `Inviati ${sent} promemoria per richieste in attesa`);
  return sent;
}

