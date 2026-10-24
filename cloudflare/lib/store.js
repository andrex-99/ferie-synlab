// Accesso a D1: lettura dello stato dell'app e scritture puntuali.
//
// Lo stato è piccolo (poche decine di persone, qualche migliaio di richieste),
// quindi ogni richiesta HTTP carica utenti, richieste e meta in tre query e
// riscrive solo le righe che ha toccato. Così la logica resta quella del
// server Python (un unico oggetto "db") senza un ORM.

const USER_COLUMNS = ["id", "name", "email", "role", "salt", "pin_hash", "color",
  "birthday", "avatar", "created_at", "seen_at", "demo_pin"];
const REQUEST_COLUMNS = ["id", "user_id", "type", "availability", "slot", "time_from",
  "time_to", "dates", "note", "status", "created_at", "decided_at", "decided_by",
  "decision_note", "reminded_at"];

function userRow(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    salt: row.salt,
    pin_hash: row.pin_hash,
    color: row.color,
    birthday: row.birthday || null,
    avatar: row.avatar || null,
    created_at: row.created_at || null,
    seen_at: row.seen_at || null,
    demo_pin: row.demo_pin || null,
  };
}

function requestRow(row) {
  let dates = [];
  try {
    dates = JSON.parse(row.dates || "[]");
  } catch (_error) {
    dates = [];
  }
  return {
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    availability: row.availability || null,
    slot: row.slot || null,
    time_from: row.time_from || null,
    time_to: row.time_to || null,
    dates: Array.isArray(dates) ? dates : [],
    note: row.note || "",
    status: row.status || "pending",
    created_at: row.created_at || null,
    decided_at: row.decided_at || null,
    decided_by: row.decided_by || null,
    decision_note: row.decision_note || "",
    reminded_at: row.reminded_at || null,
  };
}

export async function loadState(env) {
  const [users, requests, meta] = await Promise.all([
    env.DB.prepare("SELECT * FROM users ORDER BY name COLLATE NOCASE").all(),
    env.DB.prepare("SELECT * FROM requests ORDER BY created_at").all(),
    env.DB.prepare("SELECT key, value FROM meta").all(),
  ]);
  const metaObject = {};
  for (const row of meta.results || []) metaObject[row.key] = row.value;
  return {
    users: (users.results || []).map(userRow),
    requests: (requests.results || []).map(requestRow),
    meta: metaObject,
  };
}

export async function saveUser(env, user) {
  const values = USER_COLUMNS.map((column) => (user[column] === undefined ? null : user[column]));
  await env.DB.prepare(
    `INSERT INTO users (${USER_COLUMNS.join(", ")})
     VALUES (${USER_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, email=excluded.email, role=excluded.role, salt=excluded.salt,
       pin_hash=excluded.pin_hash, color=excluded.color, birthday=excluded.birthday,
       avatar=excluded.avatar, created_at=excluded.created_at, seen_at=excluded.seen_at,
       demo_pin=excluded.demo_pin`,
  ).bind(...values).run();
}

export async function saveRequest(env, req) {
  const values = REQUEST_COLUMNS.map((column) => {
    if (column === "dates") return JSON.stringify(req.dates || []);
    return req[column] === undefined ? null : req[column];
  });
  await env.DB.prepare(
    `INSERT INTO requests (${REQUEST_COLUMNS.join(", ")})
     VALUES (${REQUEST_COLUMNS.map(() => "?").join(", ")})
     ON CONFLICT(id) DO UPDATE SET
       user_id=excluded.user_id, type=excluded.type, availability=excluded.availability,
       slot=excluded.slot, time_from=excluded.time_from, time_to=excluded.time_to,
       dates=excluded.dates, note=excluded.note, status=excluded.status,
       created_at=excluded.created_at, decided_at=excluded.decided_at,
       decided_by=excluded.decided_by, decision_note=excluded.decision_note,
       reminded_at=excluded.reminded_at`,
  ).bind(...values).run();
}

export async function deleteUser(env, userId) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM requests WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

export async function saveMeta(env, entries) {
  const statements = Object.entries(entries).map(([key, value]) =>
    env.DB.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .bind(key, String(value)));
  if (statements.length) await env.DB.batch(statements);
}

export async function deleteMeta(env, key) {
  await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
}

/* -------------------------------- email -------------------------------- */

export async function insertOutbox(env, entry) {
  await env.DB.prepare(
    `INSERT INTO outbox (id, to_email, subject, provider, error, created_at, reply_to, html, text_body, attachments)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(entry.id, entry.to, entry.subject, entry.provider || null, entry.error || null,
    entry.created_at, entry.reply_to || "", entry.html || "", entry.text || "",
    JSON.stringify(entry.attachments || [])).run();
  await env.DB.prepare(
    "DELETE FROM outbox WHERE id NOT IN (SELECT id FROM outbox ORDER BY created_at DESC LIMIT 100)",
  ).run();
}

export async function setOutboxResult(env, id, provider, error) {
  await env.DB.prepare("UPDATE outbox SET provider = ?, error = ? WHERE id = ?")
    .bind(provider || null, error || null, id).run();
}

export async function listOutbox(env, limit = 100) {
  const { results } = await env.DB.prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT ?")
    .bind(limit).all();
  return results || [];
}

export async function getOutboxItem(env, id) {
  return env.DB.prepare("SELECT * FROM outbox WHERE id = ?").bind(id).first();
}

/* -------------------------------- avatar -------------------------------- */

export async function saveAvatar(env, name, mime, bytes) {
  await env.DB.prepare(
    "INSERT INTO avatars (name, mime, body, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET body=excluded.body, mime=excluded.mime",
  ).bind(name, mime, bytes, new Date().toISOString()).run();
}

export async function getAvatar(env, name) {
  return env.DB.prepare("SELECT name, mime, body FROM avatars WHERE name = ?").bind(name).first();
}

export async function deleteAvatar(env, name) {
  if (!name) return;
  await env.DB.prepare("DELETE FROM avatars WHERE name = ?").bind(name).run();
}

/* --------------------------------- push --------------------------------- */

export async function pushSubscriptions(env, userId) {
  const { results } = await env.DB.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?")
    .bind(userId).all();
  return results || [];
}

export async function savePushSubscription(env, userId, subscription) {
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, device, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh,
       auth=excluded.auth, device=excluded.device`,
  ).bind(subscription.endpoint, userId, subscription.p256dh, subscription.auth,
    subscription.device || "", new Date().toISOString()).run();
  await env.DB.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN
       (SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT 10)`,
  ).bind(userId, userId).run();
}

export async function removePushSubscription(env, userId, endpoint) {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
    .bind(userId, endpoint).run();
}

export async function removePushEndpoints(env, endpoints) {
  if (!endpoints.length) return;
  const statements = endpoints.map((endpoint) =>
    env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").bind(endpoint));
  await env.DB.batch(statements);
}

export async function countPushSubscriptions(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM push_subscriptions").first();
  return row ? row.total : 0;
}

/* ---------------------------------- log --------------------------------- */

export async function addLog(env, level, message) {
  try {
    const now = new Date();
    const clock = now.toISOString().slice(11, 19);
    await env.DB.prepare("INSERT INTO logs (at, clock, level, message) VALUES (?, ?, ?, ?)")
      .bind(now.toISOString(), clock, level, String(message).slice(0, 1000)).run();
    await env.DB.prepare("DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 400)").run();
  } catch (_error) {
    // Il log non deve mai far fallire un'operazione riuscita.
  }
}

export async function listLogs(env, limit = 120) {
  const { results } = await env.DB.prepare("SELECT at, clock, level, message FROM logs ORDER BY id DESC LIMIT ?")
    .bind(limit).all();
  return (results || []).reverse();
}

/* --------------------------- tentativi di login --------------------------- */

export async function loginBlocked(env, ip) {
  const row = await env.DB.prepare("SELECT count, reset_at FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (!row) return false;
  const now = Math.floor(Date.now() / 1000);
  if (now >= row.reset_at) {
    await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
    return false;
  }
  return row.count >= 10;
}

export async function registerLoginFailure(env, ip) {
  const now = Math.floor(Date.now() / 1000);
  const row = await env.DB.prepare("SELECT count, reset_at FROM login_attempts WHERE ip = ?").bind(ip).first();
  if (!row || now >= row.reset_at) {
    await env.DB.prepare("INSERT INTO login_attempts (ip, count, reset_at) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET count=1, reset_at=excluded.reset_at")
      .bind(ip, now + 900).run();
    return;
  }
  await env.DB.prepare("UPDATE login_attempts SET count = count + 1 WHERE ip = ?").bind(ip).run();
}

export async function clearLoginFailures(env, ip) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE ip = ?").bind(ip).run();
}

/* ------------------------------ seed demo ------------------------------ */

// Hash già calcolati (PBKDF2-SHA256, 10.000 iterazioni) per i PIN dimostrativi:
// così il primo avvio non consuma CPU del piano gratuito con quattro derivate.
const DEMO_USERS = [
  ["u_demo_giulia", "Giulia Rossi", "giulia@studio.it", "dipendente", "1111", "#2f7d63",
    "633faba7b25940509f65d74882125bb3", "pbkdf2$FSL8Q9b7jzBJU5yH6m2NhWYjjdt/lS8wxDEoE8ufmRM="],
  ["u_demo_luca", "Luca Ferrari", "luca@studio.it", "dipendente", "2222", "#3b6fd4",
    "15abddb849087641367294dd143afa94", "pbkdf2$XYgnXRnWhXiKAfzHfyGGBTpPntYmA4n6muauX5vaCSM="],
  ["u_demo_sara", "Sara Conti", "sara@studio.it", "professionista", "3333", "#b56a2a",
    "a8dae6b962823176e312e5e4a8593d54", "pbkdf2$+1H97WOo3CdQbgi84L7UnUZRKoe/jxHDCSfYmaruFLM="],
  ["u_demo_marco", "Marco Bianchi", "coordinatore@studio.it", "coordinatore", "1234", "#7a59c4",
    "13e5829b6a4d839683d7cbcd0044a290", "pbkdf2$bbtnjQTOvpGmvkOMenZkjW3g9VL8XZgmpb/XDSEB1o0="],
];

/**
 * Primo avvio: quattro account dimostrativi, con PIN noti, come nella demo
 * storica. Gli id sono fissi, quindi due richieste in parallelo non duplicano
 * nulla. Le persone reali si aggiungono dal pannello del coordinatore.
 */
export async function seedDemoUsers(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS total FROM users").first();
  if (row && row.total > 0) return false;
  for (const [id, name, email, role, pin, color, salt, digest] of DEMO_USERS) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO users (id, name, email, role, salt, pin_hash, color, created_at, seen_at, demo_pin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).bind(id, name, email, role, salt, digest, color, new Date().toISOString(), pin).run();
  }
  return true;
}
