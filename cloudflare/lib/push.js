// Web Push dal Worker: firma VAPID (ES256) e cifratura aes128gcm con Web Crypto.
// Le chiavi VAPID stanno nei segreti del Worker (VAPID_PUBLIC_KEY /
// VAPID_PRIVATE_JWK); il browser riceve solo la chiave pubblica.

import { addLog, removePushEndpoints, pushSubscriptions } from "./store.js";

const encoder = new TextEncoder();

function base64UrlToBytes(value) {
  const text = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = text + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export function pushConfigured(cfg) {
  return Boolean(cfg.vapidPublicKey && cfg.vapidPrivateJwk);
}

async function vapidJwt(cfg, audience) {
  const header = bytesToBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = bytesToBase64Url(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: cfg.vapidSubject,
  })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "jwk", JSON.parse(cfg.vapidPrivateJwk), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"],
  );
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

/** Cifra il payload secondo RFC 8291 (aes128gcm). */
async function encryptPayload(subscription, payload) {
  const uaPublic = base64UrlToBytes(subscription.p256dh);
  const authSecret = base64UrlToBytes(subscription.auth);
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, pair.privateKey, 256));

  const authInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, authInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(encoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  const header = concat(salt, new Uint8Array([0, 0, 16, 0]), new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

async function sendToDevice(cfg, subscription, payload) {
  const audience = new URL(subscription.endpoint).origin;
  const jwt = await vapidJwt(cfg, audience);
  const body = await encryptPayload(subscription, payload);
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${cfg.vapidPublicKey}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body,
  });
  if (response.status === 404 || response.status === 410) {
    const error = new Error("subscription gone");
    error.gone = true;
    error.status = response.status;
    throw error;
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`HTTP ${response.status}: ${detail.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }
}

/** Invia la notifica a tutti i dispositivi dell'utente e ripulisce quelli scaduti. */
export async function notifyPush(env, cfg, userId, payload) {
  if (!userId || !pushConfigured(cfg)) return 0;
  const subscriptions = await pushSubscriptions(env, userId);
  if (!subscriptions.length) return 0;
  const stale = [];
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      await sendToDevice(cfg, subscription, payload);
      delivered += 1;
    } catch (error) {
      if (error && error.gone) stale.push(subscription.endpoint);
      await addLog(env, "error", `Push non consegnata (${String(subscription.endpoint).slice(0, 40)}): ${error && error.message ? error.message : error}`);
    }
  }
  if (stale.length) {
    await removePushEndpoints(env, stale);
    await addLog(env, "info", `Rimosse ${stale.length} sottoscrizioni push scadute`);
  }
  return delivered;
}
