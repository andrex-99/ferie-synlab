// Pagine HTML generate dal Worker: la conferma dei link “approva/rifiuta”
// inviati per email e le pagine di errore. Stesso stile dell'app.

import { AVAIL_LABELS, TYPE_LABELS, escapeHtml, fmtDates, requestDayList, slotDetail } from "./util.js";

export const PAGE_CSS = `
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
`;

export function decisionPage(cfg, users, req, token, tokenValid, { already = false, action = "" } = {}) {
  const requester = users.find((user) => user.id === req.user_id) || {};
  const days = requestDayList(req).sort((a, b) => a - b);
  const period = fmtDates(days);
  let label = TYPE_LABELS[req.type] || "Richiesta";
  const isAvail = req.type === "disponibilita";
  if (isAvail) label += " · " + (AVAIL_LABELS[req.availability] || "");
  if (slotDetail(req)) label += " · " + slotDetail(req);
  const escapedNote = escapeHtml(req.note || "");
  const approveWord = isAvail ? "Ho letto" : "Approva";
  const rejectWord = isAvail ? "Segnala da rivedere" : "Rifiuta";
  const outcomeMeta = isAvail
    ? "Confermando la lettura, la disponibilità compare nel calendario del team."
    : "Se approvi, i giorni compariranno nel calendario condiviso dell'app.";
  const outcomeHint = isAvail ? "riceverà una conferma di lettura" : "riceverà subito un'email con l'esito";
  const status = req.status;
  const chips = {
    pending: `<span class="status wait">${isAvail ? "In attesa di lettura" : "In attesa di decisione"}</span>`,
    approved: `<span class="status ok">${isAvail ? "Letta" : "Approvata"}</span>`,
    rejected: `<span class="status no">${isAvail ? "Da rivedere" : "Rifiutata"}</span>`,
    cancelled: `<span class="status no">${isAvail ? "Da rivedere" : "Rifiutata"}</span>`,
  };
  const head = chips[status] || chips.pending;
  let body;
  if (already || status !== "pending") {
    const resultNote = escapeHtml(req.decision_note || "");
    body = `<div class="body">${head}<table>`
      + `<tr><td>Richiedente</td><td>${escapeHtml(requester.name || "")}</td></tr>`
      + `<tr><td>Tipo</td><td>${escapeHtml(label)}</td></tr>`
      + `<tr><td>Periodo</td><td>${escapeHtml(period)}</td></tr>`
      + `<tr><td>Giorni</td><td>${days.length}</td></tr>`
      + `</table>${resultNote ? `<p class="note">${resultNote}</p>` : ""}`
      + `<p class="sub">${isAvail ? "La comunicazione è già stata gestita." : "La richiesta è già stata gestita."} `
      + "Puoi consultare il calendario dall'app.</p>"
      + '<div class="actions"><a href="/" style="display:inline-block;background:#005f96;color:#fff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:999px;">Apri il calendario</a></div>'
      + "</div>";
  } else {
    const firstName = requester.name ? requester.name.split(/\s+/)[0] : "il richiedente";
    const noteInput = `<label for="note">Nota per ${escapeHtml(firstName)} (facoltativa)</label>`
      + `<textarea id="note" name="note" maxlength="500" placeholder="${isAvail ? "Es. letta" : "Es. approvata, buone ferie"}"></textarea>`;
    body = `<div class="body">${head}<table>`
      + `<tr><td>Richiedente</td><td>${escapeHtml(requester.name || "")}</td></tr>`
      + `<tr><td>Ruolo</td><td>${escapeHtml(String(requester.role || "").charAt(0).toUpperCase() + String(requester.role || "").slice(1))}</td></tr>`
      + `<tr><td>Tipo</td><td>${escapeHtml(label)}</td></tr>`
      + `<tr><td>Periodo</td><td>${escapeHtml(period)}</td></tr>`
      + `<tr><td>Giorni</td><td>${days.length}</td></tr>`
      + `</table>${escapedNote ? `<p class="note">${escapedNote}</p>` : ""}`
      + `<form method="POST" action="/decide/${escapeHtml(req.id)}">`
      + `<input type="hidden" name="t" value="${escapeHtml(token || "")}">${noteInput}`
      + '<div class="actions">'
      + `<button class="approve${action === "approve" ? " is-suggested" : ""}" name="decision" value="approve" type="submit">${approveWord}</button>`
      + `<button class="reject${action === "reject" ? " is-suggested" : ""}" name="decision" value="reject" type="submit">${rejectWord}</button>`
      + "</div></form>"
      + `<p class="meta">${escapeHtml(requester.name || "Il richiedente")} ${outcomeHint}. ${outcomeMeta}</p></div>`;
  }
  const locked = tokenValid ? "" : " · accesso come coordinatore";
  return '<!doctype html><html lang="it"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    + `<title>Richiesta di ${escapeHtml(requester.name || "")}</title><style>${PAGE_CSS}</style></head><body>`
    + `<main class="card"><div class="top"><div class="brand"><span class="dot"></span>${escapeHtml(cfg.orgName)}</div>`
    + `<h1>${escapeHtml(label)}</h1><p class="sub">${escapeHtml(period)}${escapeHtml(locked)}</p></div>${body}</main></body></html>`;
}

const HTTP_LABELS = {
  400: "Richiesta non valida", 403: "Accesso non consentito", 404: "Non trovato",
  409: "Richiesta già gestita", 429: "Troppi tentativi",
};

export function errorPage(cfg, status, message) {
  const label = HTTP_LABELS[status] || "Si è verificato un errore";
  return '<!doctype html><html lang="it"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + `<title>${status}</title><style>${PAGE_CSS}</style></head><body><main class="card">`
    + `<div class="top"><div class="brand"><span class="dot"></span>${escapeHtml(cfg.orgName)}</div>`
    + `<h1>${escapeHtml(label)}</h1><p class="sub">${escapeHtml(message)}</p></div>`
    + '<div class="body"><a href="/">Torna all\'app</a></div></main></body></html>';
}
