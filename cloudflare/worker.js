/**
 * Worker che pubblica l'app su Cloudflare: serve i file statici di `public/`
 * e inoltra all'API Python (`ORIGIN`) solo le richieste che ne hanno bisogno.
 *
 * Perché un proxy e non l'app intera: il backend è un processo Python con un
 * database su file, che Cloudflare non esegue. Così il sito e il login stanno
 * sullo stesso hostname (cookie `sess` compreso) mentre il server Python resta
 * dove gira già — Render oggi, una VM o un tunnel domani: basta cambiare
 * `ORIGIN`.
 */

const API_PATHS = ["/api", "/calendar.ics"];

function isBackendPath(pathname) {
  if (pathname === "/api" || API_PATHS.includes(pathname)) return true;
  return pathname.startsWith("/api/");
}

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Tutto ciò che non è API è un file statico: HTML, CSS, JS, icone.
    if (!isBackendPath(url.pathname)) {
      return env.ASSETS.fetch(request);
    }

    let origin;
    try {
      origin = new URL(env.ORIGIN);
    } catch {
      return jsonError("ORIGIN non configurato: indica l'indirizzo del server Python.", 500);
    }

    const target = new URL(url.pathname + url.search, origin);
    const headers = new Headers(request.headers);
    // Header che descrivono il nostro edge, non il backend: il server Python
    // deve vedere la richiesta come se arrivasse dal proprio hostname.
    for (const name of ["host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
      "cdn-loop", "x-forwarded-proto", "x-forwarded-host", "x-real-ip", "content-length"]) {
      headers.delete(name);
    }
    // Il server accetta i POST solo se `Origin` corrisponde al proprio `Host`
    // (`same_origin` in server.py): senza questa riga ogni scrittura qui darebbe 403.
    headers.set("Origin", origin.origin);
    // Lo schema vero della richiesta: in produzione è https e il server marca il
    // cookie `Secure`; in locale resta http, altrimenti i browser non lo rimandano.
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
    headers.set("X-Forwarded-Host", url.host);

    const init = { method: request.method, headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = request.body;
    }

    let upstream;
    try {
      upstream = await fetch(target, init);
    } catch (error) {
      return jsonError("Backend non raggiungibile: " + (error && error.message ? error.message : error), 502);
    }

    const responseHeaders = new Headers();
    for (const [key, value] of upstream.headers) {
      const name = key.toLowerCase();
      if (["content-encoding", "content-length", "transfer-encoding", "connection"].includes(name)) continue;
      if (name === "set-cookie") continue; // gestito sotto, uno per uno
      responseHeaders.append(key, value);
    }
    // Set-Cookie può essere multiplo: va ricopiato senza unirne i valori.
    const cookies = typeof upstream.headers.getSetCookie === "function"
      ? upstream.headers.getSetCookie()
      : [];
    for (const cookie of cookies) responseHeaders.append("Set-Cookie", cookie);

    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  },
};
