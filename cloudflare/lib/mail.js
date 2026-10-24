// Email transazionali. L'invio passa da API HTTPS (Resend o Mailjet): un Worker
// non può aprire connessioni SMTP. Il registro in D1 conserva il corpo HTML,
// così un messaggio si può rileggere e reinviare dal pannello.

import {
  AVAIL_LABELS, TYPE_LABELS, WEEKDAYS, MONTHS, escapeHtml, fmtDates, fmtRange,
  newId, nowIso, requestDayList, slotDetail,
} from "./util.js";
import { addLog, insertOutbox, setOutboxResult } from "./store.js";

export function emailProvider(cfg) {
  if (cfg.resendKey && cfg.mailFrom) return "resend";
  if (cfg.mailjetKey && cfg.mailjetSecret && cfg.mailFrom) return "mailjet";
  return "demo";
}

export function emailConfigured(cfg) {
  return emailProvider(cfg) !== "demo";
}

export const PROVIDER_LABELS = { resend: "Resend", mailjet: "Mailjet", smtp: "SMTP", demo: "demo" };

/* ------------------------------- layout -------------------------------- */

export function emailShell(cfg, title, eyebrow, bodyHtml, footer = "", preheader = "", accent = "#005f96") {
  const mark = cfg.orgName.split(/\s+/).slice(0, 3).map((part) => part[0]).join("").toUpperCase() || "F";
  const brandLine = cfg.orgBrand ? `${cfg.orgBrand} · Ferie e disponibilità` : "Ferie e disponibilità";
  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#eef3f7;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eef3f7;">
<tr><td align="center" style="padding:30px 12px 34px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">

    <tr><td style="padding:0 4px 16px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td width="40" height="40" style="width:40px;height:40px;border-radius:12px;background:#005f96;color:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;text-align:center;vertical-align:middle;letter-spacing:.5px;">${escapeHtml(mark)}</td>
        <td style="padding-left:12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div style="font-size:15px;font-weight:700;color:#1b2321;letter-spacing:-.01em;">${escapeHtml(cfg.orgName)}</div>
          <div style="font-size:10.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:#7c8178;padding-top:2px;">${escapeHtml(brandLine)}</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="background:#ffffff;border:1px solid #dfe8ef;border-radius:20px;overflow:hidden;box-shadow:0 18px 40px -32px rgba(27,35,33,.45);">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="height:5px;background:${accent};font-size:0;line-height:0;">&nbsp;</td></tr>
        <tr><td style="padding:30px 34px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
          <div style="font-size:11px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:#8a8172;">${escapeHtml(eyebrow)}</div>
          <h1 style="margin:9px 0 0;font-size:25px;line-height:1.22;letter-spacing:-.025em;font-weight:700;color:#1b2321;">${escapeHtml(title)}</h1>
        </td></tr>
        <tr><td style="padding:18px 34px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3f4a45;">
          ${bodyHtml}
        </td></tr>
      </table>
    </td></tr>

    <tr><td style="padding:18px 10px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:11.5px;line-height:1.6;color:#7c8178;text-align:center;">
      ${footer}
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

export function button(url, label, color = "#005f96") {
  return `<a href="${escapeHtml(url)}" style="display:inline-block;background:${color};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:1;padding:14px 24px;border-radius:999px;margin:4px 8px 4px 0;">${escapeHtml(label)}</a>`;
}

function ghostLink(url, label) {
  return `<a href="${escapeHtml(url)}" style="color:#3f4a45;text-decoration:none;font-weight:600;font-size:14px;border-bottom:1px solid #cfd8ce;padding-bottom:2px;">${escapeHtml(label)}</a>`;
}

export function detailsTable(req, requester) {
  const rows = [["Richiedente", requester.name || ""]];
  if (requester.role) rows.push(["Ruolo", requester.role.charAt(0).toUpperCase() + requester.role.slice(1)]);
  let typeLabel = TYPE_LABELS[req.type] || req.type;
  if (slotDetail(req)) typeLabel += " · " + slotDetail(req);
  rows.push(["Tipo", typeLabel]);
  if (req.type === "disponibilita") rows.push(["Disponibilità", AVAIL_LABELS[req.availability] || ""]);
  rows.push(["Periodo", fmtDates(requestDayList(req))]);
  rows.push(["Giorni", String((req.dates || []).length)]);
  if (req.note) rows.push(["Nota", req.note]);
  const cells = rows.map(([label, value], index) => {
    const border = index < rows.length - 1 ? "border-bottom:1px solid #edf0ea;" : "";
    return `<tr><td style="padding:11px 0;${border} color:#7c8178;font-size:13px;width:38%;vertical-align:top;">${escapeHtml(label)}</td>`
      + `<td style="padding:11px 0;${border} color:#1b2321;font-size:14px;font-weight:600;vertical-align:top;">${escapeHtml(value).replace(/\n/g, "<br>")}</td></tr>`;
  }).join("");
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" '
    + 'style="background:#f5f9fc;border-radius:14px;padding:0;margin:0 0 22px;">'
    + '<tr><td style="padding:4px 18px;"><table role="presentation" width="100%" cellpadding="0" '
    + `cellspacing="0" border="0">${cells}</table></td></tr></table>`;
}

function noteBlock(note) {
  if (!note) return "";
  return `<div style="border-left:3px solid #c8d4c9;padding:2px 0 2px 14px;margin:0 0 20px;color:#4b554e;font-size:14px;line-height:1.6;font-style:italic;">${escapeHtml(note).replace(/\n/g, "<br>")}</div>`;
}

function emailFooter(cfg, req) {
  const bits = [`Email automatica di ${escapeHtml(cfg.orgName)}.`];
  if (req) bits.push(`Richiesta <span style='font-family:ui-monospace,Menlo,monospace;'>${escapeHtml(req.id)}</span>`);
  return bits.join(" · ");
}

function statusBadge(tint, ink, icon, headline, who) {
  return `<div style="background:${tint};border-radius:14px;padding:16px 18px;margin:0 0 22px;">`
    + '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>'
    + `<td width="34" height="34" style="width:34px;height:34px;border-radius:50%;background:${ink};color:#fff;font-size:17px;font-weight:700;text-align:center;vertical-align:middle;">${icon}</td>`
    + `<td style="padding-left:12px;font-size:15px;line-height:1.4;color:${ink};font-weight:700;">`
    + `${headline}<br><span style="font-weight:500;font-size:13px;color:#5a655e;">da ${escapeHtml(who)}</span>`
    + "</td></tr></table></div>";
}

/* ------------------------------ template ------------------------------- */

export function coordinatorEmail(cfg, requester, req, decideUrl, appUrl) {
  const period = fmtDates(requestDayList(req));
  let typeLabel = TYPE_LABELS[req.type] || "Richiesta";
  if (slotDetail(req)) typeLabel = `${typeLabel} (${slotDetail(req).toLowerCase()})`;
  const isAvail = req.type === "disponibilita";
  let subject;
  let intro;
  let promptTitle;
  let promptBody;
  let approveLabel;
  let rejectLabel;
  if (isAvail) {
    const availability = AVAIL_LABELS[req.availability] || "";
    subject = `Disponibilità ${availability.toLowerCase()}: ${requester.name} · ${period}`;
    intro = `${escapeHtml(requester.name)} ha comunicato la sua disponibilità: <strong>${escapeHtml(availability.toLowerCase())}</strong> nei giorni indicati.`;
    promptTitle = "Prendi visione";
    promptBody = "Apri la comunicazione per confermare di averla letta. La persona riceverà una conferma di lettura, non un'approvazione.";
    approveLabel = "Ho letto";
    rejectLabel = "Segnala da rivedere";
  } else {
    subject = `Da approvare: ${typeLabel.toLowerCase()} di ${requester.name} · ${period}`;
    intro = "È arrivata una nuova richiesta da approvare.";
    promptTitle = "Serve una tua decisione";
    promptBody = "Apri la richiesta per approvarla o rifiutarla. Il richiedente riceverà subito un'email con l'esito.";
    approveLabel = "Approva";
    rejectLabel = "Rifiuta";
  }
  let body = `<p style="margin:0 0 20px;">${intro}</p>`
    + detailsTable(req, requester)
    + noteBlock(req.note);
  body += `<p style="margin:0 0 8px;font-weight:600;color:#1b2321;">${promptTitle}</p>`
    + `<p style="margin:0 0 20px;color:#5a655e;font-size:14px;">${promptBody}</p>`;
  const approveUrl = decideUrl + "&action=approve";
  const rejectUrl = decideUrl + "&action=reject";
  body += '<p style="margin:0 0 10px;font-weight:600;color:#1b2321;">Decidi ora</p>';
  body += `<p style="margin:0 0 4px;">${button(approveUrl, approveLabel, "#2f7d63")} ${button(rejectUrl, rejectLabel, "#a4483f")}</p>`;
  body += '<p style="margin:0 0 18px;font-size:12.5px;color:#8a8172;">Si apre la pagina di conferma: nessuna decisione viene registrata senza un ultimo clic.</p>';
  body += `<p style="margin:18px 0 0;">${ghostLink(appUrl, "Apri il coordinamento")}</p>`;
  let text = (isAvail
    ? `Nuova disponibilità di ${requester.name}\n${typeLabel}\n${period}\nGiorni: ${(req.dates || []).length}\nNota: ${req.note || "-"}\n\n`
    : `Nuova richiesta di ${requester.name}\n${typeLabel}\n${period}\nGiorni: ${(req.dates || []).length}\nNota: ${req.note || "-"}\n\n`);
  text += `${approveLabel}: ${approveUrl}\n${rejectLabel}: ${rejectUrl}\nApri e decidi: ${decideUrl}\nApp: ${appUrl}\n`;
  const page = emailShell(cfg, "Richiesta da approvare", "Ferie & disponibilità", body,
    emailFooter(cfg, req),
    `${typeLabel} di ${requester.name}, ${period}`, "#b4842a");
  return { subject, html: page, text };
}

function availabilityOutcomeEmail(cfg, requester, req, coordinatorName, decisionNote, appUrl) {
  const read = req.status === "approved";
  const period = fmtDates(requestDayList(req));
  const availability = AVAIL_LABELS[req.availability] || "";
  const who = coordinatorName || "il coordinatore";
  let subject;
  let headline;
  let tint;
  let ink;
  let icon;
  let accent;
  let explain;
  let preheader;
  if (read) {
    subject = `✓ Comunicazione letta · ${period}`;
    headline = "Il coordinatore ha preso visione della tua comunicazione";
    tint = "#eaf2f8"; ink = "#075a8a"; icon = "✓"; accent = "#005f96";
    explain = `Hai comunicato <strong>${escapeHtml(availability.toLowerCase())}</strong> e il coordinatore l'ha letta. Non serve nessuna azione da parte tua.`;
    preheader = `Comunicazione letta, ${period}`;
  } else {
    subject = `✕ Comunicazione da rivedere · ${period}`;
    headline = "Il coordinatore ha letto la tua comunicazione e ti chiede di verificarla";
    tint = "#fbf2e0"; ink = "#8a6a1f"; icon = "!"; accent = "#b4842a";
    explain = `Hai comunicato <strong>${escapeHtml(availability.toLowerCase())}</strong> e il coordinatore segnala che va rivista.`;
    preheader = `Comunicazione da rivedere, ${period}`;
  }
  let body = statusBadge(tint, ink, icon, headline, who);
  body += detailsTable(req, requester);
  body += `<p style="margin:0 0 18px;color:#5a655e;font-size:14px;">${explain}</p>`;
  if (decisionNote) {
    body += '<p style="margin:0 0 6px;font-weight:600;color:#1b2321;">Nota del coordinatore</p>' + noteBlock(decisionNote);
  }
  body += `<p style="margin:0 0 6px;">${button(appUrl, "Apri il calendario", accent)}</p>`;
  const text = `Conferma di lettura: il coordinatore ha letto la tua comunicazione di disponibilità (${availability.toLowerCase()}, ${period}).\n`
    + `${decisionNote ? "Nota: " + decisionNote : ""}\n${appUrl}\n`;
  const html = emailShell(cfg, "Conferma di lettura", "Ferie & disponibilità", body,
    emailFooter(cfg, req), preheader, accent);
  return { subject, html, text };
}

export function outcomeEmail(cfg, requester, req, coordinatorName, decisionNote, appUrl) {
  if (req.type === "disponibilita") {
    return availabilityOutcomeEmail(cfg, requester, req, coordinatorName, decisionNote, appUrl);
  }
  const approved = req.status === "approved";
  const typeLabel = TYPE_LABELS[req.type] || "Richiesta";
  const requestLabel = typeLabel + (slotDetail(req) ? " · " + slotDetail(req) : "");
  const period = fmtDates(requestDayList(req));
  const outcomeWord = approved ? "approvata" : "rifiutata";
  const subject = `${approved ? "✓" : "✕"} ${approved ? "Richiesta approvata" : "Richiesta rifiutata"} · ${period}`;
  const accent = approved ? "#2f7d63" : "#a4483f";
  const tint = approved ? "#e9f4ec" : "#fbeceb";
  const ink = approved ? "#1f6f57" : "#a4483f";
  let body = statusBadge(tint, ink, approved ? "✓" : "✕",
    `La tua richiesta è stata ${outcomeWord}`, coordinatorName || "il coordinatore");
  body += detailsTable(req, requester);
  if (decisionNote) {
    body += '<p style="margin:0 0 6px;font-weight:600;color:#1b2321;">Nota del coordinatore</p>' + noteBlock(decisionNote);
  }
  if (approved) {
    body += '<p style="margin:0 0 18px;color:#5a655e;font-size:14px;">I giorni sono ora visibili nel calendario condiviso. In allegato trovi il file <strong>.ics</strong> per aggiungerli al tuo calendario personale.</p>';
  }
  body += `<p style="margin:0 0 6px;">${button(appUrl, "Apri il calendario", accent)}</p>`;
  const subjectWhat = "la tua richiesta di " + requestLabel.toLowerCase();
  const text = `${subjectWhat.charAt(0).toUpperCase() + subjectWhat.slice(1)} (${period}) è stata ${outcomeWord} da ${coordinatorName || "il coordinatore"}.\n`
    + `${decisionNote ? "Nota: " + decisionNote : ""}\n${appUrl}\n`;
  const html = emailShell(cfg, "Esito della richiesta", "Ferie & disponibilità", body,
    emailFooter(cfg, req), `${subjectWhat.charAt(0).toUpperCase() + subjectWhat.slice(1)} ${outcomeWord}`, accent);
  return { subject, html, text };
}

export function reminderEmail(cfg, requester, req, decideUrl, appUrl, hours) {
  const period = fmtDates(requestDayList(req));
  let typeLabel = TYPE_LABELS[req.type] || "Richiesta";
  if (slotDetail(req)) typeLabel = `${typeLabel} (${slotDetail(req).toLowerCase()})`;
  const rounded = Math.max(1, Math.round(hours));
  const hourWord = rounded === 1 ? "ora" : "ore";
  const subject = `Promemoria: ${typeLabel.toLowerCase()} di ${requester.name} in attesa`;
  let body = `<p style="margin:0 0 18px;">Questa richiesta è in attesa di una decisione da circa <strong>${rounded} ${hourWord}</strong>.</p>`;
  body += detailsTable(req, requester);
  body += `<p style="margin:0 0 8px;">${button(decideUrl, "Apri e decidi", "#b4842a")}</p>`;
  body += '<p style="margin:16px 0 0;font-size:12.5px;color:#8a8172;">Ricevi questo promemoria una sola volta per richiesta.</p>';
  const text = `Promemoria: la richiesta di ${requester.name} (${period}) attende una decisione da ${rounded} ${hourWord}.\n${decideUrl}\n${appUrl}\n`;
  const html = emailShell(cfg, "Richiesta in attesa", "Promemoria", body,
    emailFooter(cfg, req), `${typeLabel} di ${requester.name}, ${period}`, "#b4842a");
  return { subject, html, text };
}

export function testEmail(cfg, to) {
  let body = '<p style="margin:0 0 18px;">Se stai leggendo questo messaggio, l\'invio email è configurato correttamente.</p>';
  body += '<div style="background:#f5f9fc;border-radius:14px;padding:16px 18px;margin:0 0 18px;font-size:14px;">'
    + `<strong>Destinatario:</strong> ${escapeHtml(to)}<br><strong>Provider:</strong> ${escapeHtml(PROVIDER_LABELS[emailProvider(cfg)] || "demo")}`
    + "</div>";
  body += '<p style="margin:0;font-size:14px;color:#5a655e;">Da ora il team riceve notifiche ed esiti delle richieste.</p>';
  const html = emailShell(cfg, "Email di prova", "Configurazione", body,
    "Email di prova richiesta dal coordinatore.", "", "#005f96");
  return { subject: `Email di prova · ${cfg.orgName}`, html, text: `Email di prova: l'invio è configurato correttamente. Destinatario: ${to}` };
}

export function digestPeriodLabel(start, end) {
  if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
    return `${start.getUTCDate()}–${end.getUTCDate()} ${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()}`;
  }
  return `${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]} – ${end.getUTCDate()} ${MONTHS[end.getUTCMonth()]} ${end.getUTCFullYear()}`;
}

export function weeklyDigestEmail(cfg, rows, start, end, appUrl) {
  const total = rows.reduce((sum, row) => sum + row.entries.length, 0);
  const people = {};
  for (const row of rows) {
    for (const [requester] of row.entries) {
      people[requester.name] = (people[requester.name] || 0) + 1;
    }
  }
  const period = digestPeriodLabel(start, end);
  let subject;
  let intro;
  if (total) {
    subject = `${total} ${total === 1 ? "assenza programmata" : "assenze programmate"} la settimana prossima · ${period}`;
    intro = `<p style="margin:0 0 16px;">Ecco le assenze già approvate per la settimana <strong>${escapeHtml(fmtRange(start, end))}</strong>.</p>`;
  } else {
    subject = `Settimana prossima senza assenze · ${period}`;
    intro = `<p style="margin:0 0 16px;">Per la settimana <strong>${escapeHtml(fmtRange(start, end))}</strong> non ci sono assenze approvate.</p>`;
  }
  const cells = rows.map((row, index) => {
    const day = row.day;
    const dayLabel = `${WEEKDAYS[(day.getUTCDay() + 6) % 7].charAt(0).toUpperCase() + WEEKDAYS[(day.getUTCDay() + 6) % 7].slice(1)} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
    const names = row.entries.map(([requester, req]) => {
      let what = TYPE_LABELS[req.type] || "Assenza";
      if (slotDetail(req)) what += " · " + slotDetail(req);
      return `<div style="margin:3px 0;"><strong>${escapeHtml(requester.name)}</strong> <span style="color:#7c8178;font-size:13px;">— ${escapeHtml(what)}</span></div>`;
    }).join("");
    const border = index < rows.length - 1 ? "border-bottom:1px solid #edf0ea;" : "";
    return `<tr><td style="padding:11px 0;${border} color:#1b2321;font-size:13px;font-weight:700;width:38%;vertical-align:top;">${escapeHtml(dayLabel)}</td>`
      + `<td style="padding:11px 0;${border} color:#3f4a45;font-size:14px;vertical-align:top;">${names}</td></tr>`;
  }).join("");
  let body = intro;
  if (cells) {
    body += '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f9fc;border-radius:14px;padding:0;margin:0 0 16px;">'
      + '<tr><td style="padding:4px 18px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">'
      + cells + "</table></td></tr></table>";
  }
  if (Object.keys(people).length) {
    const bits = Object.entries(people).sort((a, b) => a[0].toLowerCase().localeCompare(b[0].toLowerCase()))
      .map(([name, count]) => `${name} ${count} ${count === 1 ? "giorno" : "giorni"}`);
    body += `<p style="margin:0 0 20px;font-size:13.5px;color:#5a655e;">In totale: ${escapeHtml(bits.join(", "))}.</p>`;
  }
  body += `<p style="margin:0;">${button(appUrl + "/", "Apri il calendario")}</p>`;

  const lines = [`Assenze della settimana prossima (${fmtRange(start, end)})`, ""];
  if (!rows.length) lines.push("Nessuna assenza approvata.");
  for (const row of rows) {
    const day = row.day;
    lines.push(`${WEEKDAYS[(day.getUTCDay() + 6) % 7]} ${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`);
    for (const [requester, req] of row.entries) {
      let what = TYPE_LABELS[req.type] || "Assenza";
      if (slotDetail(req)) what += ` (${slotDetail(req)})`;
      lines.push(`  · ${requester.name} — ${what}`);
    }
    lines.push("");
  }
  if (Object.keys(people).length) {
    lines.push("In totale: " + Object.entries(people).map(([name, count]) => `${name} ${count} ${count === 1 ? "giorno" : "giorni"}`).join(", ") + ".");
  }
  lines.push(`Apri il calendario: ${appUrl}/`);
  const html = emailShell(cfg, "Assenze della settimana prossima", "Riepilogo settimanale", body,
    "Riepilogo automatico inviato ai coordinatori.", subject, "#005f96");
  return { subject, html, text: lines.join("\n") };
}

/* -------------------------------- invio -------------------------------- */

async function postJson(url, payload, headers) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    let detail = "";
    try {
      detail = (await response.text()).slice(0, 400);
    } catch (_error) {
      detail = "";
    }
    throw new Error(`HTTP ${response.status}: ${detail || response.statusText}`);
  }
  return response;
}

/**
 * Registra l'email nel registro e prova a inviarla. Un errore del provider non
 * fa fallire l'operazione dell'app: resta scritto nel registro e nella Diagnostica.
 */
export async function sendMail(env, cfg, mail) {
  const entry = {
    id: newId("m_"),
    to: mail.to,
    subject: mail.subject,
    html: mail.html,
    text: mail.text || "",
    created_at: nowIso(),
    error: null,
    provider: null,
    reply_to: mail.replyTo || "",
    attachments: mail.attachments || [],
  };
  await insertOutbox(env, entry);
  const provider = emailProvider(cfg);
  try {
    if (provider === "resend") {
      const payload = {
        from: `${cfg.mailFromName} <${cfg.mailFrom}>`,
        to: [entry.to],
        subject: entry.subject,
        html: entry.html,
      };
      if (entry.text) payload.text = entry.text;
      if (mail.replyTo) payload.reply_to = mail.replyTo;
      else if (cfg.mailReplyTo) payload.reply_to = cfg.mailReplyTo;
      if (entry.attachments.length) payload.attachments = entry.attachments;
      const headers = { Authorization: "Bearer " + cfg.resendKey };
      if (mail.idempotencyKey) headers["Idempotency-Key"] = String(mail.idempotencyKey).slice(0, 256);
      await postJson("https://api.resend.com/emails", payload, headers);
    } else if (provider === "mailjet") {
      const message = {
        From: { Email: cfg.mailFrom, Name: cfg.mailFromName },
        To: [{ Email: entry.to }],
        Subject: entry.subject,
        HTMLPart: entry.html,
      };
      if (entry.text) message.TextPart = entry.text;
      const reply = mail.replyTo || cfg.mailReplyTo;
      if (reply) message.ReplyTo = { Email: reply };
      if (entry.attachments.length) {
        message.Attachments = entry.attachments.map((attachment) => ({
          ContentType: "text/calendar; charset=utf-8",
          Filename: attachment.filename,
          Base64Content: attachment.content,
        }));
      }
      // Mailjet non ha una chiave di idempotenza: CustomID rende riconoscibile
      // un eventuale doppione.
      if (mail.idempotencyKey) message.CustomID = String(mail.idempotencyKey).slice(0, 255);
      const credentials = btoa(`${cfg.mailjetKey}:${cfg.mailjetSecret}`);
      await postJson("https://api.mailjet.com/v3.1/send", { Messages: [message] },
        { Authorization: "Basic " + credentials });
    }
    entry.provider = provider;
  } catch (error) {
    entry.error = `${error && error.name ? error.name : "Error"}: ${error && error.message ? error.message : error}`;
    await addLog(env, "error", `Invio email fallito per ${entry.to}: ${entry.error}`);
  }
  await setOutboxResult(env, entry.id, entry.provider, entry.error);
  return entry;
}
