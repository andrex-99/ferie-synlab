// Autenticazione senza stato: PIN con PBKDF2 e cookie di sessione firmato con
// HMAC. Niente sessioni in tabella: il cookie si verifica con il segreto del
// Worker e con l'impronta del PIN, quindi cambiare PIN chiude le sessioni.
//
// Nota sulle iterazioni: Cloudflare Workers ha un budget di CPU per richiesta
// (10 ms nel piano gratuito). PBKDF2 con molte iterazioni lo sfonderebbe al
// login, quindi qui sono 10.000 — il PIN resta protetto dal limite di tentativi
// per IP e dal fatto che il database non è pubblico.

import { MAX_SESSION_DAYS, nowIso } from "./util.js";

const ITERATIONS = 10_000;
const SESSION_DAYS = MAX_SESSION_DAYS;

const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomHex(length = 16) {
  return toHex(crypto.getRandomValues(new Uint8Array(length)));
}

export function randomBase64Url(length = 16) {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

async function pbkdf2(pin, salt, iterations = ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations, hash: "SHA-256" },
    key, 256,
  );
  return new Uint8Array(bits);
}

/** Restituisce {salt, digest} nel formato `pbkdf2$base64` usato anche da Python. */
export async function hashPin(pin, salt = randomHex(16)) {
  const digest = await pbkdf2(pin, salt);
  return { salt, digest: "pbkdf2$" + toBase64(digest) };
}

export async function verifyPin(pin, salt, expected) {
  const [algorithm, encoded] = String(expected || "").split("$");
  if (algorithm !== "pbkdf2" || !encoded) return false;
  try {
    const digest = await pbkdf2(pin, salt);
    const candidate = toBase64(digest);
    if (candidate.length !== encoded.length) return false;
    let diff = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      diff |= candidate.charCodeAt(index) ^ encoded.charCodeAt(index);
    }
    return diff === 0;
  } catch (_error) {
    return false;
  }
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

async function sha256Hex(value) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function icsFeedToken(secret) {
  return (await hmacHex(secret, "ics-feed")).slice(0, 32);
}

/* ------------------------------- sessioni ------------------------------- */

async function sessionSignature(secret, uid, expires, user) {
  const tag = (await sha256Hex(String(user.pin_hash || ""))).slice(0, 12);
  return (await hmacHex(secret, `sess|${uid}|${expires}|${tag}`)).slice(0, 32);
}

export async function makeSession(secret, user) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  const signature = await sessionSignature(secret, user.id, expires, user);
  return `${user.id}.${expires}.${signature}`;
}

export async function readSession(secret, users, cookieValue) {
  if (!cookieValue) return null;
  const parts = String(cookieValue).split(".");
  if (parts.length !== 3) return null;
  const [uid, expires, signature] = parts;
  const deadline = Number(expires);
  if (!Number.isFinite(deadline) || deadline < Date.now() / 1000) return null;
  const user = users.find((item) => item.id === uid);
  if (!user) return null;
  const expected = await sessionSignature(secret, uid, expires, user);
  if (expected.length !== signature.length) return null;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  }
  return diff === 0 ? user : null;
}

/** Token per i link "approva/rifiuta" nelle email: vale 30 giorni. */
export async function signedToken(secret, requestId, days = 30) {
  const expires = Math.floor(Date.now() / 1000) + days * 86400;
  const payload = `${requestId}.${expires}`;
  const encoded = toBase64Url(encoder.encode(payload));
  const signature = (await hmacHex(secret, "decide|" + payload)).slice(0, 40);
  return `${encoded}.${signature}`;
}

export async function verifyToken(secret, requestId, token) {
  if (!token || !String(token).includes(".")) return false;
  try {
    const [encoded, signature] = String(token).split(".");
    const payload = new TextDecoder().decode(fromBase64(encoded.replace(/-/g, "+").replace(/_/g, "/") +
      "=".repeat((4 - (encoded.length % 4)) % 4)));
    const [tokenId, expires] = payload.split(".");
    if (tokenId !== requestId) return false;
    if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now() / 1000) return false;
    const expected = (await hmacHex(secret, "decide|" + payload)).slice(0, 40);
    if (expected.length !== signature.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index += 1) {
      diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
    }
    return diff === 0;
  } catch (_error) {
    return false;
  }
}

/* -------------------------------- cookie -------------------------------- */

export function parseCookies(request) {
  const header = request.headers.get("Cookie") || "";
  const jar = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    jar[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return jar;
}

export function sessionCookie(url, value, { clear = false } = {}) {
  const secure = url.protocol === "https:" ? "; Secure" : "";
  if (clear) return `sess=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
  return `sess=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

/** POST accettati solo dallo stesso hostname (difesa CSRF). */
export function isSameOrigin(request, url) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === url.host;
  } catch (_error) {
    return false;
  }
}

export { nowIso };
