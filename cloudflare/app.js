/**
 * Ferie e disponibilità — applicazione completa su Cloudflare Workers + D1.
 *
 * Sostituisce il server Python: gli asset di `public/` sono serviti da ASSETS,
 * le API vivono qui e i dati stanno in D1 (persistenti, con backup e replica
 * gestiti da Cloudflare). Non c'è nessun processo esterno da mantenere acceso.
 *
 *   npx wrangler dev --config wrangler.jsonc
 *   npx wrangler deploy
 */

import {
  AVAIL_LABELS, COLORS, ROLES, ROLE_COORD, SLOT_CUSTOM, SLOT_LABELS, TYPE_LABELS,
  allowedTypes, avatarUrl, birthdaysInRange, cleanText, computeStats, coordinators,
  escapeHtml, feedIcs, findUser, fmtDates, groupDayRuns, isAdmin, isCoordinator, isoDay,
  newId, normalizeBirthday, normalizeTime, nowIso, overlapsAny, parseDay, parseIso,
  pickColor, publicUser, requestDayList, requestIcs, serializeRequest, slotDetail, todayUtc,
  validEmail,
} from "./lib/util.js";
import {
  clearLoginFailures, countPushSubscriptions, deleteAvatar, deleteUser, getAvatar,
  getOutboxItem, listLogs, listOutbox, loadState, loginBlocked,
  pushSubscriptions, registerLoginFailure, removePushSubscription, saveAvatar,
  saveMeta, savePushSubscription, saveRequest, saveUser, seedDemoUsers,
  addLog,
} from "./lib/store.js";
import {
  hashPin, icsFeedToken, isSameOrigin, makeSession, parseCookies, readSession,
  sessionCookie, signedToken, verifyPin, verifyToken,
} from "./lib/auth.js";
import { config, digestSettings, localNow } from "./lib/config.js";
import {
  emailConfigured, emailProvider, outcomeEmail, coordinatorEmail, sendMail, testEmail,
} from "./lib/mail.js";
import { decisionPage, errorPage } from "./lib/pages.js";
import { deliverWeeklyDigest, runReminders, runWeeklyDigest } from "./lib/tasks.js";
import { notifyPush, pushConfigured } from "./lib/push.js";

const STARTED_AT = new Date();
const DECISION_MAX_DAYS = 30;

class ApiError extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/* ------------------------------- risposte ------------------------------- */

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY_HEADERS, ...headers },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; script-src 'none'; base-uri 'none'",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

function bytesResponse(bytes, contentType, headers = {}) {
  return new Response(bytes, {
    status: 200,
    headers: { "Content-Type": contentType, ...SECURITY_HEADERS, ...headers },
  });
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  if (text.length > 100_000) throw new ApiError(413, "La richiesta è troppo grande");
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("not an object");
    return data;
  } catch (_error) {
    throw new ApiError(400, "I dati non sono validi");
  }
}

async function readForm(request) {
  const text = await request.text();
  return Object.fromEntries(new URLSearchParams(text));
}

function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* -------------------------------- contesto ------------------------------- */

async function sessionUser(env, cfg, request, state) {
  const cookie = parseCookies(request).sess;
  if (!cookie) return null;
  return readSession(cfg.sessionSecret, state.users, cookie);
}

function requireUser(user) {
  if (!user) throw new ApiError(401, "Sessione scaduta. Accedi di nuovo.");
  return user;
}

function requireCoordinator(user, cfg) {
  requireUser(user);
  if (!isCoordinator(user, cfg)) throw new ApiError(403, "Questa azione è riservata al coordinatore.");
  return user;
}

function requireAdmin(user, cfg) {
  requireUser(user);
  if (!isAdmin(user, cfg)) throw new ApiError(403, "Questa sezione è riservata all'amministratore.");
  return user;
}

function requireStaff(user, cfg) {
  requireUser(user);
  if (!isCoordinator(user, cfg) && !isAdmin(user, cfg)) {
    throw new ApiError(403, "Questa azione è riservata al coordinatore.");
  }
  return user;
}

/* ------------------------------ configurazione ---------------------------- */

async function publicConfig(ctx, state) {
  const { cfg } = ctx;
  const demo = !emailConfigured(cfg);
  const settings = digestSettings(state, cfg);
  const demoAccounts = demo
    ? state.users.filter((user) => user.demo_pin)
      .map((user) => ({ name: user.name, email: user.email, role: user.role, pin: user.demo_pin }))
    : [];
  return {
    org_name: cfg.orgName,
    org_short: cfg.orgShort,
    org_site: cfg.orgSite,
    org_brand: cfg.orgBrand,
    base_url: cfg.baseUrl,
    email_configured: emailConfigured(cfg),
    demo_mode: demo,
    reminders_enabled: emailConfigured(cfg) && cfg.reminderHours > 0,
    reminder_hours: cfg.reminderHours,
    weekly_digest: {
      enabled: cfg.weeklyDigest && emailConfigured(cfg),
      available: cfg.weeklyDigest,
      weekday: settings.weekday,
      weekday_label: ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"][settings.weekday],
      hour: settings.hour,
      custom_weekday: "weekly_digest_weekday" in state.meta,
    },
    demo_accounts: demoAccounts,
    ics_url: "/calendar.ics?t=" + (await icsFeedToken(cfg.sessionSecret)),
    roles: ROLES,
    palette: COLORS,
    types_by_role: Object.fromEntries(ROLES.map((role) => [role, allowedTypes({ role })])),
  };
}

function sessionPayload(cfg, state, user, pushDevices = 0) {
  return {
    user: publicUser(user, cfg),
    config: null,
    notifications: buildNotifications(state, user, cfg),
    allowed_types: allowedTypes(user),
    push_devices: pushDevices,
  };
}

/* ------------------------------- notifiche ------------------------------- */

function buildNotifications(state, user, cfg) {
  const seen = parseIso(user.seen_at) || new Date(0);
  const items = [];
  if (isCoordinator(user, cfg)) {
    for (const req of state.requests) {
      if (req.status !== "pending") continue;
      const created = parseIso(req.created_at);
      if (!created || created <= seen) continue;
      const requester = findUser(state.users, req.user_id) || {};
      items.push({
        id: "c_" + req.id,
        request_id: req.id,
        title: `Nuova richiesta da ${requester.name || ""}`,
        body: `${TYPE_LABELS[req.type] || ""} · ${fmtDates(requestDayList(req))}`,
        at: req.created_at,
        unread: true,
        kind: "pending",
      });
    }
  }
  for (const req of state.requests) {
    if (req.user_id !== user.id || !["approved", "rejected"].includes(req.status)) continue;
    const decided = parseIso(req.decided_at);
    if (!decided || decided <= seen) continue;
    items.push({
      id: "o_" + req.id,
      request_id: req.id,
      title: `Richiesta ${req.status === "approved" ? "approvata" : "rifiutata"}`,
      body: fmtDates(requestDayList(req)),
      at: req.decided_at,
      unread: true,
      kind: req.status === "approved" ? "approved" : "rejected",
    });
  }
  items.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return items.slice(0, 20);
}

/* -------------------------------- API ----------------------------------- */

async function handleApi(request, env, ctx) {
  const method = request.method === "HEAD" ? "GET" : request.method;
  const route = ctx.url.pathname.slice("/api/".length);

  if (route === "config" && method === "GET") return apiConfig(ctx);
  if (route === "session" && method === "GET") return apiSession(ctx);
  if (route === "login" && method === "POST") return apiLogin(ctx);
  if (route === "logout" && method === "POST") {
    if (!isSameOrigin(request, ctx.url)) throw new ApiError(403, "L'origine non è valida");
    return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(ctx.url, "", { clear: true }) });
  }
  if (route === "health" && method === "GET") return json({ ok: true, org: ctx.cfg.orgName });

  if (!isSameOrigin(request, ctx.url) && method === "POST") throw new ApiError(403, "L'origine non è valida");

  if (route === "calendar" && method === "GET") return apiCalendar(ctx);
  if (route === "requests" && method === "GET") return apiMyRequests(ctx);
  if (route === "requests" && method === "POST") return apiCreateRequest(ctx);
  if (route === "requests/pending" && method === "GET") return apiPending(ctx);
  if (route === "notifications" && method === "GET") return apiNotifications(ctx);
  if (route === "notifications/seen" && method === "POST") return apiNotificationsSeen(ctx);
  if (route === "pin" && method === "POST") return apiChangePin(ctx);
  if (route === "test-email" && method === "POST") return apiTestEmail(ctx);
  if (route === "weekly-digest" && method === "POST") return apiWeeklyDigest(ctx);
  if (route === "weekly-digest/settings" && method === "POST") return apiWeeklyDigestSettings(ctx);
  if (route === "admin/diagnostics" && method === "GET") return apiDiagnostics(ctx);
  if (route === "users" && method === "GET") return apiUsers(ctx);
  if (route === "users" && method === "POST") return apiCreateUser(ctx);
  if (route === "profile" && method === "POST") return apiUpdateProfile(ctx);
  if (route === "push/key" && method === "GET") return apiPushKey(ctx);
  if (route === "push/subscribe" && method === "POST") return apiPushSubscribe(ctx);
  if (route === "push/unsubscribe" && method === "POST") return apiPushUnsubscribe(ctx);
  if (route === "outbox" && method === "GET") return apiOutbox(ctx);

  const segments = route.split("/");
  if (segments.length === 3 && segments[0] === "users" && segments[2] === "appearance" && method === "POST") {
    return apiUpdateAppearance(ctx, decodeURIComponent(segments[1]));
  }
  if (segments.length === 3 && segments[0] === "users" && segments[2] === "delete" && method === "POST") {
    return apiDeleteUser(ctx, decodeURIComponent(segments[1]));
  }
  if (segments.length === 3 && segments[0] === "requests" && segments[2] === "cancel" && method === "POST") {
    return apiCancel(ctx, decodeURIComponent(segments[1]));
  }
  if (segments.length === 3 && segments[0] === "requests" && segments[2] === "decision" && method === "POST") {
    return apiDecision(ctx, decodeURIComponent(segments[1]));
  }
  if (segments.length === 3 && segments[0] === "requests" && segments[2] === "reopen" && method === "POST") {
    return apiReopen(ctx, decodeURIComponent(segments[1]));
  }
  if (segments.length === 3 && segments[0] === "outbox" && segments[2] === "resend" && method === "POST") {
    return apiResendOutbox(ctx, decodeURIComponent(segments[1]));
  }
  if (segments.length === 2 && segments[0] === "outbox" && method === "GET") {
    return apiOutboxItem(ctx, decodeURIComponent(segments[1]));
  }
  throw new ApiError(404, "Endpoint non trovato");
}

async function apiConfig(ctx) {
  await seedDemoUsers(ctx.env);
  const state = await ensureState(ctx);
  return json(await publicConfig(ctx, state));
}

async function apiSession(ctx) {
  const state = await ensureState(ctx);
  const user = await sessionUser(ctx.env, ctx.cfg, ctx.request, state);
  if (!user) throw new ApiError(401, "Non autenticato");
  const payload = sessionPayload(ctx.cfg, state, user, await pushSubscriptions(ctx.env, user.id).then((rows) => rows.length));
  payload.config = await publicConfig(ctx, state);
  return json(payload);
}

async function apiLogin(ctx) {
  const { env, cfg, request } = ctx;
  if (!isSameOrigin(request, ctx.url)) throw new ApiError(403, "L'origine non è valida");
  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";
  if (await loginBlocked(env, ip)) throw new ApiError(429, "Troppi tentativi. Riprova tra qualche minuto.");
  const data = await readJson(request);
  const email = cleanText(data.email, 120).toLowerCase();
  const pin = cleanText(data.pin, 32);
  const state = await ensureState(ctx);
  const user = findUser(state.users, null, email);
  if (!user || !pin) {
    await registerLoginFailure(env, ip);
    throw new ApiError(401, "Email o PIN non corretti");
  }
  if (!(await verifyPin(pin, user.salt, user.pin_hash))) {
    await registerLoginFailure(env, ip);
    throw new ApiError(401, "Email o PIN non corretti");
  }
  await clearLoginFailures(env, ip);
  const session = await makeSession(cfg.sessionSecret, user);
  const payload = sessionPayload(cfg, state, user, (await pushSubscriptions(env, user.id)).length);
  payload.config = await publicConfig(ctx, state);
  return json(payload, 200, { "Set-Cookie": sessionCookie(ctx.url, session) });
}

async function apiCalendar(ctx) {
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  const params = ctx.url.searchParams;
  const today = todayUtc();
  let start = parseDay(params.get("from")) || new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1) - 31 * 86400000);
  let end = parseDay(params.get("to")) || new Date(start.getTime() + 200 * 86400000);
  if (end < start) end = new Date(start.getTime() + 200 * 86400000);
  const rangeDays = new Set();
  for (let day = start; day <= end; day = new Date(day.getTime() + 86400000)) rangeDays.add(isoDay(day));
  const visible = [];
  for (const req of state.requests) {
    const mine = req.user_id === user.id;
    if (req.status === "approved") {
      // visibile a tutti
    } else if (req.status === "pending" && (mine || isCoordinator(user, ctx.cfg))) {
      // in attesa: solo chi l'ha chiesta o il coordinatore
    } else {
      continue;
    }
    if (!(req.dates || []).some((day) => rangeDays.has(day))) continue;
    visible.push(serializeRequest(state.users, req));
  }
  return json({
    me: publicUser(user, ctx.cfg),
    events: visible,
    birthdays: birthdaysInRange(state.users, start, end),
    people: state.users.map((item) => publicUser(item, ctx.cfg)),
    today: isoDay(today),
    server_time: nowIso(),
    ics_url: "/calendar.ics?t=" + (await icsFeedToken(ctx.cfg.sessionSecret)),
  });
}

async function apiMyRequests(ctx) {
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  const items = state.requests.filter((req) => req.user_id === user.id)
    .map((req) => serializeRequest(state.users, req));
  items.sort((a, b) => {
    const pending = Number(a.status !== "pending") - Number(b.status !== "pending");
    if (pending) return pending;
    return String(b.created_at || "").localeCompare(String(a.created_at || ""));
  });
  return json({ requests: items });
}

async function apiPending(ctx) {
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  requireCoordinator(user, ctx.cfg);
  const pending = state.requests.filter((req) => req.status === "pending")
    .map((req) => serializeRequest(state.users, req))
    .sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
  const history = state.requests.filter((req) => ["approved", "rejected"].includes(req.status))
    .map((req) => serializeRequest(state.users, req))
    .sort((a, b) => String(b.decided_at || "").localeCompare(String(a.decided_at || "")))
    .slice(0, 40);
  return json({ pending, history, stats: computeStats(state.users, state.requests, todayUtc()) });
}

function validateRequest(state, user, data) {
  const reqType = data.type;
  if (!TYPE_LABELS[reqType]) throw new ApiError(400, "Il tipo di richiesta non è valido");
  const allowed = allowedTypes(user);
  if (!allowed.includes(reqType)) {
    if (!allowed.length) throw new ApiError(403, "Il tuo profilo non può inviare richieste");
    throw new ApiError(403, "Il tuo profilo può inviare solo: " + allowed.map((type) => TYPE_LABELS[type].toLowerCase()).join(" e "));
  }
  if (!Array.isArray(data.dates) || !data.dates.length) throw new ApiError(400, "Seleziona almeno un giorno sul calendario");
  const days = [...new Set(data.dates.map(parseDay).filter(Boolean).map(isoDay))].sort();
  if (!days.length) throw new ApiError(400, "Le date selezionate non sono valide");
  if (days.length > 90) throw new ApiError(400, "Puoi selezionare al massimo 90 giorni per richiesta");
  const today = isoDay(todayUtc());
  if (days[0] < today) throw new ApiError(400, "Non puoi richiedere giorni già passati");
  let availability = data.availability;
  if (reqType === "disponibilita") {
    if (!AVAIL_LABELS[availability]) throw new ApiError(400, "Indica se il giorno è disponibile o non disponibile");
  } else {
    availability = null;
  }
  let slot = null;
  let timeFrom = null;
  let timeTo = null;
  if (reqType === "permesso" || reqType === "disponibilita") {
    slot = data.slot || "giornata";
    if (!SLOT_LABELS[slot]) throw new ApiError(400, "La fascia oraria non è valida");
    if (slot === SLOT_CUSTOM) {
      timeFrom = normalizeTime(data.time_from);
      timeTo = normalizeTime(data.time_to);
      if (!timeFrom || !timeTo) throw new ApiError(400, "Indica l'orario di inizio e di fine");
      if (timeTo <= timeFrom) throw new ApiError(400, "L'orario di fine deve essere successivo a quello di inizio");
    }
  }
  const note = cleanText(data.note, 500);
  for (const existing of state.requests) {
    if (existing.user_id !== user.id || existing.status !== "pending") continue;
    if (overlapsAny(existing, days)) throw new ApiError(409, "Hai già una richiesta in attesa su uno di questi giorni");
  }
  return { reqType, days, availability, note, slot, timeFrom, timeTo };
}

async function apiCreateRequest(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(env, cfg, ctx.request, state));
  const { reqType, days, availability, note, slot, timeFrom, timeTo } = validateRequest(state, user, data);
  const req = {
    id: newId("r_"),
    user_id: user.id,
    type: reqType,
    availability,
    slot,
    time_from: timeFrom,
    time_to: timeTo,
    dates: days,
    note,
    status: "pending",
    created_at: nowIso(),
    decided_at: null,
    decided_by: null,
    decision_note: "",
    reminded_at: null,
  };
  await saveRequest(env, req);
  state.requests.push(req);
  await logEvent(env, "info", `Nuova richiesta ${req.id} da ${user.name} (${reqType})`);

  const appUrl = cfg.baseUrl;
  const decideUrl = `${appUrl}/decide/${req.id}?t=${encodeURIComponent(await signedToken(cfg.sessionSecret, req.id))}`;
  const { subject, html: body, text } = coordinatorEmail(cfg, user, req, decideUrl, appUrl);
  const recipients = coordinators(state.users, cfg);
  const errors = [];
  for (const coord of recipients) {
    const mail = await sendMail(env, cfg, {
      to: coord.email, subject, html: body, text,
      replyTo: user.email || null,
      idempotencyKey: `notify-${req.id}-${coord.id}`,
    });
    if (mail.error) errors.push(`${coord.email} (${mail.error})`);
  }
  if (!recipients.length) errors.push("Nessun coordinatore configurato");
  const payload = {
    request: serializeRequest(state.users, req),
    notified: recipients.map((coord) => coord.email),
    decision_link: decideUrl,
  };
  if (errors.length) payload.warning = "Email non inviata: " + errors.join("; ");
  return json(payload, 201);
}

async function apiCancel(ctx, requestId) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(env, cfg, ctx.request, state));
  const req = state.requests.find((item) => item.id === requestId);
  if (!req) throw new ApiError(404, "Richiesta non trovata");
  const owner = req.user_id === user.id;
  if (!owner && !isCoordinator(user, cfg)) throw new ApiError(403, "Non puoi annullare questa richiesta");
  if (req.status === "cancelled") throw new ApiError(409, "Questa richiesta è già annullata");
  if (owner && !["pending", "approved"].includes(req.status)) {
    throw new ApiError(409, "Puoi ritirare solo una richiesta in attesa o già approvata");
  }
  const previousStatus = req.status;
  req.status = "cancelled";
  req.decided_at = nowIso();
  req.decided_by = user.id;
  if (owner && previousStatus === "approved") req.decision_note = "Ritirata dal richiedente dopo l'approvazione";
  else if (owner) req.decision_note = "Annullata dal richiedente";
  else req.decision_note = "Annullata dal coordinatore";
  await saveRequest(env, req);
  await logEvent(env, "info", `Richiesta ${requestId} annullata da ${user.name}`);
  return json({ request: serializeRequest(state.users, req) });
}

async function apiDecision(ctx, requestId) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const decision = data.decision;
  const note = cleanText(data.note, 500);
  if (!["approve", "reject"].includes(decision)) throw new ApiError(400, "La decisione non è valida");
  const state = await ensureState(ctx);
  const coord = requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  const req = state.requests.find((item) => item.id === requestId);
  if (!req) throw new ApiError(404, "Richiesta non trovata");
  if (req.status === "cancelled") throw new ApiError(409, "Questa richiesta è stata annullata");
  const requester = await recordDecision(env, state, req, coord, decision, note);
  const serialized = serializeRequest(state.users, req);
  if (requester) await sendOutcome(env, cfg, state, requester, req, coord, note);
  return json({ request: serialized });
}

async function recordDecision(env, state, req, coord, decision, note) {
  const requester = findUser(state.users, req.user_id);
  req.status = decision === "approve" ? "approved" : "rejected";
  req.decided_at = nowIso();
  req.decided_by = coord.id;
  req.decision_note = note;
  await saveRequest(env, req);
  await logEvent(env, "info", `Richiesta ${req.id} ${req.status} da ${coord.name}`);
  return requester;
}

async function sendOutcome(env, cfg, state, requester, req, coord, note) {
  const { subject, html: body, text } = outcomeEmail(cfg, requester, req, coord.name, note, cfg.baseUrl);
  const attachments = [];
  if (req.status === "approved" && req.type !== "disponibilita") {
    attachments.push({ filename: `richiesta-${req.id}.ics`, content: toBase64Utf8(requestIcs(req, requester)) });
  }
  const decided = parseIso(req.decided_at);
  await sendMail(env, cfg, {
    to: requester.email, subject, html: body, text, attachments,
    replyTo: coord.email || cfg.mailReplyTo || null,
    idempotencyKey: `outcome-${req.id}-${decided ? Math.floor(decided.getTime() / 1000) : Math.floor(Date.now() / 1000)}`,
  });
  const days = requestDayList(req).sort((a, b) => a - b);
  const approved = req.status === "approved";
  let pushTitle;
  let pushBody;
  if (req.type === "disponibilita") {
    pushTitle = approved ? "Comunicazione letta" : "Comunicazione da rivedere";
    pushBody = `Disponibilità: ${AVAIL_LABELS[req.availability] || ""} · ${fmtDates(days)}`;
    if (slotDetail(req)) pushBody += " · " + slotDetail(req);
  } else {
    pushTitle = approved ? "Richiesta approvata" : "Richiesta rifiutata";
    pushBody = `${TYPE_LABELS[req.type] || "Richiesta"} · ${fmtDates(days)}`;
  }
  if (note) pushBody += " · " + note;
  await notifyPush(env, cfg, requester.id, { title: pushTitle, body: pushBody, url: "/", tag: "req-" + req.id });
}

async function apiChangePin(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const current = cleanText(data.current, 32);
  const newPin = cleanText(data.new, 32);
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(env, cfg, ctx.request, state));
  if (!(await verifyPin(current, user.salt, user.pin_hash))) throw new ApiError(401, "Il PIN attuale non è corretto");
  if (!/^\d{4,8}$/.test(newPin)) throw new ApiError(400, "Il nuovo PIN deve avere da 4 a 8 cifre");
  const { salt, digest } = await hashPin(newPin);
  user.salt = salt;
  user.pin_hash = digest;
  if (user.demo_pin) user.demo_pin = null;
  await saveUser(env, user);
  const session = await makeSession(cfg.sessionSecret, user);
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(ctx.url, session) });
}

async function apiUsers(ctx) {
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  requireCoordinator(user, ctx.cfg);
  const users = [...state.users].sort((a, b) => {
    const role = Number(a.role !== ROLE_COORD) - Number(b.role !== ROLE_COORD);
    if (role) return role;
    return String(a.name).toLowerCase().localeCompare(String(b.name).toLowerCase());
  });
  return json({ users: users.map((item) => publicUser(item, ctx.cfg)), roles: ROLES, palette: COLORS });
}

function decodeAvatar(value) {
  const match = /^data:(image\/(jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value || "");
  if (!match) throw new ApiError(400, "L'immagine non è valida: usa JPG, PNG o WebP");
  let binary;
  try {
    binary = atob(match[3]);
  } catch (_error) {
    throw new ApiError(400, "L'immagine non è valida");
  }
  if (!binary.length) throw new ApiError(400, "L'immagine è vuota");
  if (binary.length > 70_000) throw new ApiError(400, "L'immagine è troppo grande: massimo 70 KB");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  const kind = match[2];
  const signatures = {
    jpeg: bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    png: bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47,
    webp: String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP",
  };
  if (!signatures[kind]) throw new ApiError(400, "Il contenuto del file non è un'immagine valida");
  return { extension: kind === "jpeg" ? ".jpg" : "." + kind, kind, bytes };
}

async function prepareAvatar(env, user, value) {
  if (value === undefined || value === null) return { name: user.avatar || null, previous: null };
  const previous = user.avatar || null;
  if (value === "") return { name: null, previous };
  const { extension, kind, bytes } = decodeAvatar(value);
  const name = `${user.id}-${randomHex10()}${extension}`;
  await saveAvatar(env, name, `image/${kind}`, bytes);
  return { name, previous };
}

function randomHex10() {
  return Array.from(crypto.getRandomValues(new Uint8Array(5)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function apiCreateUser(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const name = cleanText(data.name, 80);
  const email = cleanText(data.email, 120).toLowerCase();
  const role = cleanText(data.role, 30);
  const pin = cleanText(data.pin, 32);
  let color = cleanText(data.color, 9).toLowerCase();
  if (name.length < 2) throw new ApiError(400, "Inserisci nome e cognome");
  if (!validEmail(email)) throw new ApiError(400, "L'email non è valida");
  if (!ROLES.includes(role)) throw new ApiError(400, "Il ruolo non è valido");
  if (!/^\d{4,8}$/.test(pin)) throw new ApiError(400, "Il PIN deve avere da 4 a 8 cifre");
  const state = await ensureState(ctx);
  const coord = requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  if (findUser(state.users, null, email)) throw new ApiError(409, "Esiste già una persona con questa email");
  if (state.users.length >= 200) throw new ApiError(400, "È stato raggiunto il limite di 200 utenti");
  if (!COLORS.includes(color)) color = pickColor(state.users);
  const { salt, digest } = await hashPin(pin);
  const user = {
    id: newId("u_"), name, email, role, salt, pin_hash: digest, color,
    birthday: null, avatar: null, created_at: nowIso(), seen_at: null, demo_pin: null,
  };
  const { name: avatar, previous } = await prepareAvatar(env, user, typeof data.avatar === "string" ? data.avatar : null);
  user.avatar = avatar;
  await saveUser(env, user);
  if (previous && previous !== avatar) await deleteAvatar(env, previous);
  state.users.push(user);
  await logEvent(env, "info", `Utente creato da ${coord.name}: ${name} <${email}> (${role})`);
  return json({ user: publicUser(user, cfg) }, 201);
}

async function apiUpdateAppearance(ctx, userId) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  let color = data.color;
  if (color !== undefined && color !== null) {
    color = cleanText(color, 9).toLowerCase();
    if (!COLORS.includes(color)) throw new ApiError(400, "Il colore scelto non è disponibile");
  }
  const state = await ensureState(ctx);
  const me = requireUser(await sessionUser(env, cfg, ctx.request, state));
  const target = findUser(state.users, userId);
  if (!target) throw new ApiError(404, "Persona non trovata");
  if (target.id !== me.id && !isCoordinator(me, cfg)) throw new ApiError(403, "Puoi modificare solo il tuo aspetto");
  if (color) target.color = color;
  const { name: avatar, previous } = await prepareAvatar(env, target, typeof data.avatar === "string" ? data.avatar : null);
  target.avatar = avatar;
  await saveUser(env, target);
  if (previous && previous !== avatar) await deleteAvatar(env, previous);
  await logEvent(env, "info", `Aspetto aggiornato per ${target.name}`);
  return json({ user: publicUser(target, cfg), palette: COLORS });
}

async function apiUpdateProfile(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const name = cleanText(data.name, 80);
  const email = cleanText(data.email, 120).toLowerCase();
  if (name.length < 2) throw new ApiError(400, "Inserisci nome e cognome");
  if (!validEmail(email)) throw new ApiError(400, "L'email non è valida");
  let birthday = null;
  if ("birthday" in data && String(data.birthday || "").trim()) {
    birthday = normalizeBirthday(data.birthday);
    if (!birthday) throw new ApiError(400, "Il compleanno non è valido: indica giorno e mese");
  }
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(env, cfg, ctx.request, state));
  const other = findUser(state.users, null, email);
  if (other && other.id !== user.id) throw new ApiError(409, "Esiste già una persona con questa email");
  const before = [user.name, user.email];
  user.name = name;
  user.email = email;
  if ("birthday" in data) user.birthday = birthday;
  await saveUser(env, user);
  if (before[0] !== name || before[1] !== email) {
    await logEvent(env, "info", `Dati account aggiornati per ${user.id}: ${name} <${email}>`);
  }
  return json({ user: publicUser(user, cfg) });
}

async function apiDeleteUser(ctx, userId) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  const coord = requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  const target = findUser(state.users, userId);
  if (!target) throw new ApiError(404, "Persona non trovata");
  if (target.id === coord.id) throw new ApiError(400, "Non puoi eliminare il tuo account: chiedilo a un altro coordinatore");
  if (isCoordinator(target, cfg) && coordinators(state.users, cfg).length <= 1) {
    throw new ApiError(400, "Deve restare almeno un coordinatore");
  }
  const removedRequests = state.requests.filter((req) => req.user_id === userId).length;
  await deleteUser(env, userId);
  if (target.avatar) await deleteAvatar(env, target.avatar);
  state.users = state.users.filter((item) => item.id !== userId);
  state.requests = state.requests.filter((req) => req.user_id !== userId);
  await logEvent(env, "info", `Accesso eliminato da ${coord.name}: ${target.name} <${target.email}> (${removedRequests} richieste)`);
  return json({ ok: true, removed_requests: removedRequests });
}

async function apiTestEmail(ctx) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  const coord = requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  if (!emailConfigured(cfg)) {
    throw new ApiError(400, "Nessun servizio email configurato. Imposta MAILJET_API_KEY e MAILJET_SECRET_KEY (oppure RESEND_API_KEY) e MAIL_FROM.");
  }
  const { subject, html: body, text } = testEmail(cfg, coord.email);
  const mail = await sendMail(env, cfg, {
    to: coord.email, subject, html: body, text,
    replyTo: cfg.mailReplyTo || coord.email, idempotencyKey: newId("test-"),
  });
  if (mail.error) throw new ApiError(502, "Invio non riuscito: " + mail.error);
  return json({ ok: true, provider: mail.provider });
}

async function apiWeeklyDigest(ctx) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  const coord = requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  const simulated = !emailConfigured(cfg);
  const result = await runWeeklyDigest(env, cfg, { force: true });
  if (result.errors && result.errors.length && !result.sent) {
    throw new ApiError(502, "Invio non riuscito: " + result.errors.join("; "));
  }
  const payload = {
    ok: true, sent: result.sent || 0, recipients: result.recipients || [],
    subject: result.subject || "", absences: result.absences || 0,
    simulated, week_start: result.week_start,
  };
  if (result.errors && result.errors.length) payload.warning = result.errors.join("; ");
  return json(payload);
}

async function apiWeeklyDigestSettings(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const raw = data.weekday;
  const weekday = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (typeof raw === "boolean" || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    throw new ApiError(400, "Indica un giorno della settimana");
  }
  const state = await ensureState(ctx);
  requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  state.meta.weekly_digest_weekday = String(weekday);
  await saveMeta(env, { weekly_digest_weekday: weekday });
  const settings = digestSettings(state, cfg);
  await logEvent(env, "info", `Riepilogo settimanale spostato al ${["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"][weekday]}`);
  return json({
    ok: true,
    weekly_digest: {
      enabled: cfg.weeklyDigest && emailConfigured(cfg),
      available: cfg.weeklyDigest,
      weekday: settings.weekday,
      weekday_label: ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"][settings.weekday],
      hour: settings.hour,
      custom_weekday: true,
    },
  });
}

async function apiNotifications(ctx) {
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  return json({ notifications: buildNotifications(state, user, ctx.cfg) });
}

async function apiNotificationsSeen(ctx) {
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  user.seen_at = nowIso();
  await saveUser(ctx.env, user);
  return json({ ok: true });
}

async function apiReopen(ctx, requestId) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  const coord = requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  const req = state.requests.find((item) => item.id === requestId);
  if (!req) throw new ApiError(404, "Richiesta non trovata");
  if (!["approved", "rejected"].includes(req.status)) throw new ApiError(409, "Solo una richiesta già decisa può tornare in attesa");
  req.status = "pending";
  req.decided_at = null;
  req.decided_by = null;
  req.decision_note = "";
  req.reminded_at = null;
  await saveRequest(env, req);
  await logEvent(env, "info", `Richiesta ${requestId} riaperta da ${coord.name}`);
  return json({ request: serializeRequest(state.users, req) });
}

/* --------------------------------- outbox -------------------------------- */

async function apiOutbox(ctx) {
  const state = await ensureState(ctx);
  const user = requireStaff(await sessionUser(ctx.env, ctx.cfg, ctx.request, state), ctx.cfg);
  void user;
  const rows = await listOutbox(ctx.env);
  const messages = rows.map((row) => {
    let attachments = [];
    try {
      attachments = JSON.parse(row.attachments || "[]");
    } catch (_error) {
      attachments = [];
    }
    return {
      id: row.id, to: row.to_email, subject: row.subject, created_at: row.created_at,
      error: row.error, provider: row.provider, reply_to: row.reply_to || "",
      attachments: attachments.length,
    };
  });
  return json({ messages, configured: emailConfigured(ctx.cfg) });
}

async function apiOutboxItem(ctx, id) {
  const state = await ensureState(ctx);
  requireStaff(await sessionUser(ctx.env, ctx.cfg, ctx.request, state), ctx.cfg);
  const row = await getOutboxItem(ctx.env, id);
  if (!row) throw new ApiError(404, "Messaggio non trovato");
  return html(row.html || "<p>Corpo non disponibile.</p>");
}

async function apiResendOutbox(ctx, id) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  requireCoordinator(await sessionUser(env, cfg, ctx.request, state), cfg);
  const row = await getOutboxItem(env, id);
  if (!row) throw new ApiError(404, "Messaggio non trovato");
  let attachments = [];
  try {
    attachments = JSON.parse(row.attachments || "[]");
  } catch (_error) {
    attachments = [];
  }
  const mail = await sendMail(env, cfg, {
    to: row.to_email, subject: row.subject, html: row.html, text: row.text_body || "",
    attachments, replyTo: row.reply_to || null, idempotencyKey: newId("resend-"),
  });
  if (mail.error) throw new ApiError(502, "Reinvio non riuscito: " + mail.error);
  return json({ ok: true, provider: mail.provider });
}

async function apiDiagnostics(ctx) {
  const { env, cfg } = ctx;
  const state = await ensureState(ctx);
  requireAdmin(await sessionUser(env, cfg, ctx.request, state), cfg);
  const now = localNow(cfg);
  const rows = await listOutbox(env);
  const logs = await listLogs(env, 120);
  const statuses = {};
  for (const req of state.requests) statuses[req.status || "sconosciuto"] = (statuses[req.status || "sconosciuto"] || 0) + 1;
  const settings = digestSettings(state, cfg);
  const outboxRecent = rows.slice(0, 20).map((row) => ({
    id: row.id, to: row.to_email, subject: row.subject, created_at: row.created_at,
    provider: row.provider, error: row.error,
  }));
  return json({
    generated_at: nowIso(),
    server: {
      org: cfg.orgName,
      local_time: now.iso,
      timezone: cfg.timezone,
      started_at: STARTED_AT.toISOString(),
      uptime_seconds: Math.round((Date.now() - STARTED_AT.getTime()) / 1000),
      python: "Cloudflare Workers (V8)",
      pid: "—",
      base_url: cfg.baseUrl,
    },
    storage: {
      data_dir: "Cloudflare D1 · ferie-db",
      database: "users · requests · outbox",
      database_bytes: null,
      database_modified: null,
      avatar_files: state.users.filter((user) => user.avatar).length,
      outbox_files: rows.length,
    },
    counts: {
      users: state.users.length,
      coordinators: coordinators(state.users, cfg).length,
      requests: state.requests.length,
      requests_by_status: statuses,
      outbox: rows.length,
      push_subscriptions: await countPushSubscriptions(env),
    },
    email: {
      configured: emailConfigured(cfg),
      provider: emailProvider(cfg),
      from: cfg.mailFrom,
      from_name: cfg.mailFromName,
      reply_to: cfg.mailReplyTo,
      reminder_hours: cfg.reminderHours,
      weekly_digest: {
        enabled: cfg.weeklyDigest && emailConfigured(cfg),
        weekday: settings.weekday,
        weekday_label: ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"][settings.weekday],
        hour: settings.hour,
        last_week: state.meta.weekly_digest_week || null,
        last_sent_at: state.meta.weekly_digest_sent_at || null,
      },
    },
    push: {
      vapid: pushConfigured(cfg),
      subscriptions: await countPushSubscriptions(env),
      subject: cfg.vapidSubject,
    },
    logs: logs.slice(-120),
    errors: logs.filter((entry) => entry.level === "error").slice(-30),
    outbox_recent: outboxRecent,
  });
}

/* --------------------------------- push ---------------------------------- */

async function apiPushKey(ctx) {
  const state = await ensureState(ctx);
  requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  if (!pushConfigured(ctx.cfg)) throw new ApiError(503, "Le notifiche push non sono configurate su questo server");
  return json({ public_key: ctx.cfg.vapidPublicKey, enabled: true });
}

async function apiPushSubscribe(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const endpoint = cleanText(data.endpoint, 800);
  const keys = data.keys && typeof data.keys === "object" ? data.keys : {};
  if (!endpoint.startsWith("https://")) throw new ApiError(400, "Sottoscrizione push non valida");
  const p256dh = cleanText(keys.p256dh, 400);
  const auth = cleanText(keys.auth, 100);
  if (!p256dh || !auth) throw new ApiError(400, "Chiavi push non valide");
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(env, cfg, ctx.request, state));
  await savePushSubscription(env, user.id, { endpoint, p256dh, auth, device: cleanText(data.device, 120) });
  const devices = await pushSubscriptions(env, user.id);
  await logEvent(env, "info", `Notifiche push attive per ${user.name} (${devices.length} dispositivi)`);
  return json({ ok: true, devices: devices.length });
}

async function apiPushUnsubscribe(ctx) {
  const { env, cfg } = ctx;
  const data = await readJson(ctx.request);
  const endpoint = cleanText(data.endpoint, 800);
  const state = await ensureState(ctx);
  const user = requireUser(await sessionUser(env, cfg, ctx.request, state));
  await removePushSubscription(env, user.id, endpoint);
  const devices = await pushSubscriptions(env, user.id);
  return json({ ok: true, devices: devices.length });
}

/* ----------------------------- pagina decide ----------------------------- */

async function handleDecide(request, env, ctx) {
  const match = /^\/decide\/([^/]+)/.exec(ctx.url.pathname);
  if (!match) throw new ApiError(404, "Non trovato");
  const requestId = decodeURIComponent(match[1]);
  const state = await ensureState(ctx);
  const req = state.requests.find((item) => item.id === requestId);
  if (!req) throw new ApiError(404, "Richiesta non trovata o link non più valido");
  const data = request.method === "POST" ? await readForm(request) : {};
  const token = data.t || ctx.url.searchParams.get("t") || "";
  const coord = await sessionUser(env, ctx.cfg, request, state);
  const viaToken = await verifyToken(ctx.cfg.sessionSecret, requestId, token);
  if (!viaToken && !isCoordinator(coord, ctx.cfg)) {
    throw new ApiError(403, "Link non valido o scaduto. Accedi all'app come coordinatore.");
  }
  if (request.method === "POST") {
    if (!isSameOrigin(request, ctx.url)) throw new ApiError(403, "L'origine non è valida");
    const decision = data.decision;
    const note = cleanText(data.note, 500);
    if (!["approve", "reject"].includes(decision)) throw new ApiError(400, "Scegli se approvare o rifiutare");
    if (req.status !== "pending") {
      return html(decisionPage(ctx.cfg, state.users, req, token, viaToken, { already: true }));
    }
    const actor = isCoordinator(coord, ctx.cfg)
      ? coord
      : coordinators(state.users, ctx.cfg)[0] || { id: "email-link", name: "un coordinatore", email: "" };
    const requester = await recordDecision(env, state, req, actor, decision, note);
    if (requester) await sendOutcome(env, ctx.cfg, state, requester, req, actor, note);
    return html(decisionPage(ctx.cfg, state.users, req, token, viaToken));
  }
  const action = (ctx.url.searchParams.get("action") || "").trim();
  return html(decisionPage(ctx.cfg, state.users, req, token, viaToken, { action }));
}

/* --------------------------------- ICS ----------------------------------- */

async function handleIcs(ctx) {
  const token = ctx.url.searchParams.get("t") || "";
  const expected = await icsFeedToken(ctx.cfg.sessionSecret);
  if (token !== expected) throw new ApiError(403, "Il link del calendario non è valido");
  const state = await ensureState(ctx);
  const body = feedIcs(ctx.cfg.orgName, state.users, state.requests);
  return bytesResponse(new TextEncoder().encode(body), "text/calendar; charset=utf-8", { "Cache-Control": "no-store" });
}

/* -------------------------------- avatar --------------------------------- */

const AVATAR_MIME = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

async function handleAvatar(ctx, name) {
  const state = await ensureState(ctx);
  requireUser(await sessionUser(ctx.env, ctx.cfg, ctx.request, state));
  if (!/^[A-Za-z0-9_]+-[0-9a-f]{10}\.(jpg|png|webp)$/.test(name)) throw new ApiError(404, "Immagine non trovata");
  const row = await getAvatar(ctx.env, name);
  if (!row || !row.body) throw new ApiError(404, "Immagine non trovata");
  const extension = name.slice(name.lastIndexOf(".")).toLowerCase();
  const bytes = row.body instanceof ArrayBuffer ? new Uint8Array(row.body) : new Uint8Array(row.body);
  return bytesResponse(bytes, AVATAR_MIME[extension] || "application/octet-stream", {
    "Cache-Control": "private, max-age=31536000, immutable",
  });
}

/* ------------------------------- aiuto vari ------------------------------ */

async function logEvent(env, level, message) {
  await addLog(env, level, message);
}

/** Stato caricato una volta per richiesta. */
async function ensureState(ctx) {
  const state = await loadState(ctx.env);
  ctx.state = state;
  return state;
}

/* -------------------------------- routing -------------------------------- */

async function route(request, env) {
  const url = new URL(request.url);
  const cfg = config(env, url);
  const ctx = { env, cfg, url, request };
  if (!cfg.sessionSecret) {
    return json({ error: "SESSION_SECRET non configurato sul Worker." }, 500);
  }
  const path = url.pathname;
  try {
    if (path.startsWith("/api/")) return await handleApi(request, env, ctx);
    if (path.startsWith("/decide/")) return await handleDecide(request, env, ctx);
    if (path === "/calendar.ics") return await handleIcs(ctx);
    if (path.startsWith("/avatar/")) return await handleAvatar(ctx, decodeURIComponent(path.slice("/avatar/".length)));
    if (request.method === "GET" || request.method === "HEAD") {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "same-origin");
      const type = headers.get("Content-Type") || "";
      if (type.includes("text/html")) {
        headers.set("Content-Security-Policy",
          "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'");
      }
      return new Response(asset.body, { status: asset.status, headers });
    }
    throw new ApiError(404, "Non trovato");
  } catch (error) {
    if (error instanceof ApiError) {
      if (path.startsWith("/api/")) return json({ error: error.message, code: error.code }, error.status);
      return html(errorPage(cfg, error.status, error.message), error.status);
    }
    console.error("Errore su", request.method, path, error);
    const message = error && error.message ? error.message : String(error);
    if (path.startsWith("/api/")) return json({ error: "Errore interno del server", detail: message }, 500);
    return html(errorPage(cfg, 500, "Errore interno del server"), 500);
  }
}

export default {
  async fetch(request, env) {
    return route(request, env);
  },

  async scheduled(_event, env, ctx) {
    const cfg = config(env, new URL("https://placeholder.invalid"));
    const run = async () => {
      try {
        await runWeeklyDigest(env, cfg);
      } catch (error) {
        console.error("Riepilogo settimanale:", error);
      }
      try {
        const state = await loadState(env);
        await runReminders(env, cfg, state);
      } catch (error) {
        console.error("Promemoria:", error);
      }
    };
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(run());
    else await run();
  },
};
