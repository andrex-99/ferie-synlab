/* Ferie & Disponibilità — logica dell'app (vanilla JS, nessuna dipendenza) */
(() => {
  "use strict";

  const MONTHS = ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
    "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"];
  const MONTHS_SHORT = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const WEEKDAYS = ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];
  const WEEKDAYS_SHORT = ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
  const DOW = ["lun", "mar", "mer", "gio", "ven", "sab", "dom"];
  // Fallback: il server invia la palette in /api/config e /api/users.
  const PALETTE = ["#2f7d63", "#3b6fd4", "#b56a2a", "#7a59c4", "#b0466b", "#2b8a9c",
    "#8a7a20", "#5c6b76", "#a4483f", "#3f7fa8", "#6b8f2a", "#8f5f8f"];

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const state = {
    me: null,
    config: null,
    view: "calendar",
    month: startOfMonth(new Date()),
    selected: new Set(),
    events: [],
    requests: [],
    pending: [],
    history: [],
    team: [],
    notifications: [],
    allowedTypes: ["ferie", "permesso", "disponibilita"],
    pushDevices: 0,
    form: { type: "ferie", availability: "non_disponibile", slot: "giornata",
      timeFrom: "09:00", timeTo: "13:00", note: "" },
    mode: "day",
    rangeAnchor: null,
    personFilter: "",
    stats: null,
    emailConfigured: false,
    installPrompt: null,
    loading: false,
    tour: { active: false, index: 0, steps: [], token: 0, target: null, lastFocus: null, seenThisSession: false },
  };

  /* ------------------------------ utilità ------------------------------ */

  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function parseDay(value) {
    if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }
  function addDays(d, n) { const c = new Date(d); c.setDate(c.getDate() + n); return c; }
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
  function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }
  function today() { return new Date(); }
  function cap(text) { return text.charAt(0).toUpperCase() + text.slice(1); }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function fmtLong(value) {
    const d = parseDay(value);
    return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  }

  function fmtPeriod(startValue, endValue) {
    if (!startValue) return "";
    const a = parseDay(startValue);
    const b = endValue ? parseDay(endValue) : a;
    if (iso(a) === iso(b)) return `${WEEKDAYS_SHORT[a.getDay()]} ${a.getDate()} ${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
    if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear()) {
      return `${WEEKDAYS_SHORT[a.getDay()]} ${a.getDate()} – ${WEEKDAYS_SHORT[b.getDay()]} ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
    }
    return `${WEEKDAYS_SHORT[a.getDay()]} ${a.getDate()} ${MONTHS_SHORT[a.getMonth()]}` +
      ` – ${WEEKDAYS_SHORT[b.getDay()]} ${b.getDate()} ${MONTHS_SHORT[b.getMonth()]} ${b.getFullYear()}`;
  }

  function fmtDays(dates) {
    const runs = groupRuns(Array.isArray(dates) ? dates : []);
    if (!runs.length) return "";
    if (runs.length === 1) return fmtPeriod(runs[0].start, runs[0].end);
    const labels = runs.map((run) => fmtPeriod(run.start, run.end));
    return labels.slice(0, -1).join(", ") + " e " + labels[labels.length - 1];
  }

  function fmtDaysShort(dates) {
    const runs = groupRuns(Array.isArray(dates) ? dates : []);
    if (!runs.length) return "";
    if (runs.length === 1) return fmtShortRange(runs[0].start, runs[0].end);
    const labels = runs.map((run) => fmtShortRange(run.start, run.end));
    return labels.slice(0, -1).join(", ") + " e " + labels[labels.length - 1];
  }

  function fmtShortRange(a, b) {
    const x = parseDay(a);
    const y = parseDay(b || a);
    if (iso(x) === iso(y)) return `${x.getDate()} ${MONTHS_SHORT[x.getMonth()]}`;
    if (x.getMonth() === y.getMonth() && x.getFullYear() === y.getFullYear()) {
      return `${x.getDate()}–${y.getDate()} ${MONTHS_SHORT[y.getMonth()]}`;
    }
    return `${x.getDate()} ${MONTHS_SHORT[x.getMonth()]} – ${y.getDate()} ${MONTHS_SHORT[y.getMonth()]}`;
  }

  function initials(name) {
    return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
      .map((part) => part.charAt(0)).join("").toUpperCase();
  }

  function person(id) {
    return (state.people || []).find((p) => p.id === id) || null;
  }

  function userAvatar(user, cls = "mini-avatar") {
    if (!user) return "";
    const color = user.color || "#2f7d63";
    const label = user.initials || initials(user.name);
    const image = user.avatar
      ? `<img class="avatar-img" src="${esc(user.avatar)}" alt="" loading="lazy" decoding="async">`
      : "";
    return `<span class="${cls}" style="background:${esc(color)}" aria-hidden="true">` +
      `<span class="avatar-initials">${esc(label)}</span>${image}</span>`;
  }

  function paintAvatar(host, user, fallbackName) {
    if (!host) return;
    host.setAttribute("aria-hidden", "true");
    host.style.background = user.color || "#2f7d63";
    const label = user.initials || initials(user.name || fallbackName) || "?";
    const image = user.avatar
      ? `<img class="avatar-img" src="${esc(user.avatar)}" alt="" decoding="async">`
      : "";
    host.innerHTML = `<span class="avatar-initials">${esc(label)}</span>${image}`;
  }

  function eventAvatar(ev, cls = "mini-avatar") {
    return userAvatar({
      name: ev.user_name,
      color: personColor(ev),
      avatar: ev.user_avatar,
      initials: initials(ev.user_name),
    }, cls);
  }

  // Mischiare il colore con il bianco mantiene leggibili i nomi nel tema scuro.
  function mixHex(hex, target, amount) {
    const parse = (value) => {
      const clean = String(value).replace("#", "");
      return [0, 2, 4].map((i) => parseInt(clean.slice(i, i + 2), 16) || 0);
    };
    const [r1, g1, b1] = parse(hex);
    const [r2, g2, b2] = parse(target);
    const blend = (a, b) => Math.round(a + (b - a) * amount).toString(16).padStart(2, "0");
    return `#${blend(r1, r2)}${blend(g1, g2)}${blend(b1, b2)}`;
  }

  function typeLabel(ev) {
    if (ev.type === "disponibilita") {
      return ev.availability === "disponibile" ? "Disponibile" : "Non disponibile";
    }
    if (ev.type === "permesso") {
      const slot = ev.slot && ev.slot !== "giornata" ? " · " + (ev.slot_label || ev.slot) : "";
      return "Permesso" + slot;
    }
    return "Ferie";
  }

  function personColor(ev) {
    return ev.user_color || person(ev.user_id)?.color || "#3b6fd4";
  }

  function typeGlyph(ev) {
    if (ev.type === "disponibilita") return ev.availability === "disponibile" ? "D" : "N";
    if (ev.type === "permesso") return "P";
    return "F";
  }

  function formSlotLabel() {
    if (state.form.slot === "orario") {
      return state.form.timeFrom && state.form.timeTo
        ? `${state.form.timeFrom}–${state.form.timeTo}`
        : "Orario personalizzato";
    }
    return state.form.slot ? cap(state.form.slot) : "";
  }

  function requestSubmitCopy() {
    if (state.form.type === "disponibilita" && state.form.availability !== "disponibile") {
      return {
        label: "Comunica al coordinatore",
        hint: "Il coordinatore riceve una notifica via email della modifica.",
      };
    }
    return {
      label: "Invia richiesta al coordinatore",
      hint: "Il coordinatore riceve una notifica via email e può approvare o rifiutare.",
    };
  }

  function applyRequestSubmitCopy() {
    const copy = requestSubmitCopy();
    const button = $("#btn-submit-request");
    if (button && !button.disabled) button.textContent = copy.label;
    const hint = $("#request-submit-hint");
    if (hint) hint.textContent = copy.hint;
  }

  /* ------------------------------ tema ------------------------------ */

  const THEME_KEY = "ferie-theme";
  const THEME_MODES = ["system", "light", "dark"];

  function storedTheme() {
    try {
      const value = localStorage.getItem(THEME_KEY);
      return value === "light" || value === "dark" ? value : "system";
    } catch (_) {
      return "system";
    }
  }

  function systemDark() {
    return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  }

  function effectiveDark(mode = storedTheme()) {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    return systemDark();
  }

  function applyTheme() {
    const mode = storedTheme();
    if (mode === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.dataset.theme = mode;
    const dark = effectiveDark(mode);
    $$("[data-theme-choice]").forEach((button) => {
      button.setAttribute("aria-pressed", button.dataset.themeChoice === mode ? "true" : "false");
    });
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#0e1411" : "#f4f1ea");
    if (state.me) renderCalendar();
  }

  function setTheme(mode) {
    if (!THEME_MODES.includes(mode)) return;
    try {
      if (mode === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, mode);
    } catch (_) { /* storage non disponibile */ }
    applyTheme();
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function groupRuns(values) {
    const days = Array.from(values).sort();
    const runs = [];
    days.forEach((value) => {
      const last = runs[runs.length - 1];
      if (last && iso(addDays(parseDay(last.end), 1)) === value) last.end = value;
      else runs.push({ start: value, end: value });
    });
    return runs;
  }

  /* ------------------------------ API ------------------------------ */

  async function api(path, options = {}) {
    const { method = "GET", body } = options;
    const res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    const type = res.headers.get("content-type") || "";
    if (type.includes("application/json")) data = await res.json().catch(() => null);
    if (!res.ok) {
      const error = new Error((data && data.error) || "Si è verificato un errore");
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  /* ------------------------------ toast / modal ------------------------------ */

  let toastTimer = 0;
  let modalReturnFocus = null;
  function toast(message, variant = "") {
    const box = $("#toasts");
    const node = document.createElement("div");
    node.className = "toast" + (variant ? " toast--" + variant : "");
    node.textContent = message;
    box.appendChild(node);
    window.setTimeout(() => {
      node.style.transition = "opacity .25s, transform .25s";
      node.style.opacity = "0";
      node.style.transform = "translateY(8px)";
      window.setTimeout(() => node.remove(), 260);
    }, 4200);
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { if (!box.children.length) box.innerHTML = ""; }, 5000);
  }

  function openModal(markup, onMount) {
    const modal = $("#modal");
    $("#toasts").innerHTML = "";
    modalReturnFocus = document.activeElement;
    $("#modal-body").innerHTML = markup;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    if (onMount) onMount($("#modal-body"));
    window.requestAnimationFrame(() => {
      const body = $("#modal-body");
      const first = body.querySelector("input:not([type=hidden]), textarea, select")
        || body.querySelector("button:not([data-close-modal])")
        || $("#modal .modal-close");
      if (first) first.focus({ preventScroll: true });
    });
  }

  function closeModal() {
    const wasOpen = !$("#modal").hidden;
    $("#modal").hidden = true;
    document.body.style.overflow = "";
    $("#modal-body").innerHTML = "";
    const previous = modalReturnFocus;
    modalReturnFocus = null;
    if (wasOpen && previous && previous !== document.body && document.contains(previous)) {
      previous.focus({ preventScroll: true });
    }
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-modal]")) closeModal();
  });
  // Se una foto non è più raggiungibile, restano visibili le iniziali colorate.
  document.addEventListener("error", (event) => {
    const image = event.target;
    if (image && image.tagName === "IMG" && image.classList.contains("avatar-img")) image.remove();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeModal();
      $("#user-menu").hidden = true;
      $("#notif-panel").hidden = true;
      $("#btn-bell").setAttribute("aria-expanded", "false");
      $("#btn-user").setAttribute("aria-expanded", "false");
    }
  });

  /* ------------------------------ avvio ------------------------------ */

  async function boot() {
    try {
      const session = await api("/api/session");
      state.config = session.config;
      state.notifications = session.notifications || [];
      state.allowedTypes = session.allowed_types || [];
      state.pushDevices = session.push_devices || 0;
      showApp(session.user);
      await Promise.all([loadCalendar(), loadRequests(), loadCoord()]);
      renderNotifications();
      maybeStartTour(session.user);
    } catch (error) {
      if (error.status && error.status !== 401) toast(error.message, "error");
      try {
        state.config = await api("/api/config");
      } catch (_) { /* server irraggiungibile */ }
      showLogin();
    }
  }

  function applyBrand() {
    const config = state.config || {};
    const title = config.org_short || config.org_name || "Synlab Manifattura Firenze";
    const sub = [config.org_site, config.org_brand].filter(Boolean).join(" · ") || "Ferie e disponibilità";
    $("#top-org").textContent = title;
    $("#login-org").textContent = title;
    $("#top-sub").textContent = sub;
    $("#login-sub").textContent = sub;
    if (config.org_name) document.title = config.org_name + " · Ferie";
  }

  function showLogin() {
    state.tour.seenThisSession = false;
    $("#app-screen").hidden = true;
    $("#login-screen").hidden = false;
    applyBrand();
    const demo = state.config?.demo_accounts || [];
    const box = $("#demo-box");
    if (demo.length) {
      box.hidden = false;
      $("#demo-accounts").innerHTML = demo.map((account) => `
        <li><button type="button" data-email="${esc(account.email)}" data-pin="${esc(account.pin || "")}">
          <span>${esc(account.name)}<br><span class="demo-role">${esc(cap(account.role))}</span></span>
          <span class="demo-role">PIN ${esc(account.pin || "—")}</span>
        </button></li>`).join("");
      $$("#demo-accounts button").forEach((button) => {
        button.addEventListener("click", () => {
          $("#login-email").value = button.dataset.email;
          $("#login-pin").value = button.dataset.pin;
          $("#login-pin").focus();
        });
      });
    } else {
      box.hidden = true;
    }
  }

  function roleTypes(user) {
    const map = (state.config && state.config.types_by_role) || {};
    return (user && map[user.role]) || ["ferie", "permesso", "disponibilita"];
  }

  function applyRoleTypes(user) {
    const allowed = state.allowedTypes && state.allowedTypes.length
      ? state.allowedTypes : roleTypes(user);
    state.allowedTypes = allowed;
    $$("#type-selector .segment").forEach((label) => {
      const input = label.querySelector("input");
      label.hidden = !input || !allowed.includes(input.value);
    });
    const fieldset = $("#type-selector");
    if (fieldset) {
      fieldset.dataset.count = String(allowed.length);
      fieldset.classList.toggle("is-single", allowed.length === 1);
    }
    if (!allowed.includes(state.form.type)) state.form.type = allowed[0] || "ferie";
    if (state.me) renderSide();
  }

  function showApp(user) {
    state.me = user;
    state.people = state.people || [];
    $("#login-screen").hidden = true;
    $("#app-screen").hidden = false;
    applyBrand();
    $("#user-name").textContent = user.name;
    $("#user-role").textContent = user.role;
    $("#btn-user").setAttribute("aria-label", `Menu utente di ${user.name}, ${cap(user.role)}`);
    paintAvatar($("#user-avatar"), user, user.name);
    $("#user-menu-email").textContent = user.email;
    const isCoord = user.role === "coordinatore";
    $("#tab-coord").hidden = !isCoord;
    $("#coord-quick").hidden = !isCoord;
    $("#btn-profile").hidden = false;
    applyRoleTypes(user);
    refreshPushLabel();
    const ics = state.config?.ics_url || "/calendar.ics";
    $("#ics-link").href = ics;
    switchView("calendar");
  }

  /* ------------------------------ viste ------------------------------ */

  function switchView(view) {
    state.view = view;
    $$(".view").forEach((section) => { section.hidden = section.id !== "view-" + view; });
    $$(".tab").forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    });
    const section = $("#view-" + view);
    if (section) {
      section.classList.remove("is-entering");
      void section.offsetWidth;
      section.classList.add("is-entering");
    }
    $("#notif-panel").hidden = true;
    $("#user-menu").hidden = true;
    if (view === "requests") loadRequests();
    if (view === "coord") loadCoord();
    renderSelectionBar();
    window.scrollTo({ top: 0, behavior: state.tour.active || reducedMotion() ? "auto" : "smooth" });
  }

  /* ------------------------------ tutorial ------------------------------ */

  const TOUR_KEY = "ferie-tour-v3";
  const TOUR_ICONS = {
    sparkles: '<path d="M12 3l1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"></path><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z"></path>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="3"></rect><path d="M8 3v4M16 3v4M3 10h18"></path><path d="M8.5 14.5l2 2 4-4"></path>',
    cursor: '<path d="M5 4l6 15 2.1-6.1L19 11z"></path>',
    form: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><path d="M14 3v6h6"></path><path d="M8 13h8M8 17h5"></path>',
    inbox: '<path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"></path><path d="M3 7l9 6 9-6"></path>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.9"></path><path d="M16 3.1a4 4 0 0 1 0 7.8"></path>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"></rect><path d="M3 7l9 6 9-6"></path>',
    check: '<circle cx="12" cy="12" r="9"></circle><path d="M8 12.5l2.5 2.5L16 9"></path>',
  };

  function tourKeyFor(user) {
    return TOUR_KEY + ":" + (user && (user.id || user.email) ? (user.id || user.email) : "anon");
  }

  function hasSeenTour(user) {
    if (state.tour.seenThisSession) return true;
    try { return localStorage.getItem(tourKeyFor(user)) === "1"; } catch (_) { return false; }
  }

  function markTourSeen(user) {
    state.tour.seenThisSession = true;
    try { localStorage.setItem(tourKeyFor(user), "1"); } catch (_) { /* storage non disponibile */ }
  }

  function buildTourSteps(user) {
    const firstName = String(user && user.name ? user.name : "").trim().split(/\s+/)[0] || "ciao";
    const steps = [
      {
        icon: "sparkles",
        title: "Ciao " + firstName + ", ti faccio strada",
        body: user.role === "professionista"
          ? "In meno di un minuto vediamo come comunicare la tua disponibilità e come arriva al coordinatore."
          : user.role === "coordinatore"
            ? "In meno di un minuto vediamo come arrivano le richieste, come decidi e cosa vede il team."
            : "In meno di un minuto vediamo come chiedere ferie o permessi e come la richiesta arriva al coordinatore.",
        hint: "Puoi interrompere con Salta e riaprire la guida dal punto interrogativo in alto.",
        center: true,
      },
      {
        icon: "calendar",
        view: "calendar",
        target: "#cal-grid",
        title: "Il calendario del team",
        body: "Qui vedi chi è assente e chi ha aggiornato la disponibilità. Ogni persona ha il suo colore; la lettera nel segno dice il tipo: F ferie, P permesso, N non disponibile, D disponibile.",
        hint: "Tocca un giorno o una persona per vedere i dettagli.",
      },
      {
        icon: "cursor",
        view: "calendar",
        target: ".cal-filters",
        title: "Scegli i giorni",
        body: "Tocca un giorno per selezionarlo. Usa Periodo per toccare il primo e l'ultimo giorno e coprire una settimana intera in due tocchi.",
        hint: "Su telefono, la barra in basso ti porta subito al modulo della richiesta.",
      },
      {
        icon: "form",
        view: "calendar",
        target: "#request-card",
        title: "Prepara e invia",
        body: user.role === "professionista"
          ? "Dopo la selezione qui indichi se sei disponibile o no, aggiungi una nota e invii. Il coordinatore riceve subito un'email."
          : "Dopo la selezione qui scegli Ferie o Permesso, aggiungi una nota e invia. Il coordinatore riceve subito un'email.",
      },
      {
        icon: "inbox",
        view: "requests",
        target: "#requests-list",
        title: "Controlla l'esito",
        body: user.role === "professionista"
          ? "In Richieste trovi lo stato della comunicazione: in attesa, confermata o rifiutata. Il campanello in alto segnala quando arriva una risposta."
          : "In Richieste trovi lo stato: in attesa, approvata o rifiutata. Il campanello in alto segnala quando arriva una risposta.",
      },
    ];
    if (user && user.role === "coordinatore") {
      steps.push({
        icon: "users",
        view: "coord",
        target: "#coord-stats",
        title: "La coda del coordinatore",
        body: "Qui vedi quante richieste aspettano una decisione e i giorni approvati nel mese. Approva o rifiuta dalla coda: la persona riceve l'email con l'esito.",
      });
      steps.push({
        icon: "users",
        view: "coord",
        target: "#team-card .team-head",
        title: "Crea gli accessi",
        body: "Qui vedi chi ha un accesso all'app. Con Aggiungi persona scegli nome, email, ruolo, colore personale e, se vuoi, una foto: ogni persona resta riconoscibile a colpo d'occhio.",
        hint: "Solo il coordinatore può creare nuovi accessi.",
      });
      steps.push({
        icon: "mail",
        view: "coord",
        target: "#outbox-card .mini-head",
        title: "Le email sotto controllo",
        body: "Ogni invio finisce nel registro: puoi aprire il messaggio, vedere gli errori e reinviarlo. Con un provider configurato parte tutto in automatico.",
      });
    }
    steps.push({
      icon: "check",
      center: true,
      final: true,
      title: "Tutto pronto",
      body: user && user.role === "coordinatore"
        ? "Sei pronto a gestire il team. Puoi riaprire questa guida dal punto interrogativo in alto quando vuoi."
        : "Sei pronto a inviare la tua prima richiesta. Puoi riaprire questa guida dal punto interrogativo in alto quando vuoi.",
      hint: "Suggerimento: aggiungi l'app alla schermata Home del telefono per aprirla al volo.",
    });
    return steps;
  }

  function startTour() {
    if (!state.me || state.tour.active) return;
    state.tour.lastFocus = document.activeElement;
    state.tour.steps = buildTourSteps(state.me);
    state.tour.index = 0;
    state.tour.target = null;
    state.tour.active = true;
    state.tour.token += 1;
    $("#user-menu").hidden = true;
    $("#notif-panel").hidden = true;
    $("#btn-bell").setAttribute("aria-expanded", "false");
    $("#btn-user").setAttribute("aria-expanded", "false");
    closeModal();
    document.body.classList.add("tour-open");
    const overlay = $("#tour");
    overlay.hidden = false;
    const app = $("#app-screen");
    $("#tour-card").focus({ preventScroll: true });
    app.inert = true;
    app.setAttribute("aria-hidden", "true");
    showTourStep();
  }

  function endTour(mark = true, showToast = true, completed = true) {
    if (!state.tour.active) return;
    state.tour.active = false;
    state.tour.token += 1;
    state.tour.target = null;
    const overlay = $("#tour");
    overlay.hidden = true;
    overlay.classList.remove("has-target");
    $("#tour-spotlight").hidden = true;
    document.body.classList.remove("tour-open");
    const app = $("#app-screen");
    app.inert = false;
    app.removeAttribute("aria-hidden");
    if (mark && state.me) markTourSeen(state.me);
    if (state.view !== "calendar") switchView("calendar");
    const previous = state.tour.lastFocus;
    state.tour.lastFocus = null;
    const canRestore = previous && previous !== document.body && previous !== document.documentElement
      && typeof previous.focus === "function" && document.contains(previous);
    if (canRestore) previous.focus({ preventScroll: true });
    else $("#btn-help").focus({ preventScroll: true });
    if (showToast) {
      toast(completed
        ? "Tutorial completato. Puoi riaprirlo dal ? in alto."
        : "Tutorial chiuso. Puoi riaprirlo dal ? in alto.", "success");
    }
  }

  function showTourStep() {
    if (!state.tour.active) return;
    const steps = state.tour.steps;
    const step = steps[state.tour.index];
    if (!step) return;
    state.tour.token += 1;
    const token = state.tour.token;
    const total = steps.length;
    $("#tour-step").textContent = "Passo " + (state.tour.index + 1) + " di " + total;
    $("#tour-title").textContent = step.title;
    $("#tour-body").textContent = step.body;
    const hint = $("#tour-hint");
    hint.hidden = !step.hint;
    hint.textContent = step.hint || "";
    $("#tour-art").innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (TOUR_ICONS[step.icon] || TOUR_ICONS.sparkles) + "</svg>";
    $("#tour-dots").innerHTML = steps.map((_, index) =>
      '<span class="tour-dot' + (index === state.tour.index ? " is-active" : "") + '"></span>').join("");
    $("#tour-prev").hidden = state.tour.index === 0;
    $("#tour-next").textContent = state.tour.index === total - 1 ? "Inizia" : "Avanti";
    $("#tour-live").textContent = "Passo " + (state.tour.index + 1) + " di " + total + ": " + step.title;
    if (step.view) switchView(step.view);

    const started = performance.now();
    const attempt = () => {
      if (!state.tour.active || token !== state.tour.token) return;
      const target = step.target ? $(step.target) : null;
      const visible = target && target.getClientRects().length > 0;
      if (step.target && !visible && performance.now() - started < 1200) {
        window.setTimeout(attempt, 80);
        return;
      }
      const finalTarget = visible ? target : null;
      if (finalTarget) {
        finalTarget.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
      }
      window.setTimeout(() => {
        if (!state.tour.active || token !== state.tour.token) return;
        positionTour(finalTarget);
        animateTourCard();
        $("#tour-next").focus({ preventScroll: true });
      }, finalTarget ? 70 : 30);
    };
    attempt();
  }

  function animateTourCard() {
    const card = $("#tour-card");
    card.classList.remove("is-entering");
    void card.offsetWidth;
    card.classList.add("is-entering");
  }

  function positionTour(target) {
    const card = $("#tour-card");
    const overlay = $("#tour");
    const spot = $("#tour-spotlight");
    state.tour.target = target || null;
    card.classList.remove("is-center", "is-mobile-top", "is-mobile-bottom");
    card.style.left = "";
    card.style.right = "";
    card.style.top = "";
    card.style.bottom = "";
    card.style.width = "";
    overlay.classList.toggle("has-target", !!target);
    if (!target) {
      card.classList.add("is-center");
      spot.hidden = true;
      return;
    }
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      card.classList.add("is-center");
      spot.hidden = true;
      return;
    }
    const pad = 8;
    const spotTop = Math.max(6, rect.top - pad);
    const spotLeft = Math.max(6, rect.left - pad);
    spot.hidden = false;
    spot.style.top = spotTop + "px";
    spot.style.left = spotLeft + "px";
    spot.style.width = Math.min(window.innerWidth - spotLeft - 6, rect.width + pad * 2) + "px";
    spot.style.height = Math.min(window.innerHeight - spotTop - 6, rect.height + pad * 2) + "px";
    spot.style.borderRadius = target.matches(".cal-filters, .tabs, .mode-toggle") ? "999px" : "16px";

    if (window.innerWidth <= 760) {
      const center = rect.top + rect.height / 2;
      card.classList.add(center > window.innerHeight * 0.54 ? "is-mobile-top" : "is-mobile-bottom");
      return;
    }

    const cardWidth = card.offsetWidth || 400;
    const cardHeight = card.offsetHeight || 260;
    const gap = 18;
    let left;
    let top;
    if (rect.height > window.innerHeight * 0.64) {
      const targetOnRight = rect.left + rect.width / 2 > window.innerWidth / 2;
      left = targetOnRight ? rect.left - cardWidth - gap : rect.right + gap;
      left = Math.max(16, Math.min(left, window.innerWidth - cardWidth - 16));
      top = Math.max(84, Math.min(rect.top + 24, window.innerHeight - cardHeight - 16));
    } else if (rect.width > window.innerWidth * 0.58) {
      left = window.innerWidth - cardWidth - 24;
      top = window.innerHeight - cardHeight - 24;
    } else {
      left = rect.right + gap;
      if (left + cardWidth > window.innerWidth - 16) left = rect.left - cardWidth - gap;
      left = Math.max(16, Math.min(left, window.innerWidth - cardWidth - 16));
      top = rect.top + rect.height / 2 - cardHeight / 2;
      top = Math.max(84, Math.min(top, window.innerHeight - cardHeight - 16));
    }
    card.style.left = Math.round(left) + "px";
    card.style.top = Math.round(top) + "px";
  }

  function nextTourStep() {
    if (!state.tour.active) return;
    if (state.tour.index >= state.tour.steps.length - 1) {
      endTour(true, true);
      return;
    }
    state.tour.index += 1;
    showTourStep();
  }

  function previousTourStep() {
    if (!state.tour.active || state.tour.index === 0) return;
    state.tour.index -= 1;
    showTourStep();
  }

  function maybeStartTour(user) {
    if (!user || hasSeenTour(user)) return;
    window.setTimeout(() => {
      if (!state.me || state.me.id !== user.id || state.tour.active) return;
      if (!$("#modal").hidden) return;
      startTour();
    }, 1000);
  }

  document.addEventListener("keydown", (event) => {
    if (!state.tour.active) return;
    if (event.key === "Escape") {
      event.preventDefault();
      endTour(true, true, false);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      nextTourStep();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      previousTourStep();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = Array.from($("#tour-card").querySelectorAll("button:not([hidden]):not([disabled])"));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (state.tour.active) positionTour(state.tour.target);
  });
  window.addEventListener("scroll", () => {
    if (state.tour.active) positionTour(state.tour.target);
  }, { passive: true });

  /* ------------------------------ calendario ------------------------------ */

  function gridBounds() {
    const first = startOfMonth(state.month);
    const offset = (first.getDay() + 6) % 7;
    const start = addDays(first, -offset);
    const cells = Math.ceil((offset + daysInMonth(state.month)) / 7) * 7;
    return { start, cells };
  }

  async function loadCalendar() {
    const { start, cells } = gridBounds();
    const from = iso(start);
    const to = iso(addDays(start, cells + 62));
    try {
      const data = await api(`/api/calendar?from=${from}&to=${to}`);
      state.events = data.events;
      state.people = data.people;
      populatePeople();
      renderCalendar();
      renderSide();
      renderUpcoming();
    } catch (error) {
      if (error.status === 401) return handleExpired();
      toast(error.message, "error");
    }
  }

  function populatePeople() {
    const select = $("#person-filter");
    if (!select) return;
    const current = state.personFilter;
    const options = ['<option value="">Tutto il team</option>'];
    state.people.forEach((p) => {
      options.push(`<option value="${esc(p.id)}">${esc(p.name)}</option>`);
    });
    select.innerHTML = options.join("");
    if (current && state.people.some((p) => p.id === current)) select.value = current;
    else state.personFilter = "";
  }

  function renderCalendar() {
    const grid = $("#cal-grid");
    const { start, cells } = gridBounds();
    const monthIndex = state.month.getMonth();
    const todayIso = iso(today());
    const visibleEvents = state.events.filter((ev) => !state.personFilter || ev.user_id === state.personFilter);
    const byDay = new Map();
    visibleEvents.forEach((ev) => {
      (ev.dates || []).forEach((day) => {
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(ev);
      });
    });

    $("#cal-title").textContent = `${cap(MONTHS[monthIndex])} ${state.month.getFullYear()}`;

    const parts = [];
    DOW.forEach((label, index) => {
      const sunday = index === 6 ? " cal-dow--sunday" : "";
      parts.push(`<div class="cal-dow${index > 4 ? " cal-dow--we" : ""}${sunday}" role="columnheader">${label}</div>`);
    });

    const alpha = effectiveDark() ? "42" : "16";
    for (let i = 0; i < cells; i += 1) {
      const d = addDays(start, i);
      const key = iso(d);
      const inMonth = d.getMonth() === monthIndex;
      const selected = state.selected.has(key);
      const isPast = key < todayIso;
      const isToday = key === todayIso;
      const weekend = d.getDay() === 0 || d.getDay() === 6;
      const events = (byDay.get(key) || []).slice().sort((a, b) => {
        const order = { ferie: 0, permesso: 1, disponibilita: 2 };
        if (order[a.type] !== order[b.type]) return (order[a.type] || 0) - (order[b.type] || 0);
        return a.user_name.localeCompare(b.user_name);
      });
      const visible = events.slice(0, 3);
      const extra = events.length - visible.length;

      let cls = "cal-day";
      if (!inMonth) cls += " cal-day--outside";
      if (weekend) cls += " cal-day--weekend";
      if (d.getDay() === 0) cls += " cal-day--sunday";
      if (isPast) cls += " cal-day--past";
      if (isToday) cls += " cal-day--today";
      if (selected) cls += " cal-day--selected";
      if (key === state.rangeAnchor) cls += " cal-day--anchor";
      if (events.some((ev) => ev.status === "approved" && (ev.type === "ferie" || ev.type === "permesso"))) {
        cls += " cal-day--has-absent";
      }

      const chips = visible.map((ev) => {
        const pending = ev.status === "pending";
        const color = personColor(ev);
        const textColor = effectiveDark() ? mixHex(color, "#ffffff", .5) : color;
        return `<span class="chip${pending ? " chip--pending" : ""}" data-day="${key}" role="button" tabindex="0"
            title="${esc(ev.user_name)} · ${esc(typeLabel(ev))}${pending ? " · in attesa" : ""}"
            style="color:${textColor};background:${color}${alpha}">
            <span class="chip-dot" style="background:${color}">${esc(typeGlyph(ev))}</span>
            <span class="chip-name">${esc(ev.user_name.split(" ")[0])}</span>
          </span>`;
      }).join("");

      parts.push(`<div class="${cls}" data-day="${key}" role="gridcell" tabindex="0"
          aria-selected="${selected}" aria-label="${esc(fmtLong(key))}">
        <span class="cal-num">${d.getDate()}</span>
        <span class="chips">${chips}${extra > 0 ? `<span class="chip chip--more">+${extra}</span>` : ""}</span>
      </div>`);
    }
    grid.innerHTML = parts.join("");
  }

  function selectRange(first, second) {
    let start = parseDay(first);
    let end = parseDay(second);
    if (start > end) { const swap = start; start = end; end = swap; }
    const todayDate = today();
    if (start < todayDate) start = todayDate;
    const limit = addDays(todayDate, 90);
    if (end > limit) {
      end = limit;
      toast("Il periodo è stato fermato a 90 giorni: è il massimo per una richiesta.");
    }
    state.selected.clear();
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) state.selected.add(iso(d));
    state.rangeAnchor = null;
    renderCalendar();
    renderSide();
    renderSelectionBar();
  }

  function selectWeek(offset) {
    const base = today();
    const weekday = (base.getDay() + 6) % 7;
    let monday = addDays(base, -weekday + offset * 7);
    if (offset === 0 && iso(addDays(monday, 4)) < iso(base)) monday = addDays(monday, 7);
    const start = offset === 0 && monday < base ? base : monday;
    selectRange(iso(start), iso(addDays(monday, 4)));
  }

  function toggleDay(key, shift) {
    if (key < iso(today())) {
      toast("Non puoi selezionare giorni già passati.");
      return;
    }
    if (state.mode === "range" || shift) {
      if (!state.rangeAnchor) {
        state.rangeAnchor = key;
        state.selected = new Set([key]);
        toast("Ora tocca l'ultimo giorno del periodo.");
        renderCalendar();
        renderSide();
        renderSelectionBar();
        return;
      }
      selectRange(state.rangeAnchor, key);
      return;
    }
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.add(key);
    state.rangeAnchor = null;
    renderCalendar();
    renderSide();
    renderSelectionBar();
  }

  function renderSelectionBar() {
    const bar = $("#selection-bar");
    const count = state.selected.size;
    bar.hidden = count === 0 || state.view !== "calendar";
    $("#selection-count").textContent = count;
    $("#selection-label").textContent = count === 1 ? "giorno selezionato" : "giorni selezionati";
  }

  function renderSide() {
    applyRequestSubmitCopy();
    const hasSelection = state.selected.size > 0;
    $("#request-form").hidden = !hasSelection;
    $("#request-empty").hidden = hasSelection;
    $("#request-card").classList.toggle("is-empty", !hasSelection);
    if (!hasSelection) return;

    const runs = groupRuns(state.selected);
    $("#selected-list").innerHTML = runs.map((run) => `
      <span class="date-pill">${esc(fmtShortRange(run.start, run.end))}
        <button type="button" data-remove-start="${run.start}" data-remove-end="${run.end}"
          aria-label="Rimuovi ${esc(fmtShortRange(run.start, run.end))}">×</button>
      </span>`).join("");

    $("#availability-selector").hidden = state.form.type !== "disponibilita";
    $("#slot-field").hidden = state.form.type !== "permesso";
    $("#time-range-field").hidden = !(state.form.type === "permesso" && state.form.slot === "orario");
    $$('input[name="type"]').forEach((input) => { input.checked = input.value === state.form.type; });
    $$('input[name="availability"]').forEach((input) => { input.checked = input.value === state.form.availability; });
    $("#request-slot").value = state.form.slot || "giornata";
    $("#request-time-from").value = state.form.timeFrom;
    $("#request-time-to").value = state.form.timeTo;
    $("#request-note").value = state.form.note;
    $("#note-count").textContent = state.form.note.length;

    const typeName = state.form.type === "ferie"
      ? "Ferie"
      : state.form.type === "permesso"
        ? "Permesso" + (state.form.slot && state.form.slot !== "giornata" ? " · " + formSlotLabel() : "")
        : (state.form.availability === "disponibile" ? "Disponibile" : "Non disponibile");
    const runLabels = runs.map((run) => fmtShortRange(run.start, run.end));
    const periodLabel = runLabels.length === 1
      ? runLabels[0]
      : runLabels.slice(0, -1).join(", ") + " e " + runLabels[runLabels.length - 1];
    $("#request-summary-text").textContent = `${typeName} · ${periodLabel}`;
    $("#request-summary-days").textContent = `${state.selected.size} ${state.selected.size === 1 ? "giorno" : "giorni"}`;
    renderConflict();
  }

  function renderConflict() {
    const box = $("#conflict-box");
    if (!["ferie", "permesso"].includes(state.form.type) || state.selected.size === 0) {
      box.hidden = true;
      return;
    }
    const others = state.events.filter((ev) => ev.user_id !== state.me.id
      && ["ferie", "permesso"].includes(ev.type) && ev.status === "approved");
    const names = [];
    others.forEach((ev) => {
      const overlap = (ev.dates || []).filter((day) => state.selected.has(day));
      if (overlap.length && !names.includes(ev.user_name)) names.push(ev.user_name);
    });
    if (!names.length) {
      box.hidden = true;
      return;
    }
    const list = names.length === 1 ? names[0] : names.slice(0, 2).join(" e ") + (names.length > 2 ? ` e altri ${names.length - 2}` : "");
    box.hidden = false;
    box.innerHTML = `<strong>Attenzione:</strong> ${esc(list)} ${names.length === 1 ? "è già assente" : "sono già assenti"} in alcuni dei giorni scelti. Puoi inviare comunque la richiesta.`;
  }

  function renderUpcoming() {
    const start = iso(today());
    const items = state.events
      .filter((ev) => ev.status === "approved" && ev.end >= start
        && (!state.personFilter || ev.user_id === state.personFilter))
      .sort((a, b) => (a.start || "").localeCompare(b.start || ""))
      .slice(0, 5);
    const list = $("#upcoming-list");
    if (!items.length) {
      list.innerHTML = '<li class="mini-empty">Nessuna assenza in programma.</li>';
      return;
    }
    list.innerHTML = items.map((ev) => `
      <li>
        ${eventAvatar(ev)}
        <span class="mini-main">
          <span class="mini-name">${esc(ev.user_name)}</span>
          <span class="mini-when">${esc(typeLabel(ev))} · ${esc(fmtDays(ev.dates))}${ev.days > 1 ? ` · ${ev.days} gg` : ""}</span>
        </span>
      </li>`).join("");
  }

  function openDayDetail(key) {
    const events = state.events.filter((ev) => (ev.dates || []).includes(key));
    if (!events.length) {
      toast("Nessun evento registrato in questo giorno.");
      return;
    }
    const items = events.map((ev) => `
      <div class="day-detail-item">
        ${eventAvatar(ev)}
        <div>
          <div class="day-detail-name">${esc(ev.user_name)}</div>
          <div class="day-detail-meta">${esc(typeLabel(ev))} · ${esc(fmtDays(ev.dates))}
            ${ev.status === "pending" ? " · in attesa" : ""}</div>
          ${ev.note ? `<div class="day-detail-meta">“${esc(ev.note)}”</div>` : ""}
        </div>
      </div>`).join("");
    openModal(`<h3>${esc(fmtLong(key))}</h3><p class="modal-sub">${events.length} ${events.length === 1 ? "evento" : "eventi"} nel calendario</p>${items}`);
  }

  /* ------------------------------ richieste ------------------------------ */

  async function loadRequests() {
    try {
      const data = await api("/api/requests");
      state.requests = data.requests;
      renderRequests();
      const active = state.requests.filter((r) => r.status === "pending").length;
      $("#tab-requests-count").hidden = active === 0;
      $("#tab-requests-count").textContent = active;
    } catch (error) {
      if (error.status === 401) return handleExpired();
      toast(error.message, "error");
    }
  }

  function statusPill(status) {
    const map = {
      pending: ["status--pending", "In attesa"],
      approved: ["status--approved", "Approvata"],
      rejected: ["status--rejected", "Rifiutata"],
      cancelled: ["status--cancelled", "Annullata"],
    };
    const [cls, label] = map[status] || ["status--pending", status];
    return `<span class="status-pill ${cls}">${label}</span>`;
  }

  function renderRequests() {
    const box = $("#requests-list");
    if (!state.requests.length) {
      const intro = state.me && state.me.role === "professionista"
        ? "Quando comunichi la tua disponibilità la trovi qui con l'esito."
        : "Quando chiedi ferie o permessi li trovi qui con l'esito.";
      box.innerHTML = `<div class="empty-state"><h3>Nessuna richiesta</h3><p>${intro}</p></div>`;
      return;
    }
    box.innerHTML = state.requests.map((req) => `
      <article class="req-card">
        <div class="req-top">
          <div>
            <div class="req-type"><span class="dot" style="background:${esc(personColor(req))}"></span>
              ${esc(typeLabel(req))}</div>
            <div class="req-period">${esc(fmtDays(req.dates))} · ${req.days} ${req.days === 1 ? "giorno" : "giorni"}</div>
          </div>
          ${statusPill(req.status)}
        </div>
        ${req.note ? `<div class="req-note">${esc(req.note)}</div>` : ""}
        <div class="req-foot">
          <span>${req.status === "pending"
            ? "In attesa del coordinatore"
            : req.status === "cancelled"
              ? esc(req.decision_note || "Annullata")
              : `Decisa il ${esc(new Date(req.decided_at).toLocaleDateString("it-IT"))}${req.decided_by_name ? " da " + esc(req.decided_by_name) : ""}`}
            ${req.status !== "cancelled" && req.decision_note ? ` · “${esc(req.decision_note)}”` : ""}</span>
          ${req.status === "pending"
            ? `<div class="req-actions"><button class="btn btn--ghost btn--xs" type="button" data-cancel="${req.id}">Annulla</button></div>`
            : req.status === "approved"
              ? `<div class="req-actions"><button class="btn btn--ghost btn--xs" type="button" data-withdraw="${req.id}">Ritira</button></div>`
              : ""}
        </div>
      </article>`).join("");
  }

  async function submitRequest(event) {
    event.preventDefault();
    if (!state.selected.size) return;
    if (state.form.type === "permesso" && state.form.slot === "orario") {
      if (!state.form.timeFrom || !state.form.timeTo) {
        toast("Indica l'orario di inizio e di fine del permesso.", "error");
        return;
      }
      if (state.form.timeTo <= state.form.timeFrom) {
        toast("L'orario di fine deve essere successivo a quello di inizio.", "error");
        return;
      }
    }
    const button = $("#btn-submit-request");
    button.disabled = true;
    button.textContent = "Invio in corso…";
    try {
      const data = await api("/api/requests", {
        method: "POST",
        body: {
          type: state.form.type,
          availability: state.form.type === "disponibilita" ? state.form.availability : null,
          slot: state.form.type === "permesso" ? state.form.slot : null,
          time_from: state.form.type === "permesso" && state.form.slot === "orario" ? state.form.timeFrom : null,
          time_to: state.form.type === "permesso" && state.form.slot === "orario" ? state.form.timeTo : null,
          dates: Array.from(state.selected),
          note: state.form.note,
        },
      });
      state.selected.clear();
      state.rangeAnchor = null;
      state.form.note = "";
      $("#request-note").value = "";
      $("#note-count").textContent = "0";
      const notified = (data.notified || []).length;
      const availabilityNotice = state.form.type === "disponibilita" && state.form.availability !== "disponibile";
      if (data.warning) toast(data.warning, "warn");
      else toast(notified
        ? (availabilityNotice ? "Comunicazione inviata al coordinatore." : "Richiesta inviata al coordinatore.")
        : (availabilityNotice ? "Comunicazione registrata." : "Richiesta registrata."), "success");
      await Promise.all([loadCalendar(), loadRequests(), loadCoord()]);
      renderSide();
      renderSelectionBar();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      button.disabled = false;
      button.textContent = requestSubmitCopy().label;
    }
  }

  async function cancelRequest(id) {
    try {
      await api(`/api/requests/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
      toast("Richiesta annullata.");
      await Promise.all([loadCalendar(), loadRequests(), loadCoord()]);
    } catch (error) {
      toast(error.message, "error");
    }
  }

  function withdrawRequest(id) {
    const req = state.requests.find((item) => item.id === id);
    if (!req) return;
    openModal(`
      <h3>Ritirare la richiesta?</h3>
      <p class="modal-sub">${esc(typeLabel(req))} · ${esc(fmtDays(req.dates))}</p>
      <p class="field-hint">La richiesta era già approvata: i giorni spariranno dal calendario del team e il coordinatore vedrà che l'hai ritirata.</p>
      <div class="modal-actions">
        <button class="btn btn--ghost btn--sm" type="button" data-close-modal>Lascia com'è</button>
        <button class="btn btn--danger btn--sm" id="btn-confirm-withdraw" type="button">Ritira richiesta</button>
      </div>`, (root) => {
      $("#btn-confirm-withdraw", root).addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "Ritiro…";
        try {
          await api(`/api/requests/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} });
          closeModal();
          toast("Richiesta ritirata: i giorni non sono più nel calendario.");
          await Promise.all([loadCalendar(), loadRequests(), loadCoord()]);
        } catch (error) {
          toast(error.message, "error");
          button.disabled = false;
          button.textContent = "Ritira richiesta";
        }
      });
    });
  }

  /* ------------------------------ coordinamento ------------------------------ */

  const ROLE_LABELS = { dipendente: "Dipendente", professionista: "Professionista", coordinatore: "Coordinatore" };

  async function loadCoord() {
    if (!state.me || state.me.role !== "coordinatore") return;
    try {
      const data = await api("/api/requests/pending");
      state.pending = data.pending;
      state.history = data.history;
      state.stats = data.stats || null;
      renderCoord();
      renderStats();
      $("#tab-coord-count").hidden = state.pending.length === 0;
      $("#tab-coord-count").textContent = state.pending.length;
      $("#coord-pending-pill").textContent = state.pending.length;
      $("#coord-pending-text").textContent = state.pending.length
        ? `${state.pending.length} richiesta${state.pending.length > 1 ? "e" : ""} da approvare o rifiutare.`
        : "Nessuna richiesta in attesa.";
      await loadTeam();
      loadOutbox();
    } catch (error) {
      if (error.status === 401) return handleExpired();
      toast(error.message, "error");
    }
  }

  async function loadTeam() {
    if (!state.me || state.me.role !== "coordinatore") return;
    try {
      const data = await api("/api/users");
      state.team = data.users || [];
      renderTeam();
    } catch (error) {
      if (error.status === 401) return handleExpired();
      toast(error.message, "error");
    }
  }

  function renderTeam() {
    const list = $("#team-list");
    if (!list) return;
    const count = state.team.length;
    $("#team-hint").textContent = count
      ? `${count} ${count === 1 ? "persona con accesso" : "persone con accesso"} · solo il coordinatore può crearne di nuove.`
      : "Crea gli accessi per i colleghi della Radiologia.";
    list.innerHTML = state.team.map((user) => `
      <li>
        <button class="team-row" type="button" data-edit-user="${esc(user.id)}" title="Cambia colore e foto di ${esc(user.name)}">
          ${userAvatar(user)}
          <span class="team-info">
            <span class="team-name"><span class="team-fullname">${esc(user.name)}</span>${state.me && user.id === state.me.id ? '<span class="team-you">tu</span>' : ""}</span>
            <span class="team-email">${esc(user.email)}</span>
          </span>
          <span class="role-pill role-pill--${esc(user.role)}">${esc(ROLE_LABELS[user.role] || cap(user.role))}</span>
        </button>
      </li>`).join("");
  }

  function randomPin() {
    if (window.crypto && window.crypto.getRandomValues) {
      const values = new Uint32Array(1);
      window.crypto.getRandomValues(values);
      return String(100000 + (values[0] % 900000));
    }
    return String(Math.floor(100000 + Math.random() * 900000));
  }

  function palette() {
    return (state.config && state.config.palette) || PALETTE;
  }

  function usedColors(excludeId) {
    return (state.team || []).filter((user) => user.id !== excludeId);
  }

  function suggestColor(excludeId) {
    const colors = palette();
    const used = usedColors(excludeId);
    const counts = colors.map((color) => used.filter((user) => user.color === color).length);
    return colors[counts.indexOf(Math.min(...counts))] || colors[0];
  }

  function colorPickerMarkup(selected, excludeId) {
    const used = usedColors(excludeId);
    return palette().map((color) => {
      const owners = used.filter((user) => user.color === color).map((user) => user.name);
      const title = owners.length
        ? "In uso da " + owners.slice(0, 2).join(", ") + (owners.length > 2 ? " e altri" : "")
        : "Colore libero";
      return `<label class="color-pick${owners.length ? " color-pick--used" : ""}" style="--pick:${color}" title="${esc(title)}">
        <input type="radio" name="color" value="${color}" ${color === selected ? "checked" : ""}>
        <span class="color-pick-dot" aria-hidden="true"></span>
        <span class="sr-only">Colore ${color} · ${esc(title)}</span>
      </label>`;
    }).join("");
  }

  function avatarFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
        reject(new Error("Scegli un'immagine JPG, PNG o WebP."));
        return;
      }
      const reader = new FileReader();
      const image = new Image();
      const fail = () => reject(new Error("Formato non supportato. Prova con una foto JPG o PNG."));
      reader.onerror = fail;
      reader.onload = () => { image.src = String(reader.result); };
      image.onerror = fail;
      image.onload = () => {
        try {
          const side = Math.min(image.naturalWidth, image.naturalHeight);
          const size = 256;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas non disponibile");
          context.fillStyle = "#f4f1ea";
          context.fillRect(0, 0, size, size);
          context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
            side, side, 0, 0, size, size);
          let quality = .84;
          let data = canvas.toDataURL("image/jpeg", quality);
          while (data.length > 82000 && quality > .4) {
            quality -= .12;
            data = canvas.toDataURL("image/jpeg", quality);
          }
          if (data.length > 90000) {
            reject(new Error("La foto ha troppi dettagli: provane una più semplice."));
            return;
          }
          resolve(data);
        } catch (_) {
          reject(new Error("Non riesco a preparare questa immagine."));
        }
      };
      reader.readAsDataURL(file);
    });
  }

  function wirePhotoPicker(root, draft, refresh) {
    const fileInput = $("[data-photo-file]", root);
    const choose = $("[data-photo]", root);
    const clear = $("[data-photo-clear]", root);
    choose.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      const previous = choose.textContent;
      choose.disabled = true;
      choose.textContent = "Preparo…";
      try {
        draft.avatar = await avatarFromFile(file);
        refresh();
      } catch (error) {
        toast(error.message, "error");
      } finally {
        choose.disabled = false;
        choose.textContent = previous;
        fileInput.value = "";
      }
    });
    clear.addEventListener("click", () => {
      draft.avatar = "";
      refresh();
    });
  }

  function appearancePreview(target, draft) {
    const current = draft.avatar === undefined ? target.avatar : draft.avatar;
    return userAvatar({ name: target.name, color: draft.color || target.color, avatar: current,
      initials: initials(target.name) }, "avatar avatar--lg");
  }

  function openAddUser() {
    if (!state.me || state.me.role !== "coordinatore") return;
    const draft = { avatar: "", color: suggestColor() };
    openModal(`
      <h3>Aggiungi persona</h3>
      <p class="modal-sub">Crea l'accesso per un collega della Radiologia. Consegna tu il PIN: non viene inviato per email.</p>
      <form class="form" id="user-form" novalidate>
        <label class="field"><span>Nome e cognome</span>
          <input id="new-user-name" name="name" type="text" autocomplete="name" maxlength="80" placeholder="Es. Anna Verdi" required></label>
        <label class="field"><span>Email</span>
          <input id="new-user-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="120" placeholder="anna.verdi@synlab.it" required></label>
        <label class="field"><span>Ruolo</span>
          <select id="new-user-role" name="role">
            <option value="dipendente">Dipendente</option>
            <option value="professionista">Professionista</option>
            <option value="coordinatore">Coordinatore</option>
          </select></label>
        <div class="appearance-row">
          <span id="new-user-avatar"></span>
          <div class="appearance-actions">
            <input type="file" data-photo-file accept="image/jpeg,image/png,image/webp" hidden>
            <button class="btn btn--ghost btn--sm" data-photo type="button">Carica foto</button>
            <button class="btn btn--ghost btn--sm" data-photo-clear type="button" hidden>Rimuovi</button>
            <p class="field-hint">Facoltativa: viene ritagliata in un cerchio. JPG, PNG o WebP.</p>
          </div>
        </div>
        <fieldset class="color-picker">
          <legend>Colore personale</legend>
          <div class="color-grid">${colorPickerMarkup(draft.color)}</div>
        </fieldset>
        <div class="pin-field-row">
          <label class="field"><span>PIN iniziale</span>
            <input id="new-user-pin" name="pin" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="8" value="${randomPin()}" required></label>
          <button class="btn btn--ghost btn--sm" id="btn-new-user-pin" type="button">Genera</button>
        </div>
        <p class="field-hint">Da 4 a 8 cifre. La persona potrà cambiarlo dal proprio menu.</p>
        <p class="form-error" id="new-user-error" hidden></p>
        <div class="modal-actions">
          <button class="btn btn--ghost btn--sm" type="button" data-close-modal>Annulla</button>
          <button class="btn btn--primary btn--sm" type="submit">Crea accesso</button>
        </div>
      </form>`, (root) => {
      const preview = $("#new-user-avatar", root);
      const nameInput = $("#new-user-name", root);
      const clear = $("[data-photo-clear]", root);
      const refresh = () => {
        const checked = root.querySelector('input[name="color"]:checked');
        draft.color = checked ? checked.value : draft.color;
        preview.innerHTML = appearancePreview({ name: nameInput.value.trim() || "Nuova persona",
          color: draft.color, avatar: null }, draft);
        clear.hidden = !draft.avatar;
      };
      refresh();
      nameInput.addEventListener("input", refresh);
      $$('input[name="color"]', root).forEach((input) => input.addEventListener("change", refresh));
      wirePhotoPicker(root, draft, refresh);
      $("#btn-new-user-pin", root).addEventListener("click", () => {
        $("#new-user-pin", root).value = randomPin();
      });
      $("#user-form", root).addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = $("#new-user-error", root);
        const submit = event.target.querySelector('button[type="submit"]');
        error.hidden = true;
        const name = $("#new-user-name", root).value.trim();
        const email = $("#new-user-email", root).value.trim().toLowerCase();
        const role = $("#new-user-role", root).value;
        const pin = $("#new-user-pin", root).value.trim();
        if (name.length < 2) {
          error.textContent = "Inserisci nome e cognome.";
          error.hidden = false;
          return;
        }
        if (!/^\d{4,8}$/.test(pin)) {
          error.textContent = "Il PIN deve avere da 4 a 8 cifre.";
          error.hidden = false;
          return;
        }
        submit.disabled = true;
        submit.textContent = "Creazione…";
        try {
          const data = await api("/api/users", { method: "POST",
            body: { name, email, role, pin, color: draft.color, avatar: draft.avatar || "" } });
          state.team = [...state.team, data.user];
          if (state.config) state.config.demo_accounts = [];
          if (state.stats) state.stats.team += 1;
          renderTeam();
          renderStats();
          await loadCalendar();
          toast("Accesso creato per " + data.user.name + ".", "success");
          showCredentials(data.user, pin);
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
          submit.textContent = "Crea accesso";
        }
      });
    });
  }

  function showCredentials(user, pin) {
    closeModal();
    const email = user.email;
    openModal(`
      <h3>Accesso creato</h3>
      <p class="modal-sub">Consegna queste credenziali a ${esc(user.name)}. Il PIN non sarà più visibile dopo aver chiuso questa finestra.</p>
      <div class="credential-box">
        <span>Email</span><strong>${esc(email)}</strong>
        <span>PIN</span><strong>${esc(pin)}</strong>
      </div>
      <p class="field-hint">Al primo accesso partirà il tutorial guidato. Suggerisci di cambiare il PIN dal menu in alto a destra.</p>
      <div class="modal-actions">
        <button class="btn btn--ghost btn--sm" id="btn-copy-credentials" type="button">Copia credenziali</button>
        <button class="btn btn--primary btn--sm" type="button" data-close-modal>Fatto</button>
      </div>`, (root) => {
      $("#btn-copy-credentials", root).addEventListener("click", async () => {
        const base = state.config?.base_url || window.location.origin;
        const text = `Accesso ${state.config?.org_name || "Synlab Manifattura Firenze"}\nEmail: ${email}\nPIN: ${pin}\nIndirizzo: ${base}`;
        try {
          await navigator.clipboard.writeText(text);
          toast("Credenziali copiate.", "success");
        } catch (_) {
          toast("Copia non disponibile: seleziona email e PIN.", "warn");
        }
      });
    });
  }

  function openAppearance(user) {
    const target = user || state.me;
    if (!target) return;
    if (state.me && target.id !== state.me.id && state.me.role !== "coordinatore") return;
    $("#user-menu").hidden = true;
    const canDelete = !!(state.me && state.me.role === "coordinatore" && target.id !== state.me.id);
    const draft = { avatar: undefined, color: target.color };
    openModal(`
      <h3>Colore e foto</h3>
      <p class="modal-sub">${esc(target.name)} · ogni persona ha un colore diverso, così il calendario resta leggibile a colpo d'occhio.</p>
      <div class="appearance-row">
        <span id="appearance-avatar"></span>
        <div class="appearance-actions">
          <input type="file" data-photo-file accept="image/jpeg,image/png,image/webp" hidden>
          <button class="btn btn--ghost btn--sm" data-photo type="button">Carica foto</button>
          <button class="btn btn--ghost btn--sm" data-photo-clear type="button" ${target.avatar ? "" : "hidden"}>Rimuovi foto</button>
          <p class="field-hint">La foto viene ritagliata in un cerchio. JPG, PNG o WebP.</p>
        </div>
      </div>
      <fieldset class="color-picker">
        <legend>Colore personale</legend>
        <div class="color-grid">${colorPickerMarkup(target.color, target.id)}</div>
      </fieldset>
      <p class="field-hint">Se scegli un colore già usato, due persone nel calendario avranno lo stesso segno.</p>
      ${canDelete ? `<div class="danger-zone">
        <p class="field-hint">Eliminando l'accesso di ${esc(target.name)} vengono cancellate anche tutte le sue richieste.</p>
        <button class="btn btn--danger btn--sm" id="btn-delete-user" type="button">Elimina accesso</button>
      </div>` : ""}
      <p class="form-error" id="appearance-error" hidden></p>
      <div class="modal-actions">
        <button class="btn btn--ghost btn--sm" type="button" data-close-modal>Annulla</button>
        <button class="btn btn--primary btn--sm" id="btn-save-appearance" type="button">Salva</button>
      </div>`, (root) => {
      const preview = $("#appearance-avatar", root);
      const clear = $("[data-photo-clear]", root);
      const refresh = () => {
        preview.innerHTML = appearancePreview(target, draft);
        const current = draft.avatar === undefined ? target.avatar : draft.avatar;
        clear.hidden = !current;
      };
      refresh();
      $$('input[name="color"]', root).forEach((input) => input.addEventListener("change", () => {
        draft.color = input.value;
        refresh();
      }));
      wirePhotoPicker(root, draft, refresh);
      const deleteButton = $("#btn-delete-user", root);
      if (deleteButton) deleteButton.addEventListener("click", () => confirmDeleteUser(target));
      $("#btn-save-appearance", root).addEventListener("click", async (event) => {
        const button = event.currentTarget;
        const error = $("#appearance-error", root);
        error.hidden = true;
        button.disabled = true;
        button.textContent = "Salvo…";
        try {
          const body = { color: draft.color };
          if (draft.avatar !== undefined) body.avatar = draft.avatar;
          const data = await api(`/api/users/${encodeURIComponent(target.id)}/appearance`,
            { method: "POST", body });
          applyUser(data.user);
          closeModal();
          toast("Colore e foto aggiornati.", "success");
          await loadCalendar();
          renderRequests();
          renderUpcoming();
          if (state.me && state.me.role === "coordinatore") {
            renderTeam();
            renderCoord();
          }
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          button.disabled = false;
          button.textContent = "Salva";
        }
      });
    });
  }

  function applyUser(user) {
    if (!user) return;
    if (state.me && state.me.id === user.id) {
      state.me = user;
      paintAvatar($("#user-avatar"), user, user.name);
      $("#user-name").textContent = user.name;
      $("#user-role").textContent = user.role;
      $("#btn-user").setAttribute("aria-label", `Menu utente di ${user.name}, ${cap(user.role)}`);
    }
    const patch = (item) => item && item.id === user.id ? user : item;
    state.people = (state.people || []).map(patch);
    state.team = (state.team || []).map(patch);
    const patchEvent = (ev) => ev && ev.user_id === user.id
      ? { ...ev, user_name: user.name, user_color: user.color, user_avatar: user.avatar }
      : ev;
    state.events = (state.events || []).map(patchEvent);
    state.pending = (state.pending || []).map(patchEvent);
    state.history = (state.history || []).map(patchEvent);
    state.requests = (state.requests || []).map(patchEvent);
    renderCalendar();
    renderUpcoming();
    renderRequests();
  }

  function renderCoord() {
    const box = $("#coord-pending");
    if (!state.pending.length) {
      box.innerHTML = `<div class="empty-state"><h3>Tutto in ordine</h3>
        <p>Nessuna richiesta in attesa di decisione.</p></div>`;
    } else {
      box.innerHTML = state.pending.map((req) => `
        <article class="req-card">
          <div class="req-top">
            <div>
              <div class="req-type">${eventAvatar(req)}${esc(req.user_name)}</div>
              <div class="req-period">${esc(typeLabel(req))} · ${esc(fmtDays(req.dates))} · ${req.days} ${req.days === 1 ? "giorno" : "giorni"}</div>
            </div>
            ${statusPill("pending")}
          </div>
          ${req.note ? `<div class="req-note">${esc(req.note)}</div>` : ""}
          <div class="decision-form" data-request="${esc(req.id)}">
            <textarea class="decision-note" maxlength="500" placeholder="Nota per ${esc(req.user_name.split(" ")[0])} (facoltativa)"></textarea>
            <div class="decision-actions">
              <button class="btn btn--primary btn--sm" type="button" data-decision="approve" data-id="${esc(req.id)}">Approva</button>
              <button class="btn btn--danger btn--sm" type="button" data-decision="reject" data-id="${esc(req.id)}">Rifiuta</button>
            </div>
          </div>
        </article>`).join("");
    }

    const hist = $("#coord-history");
    if (!state.history.length) {
      hist.innerHTML = '<li class="mini-empty">Nessuna decisione recente.</li>';
    } else {
      hist.innerHTML = state.history.slice(0, 8).map((req) => `
        <li>
          ${eventAvatar(req)}
          <span class="mini-main">
            <span class="mini-name">${esc(req.user_name)}</span>
            <span class="mini-when">${esc(fmtDaysShort(req.dates))} · ${req.status === "approved" ? "approvata" : "rifiutata"}</span>
          </span>
          <button class="btn btn--ghost btn--xs" type="button" data-reevaluate="${esc(req.id)}" title="Rivaluta questa decisione">Rivaluta</button>
        </li>`).join("");
    }
  }

  async function decide(id, decision, note) {
    try {
      await api(`/api/requests/${encodeURIComponent(id)}/decision`, {
        method: "POST",
        body: { decision, note },
      });
      toast(decision === "approve" ? "Richiesta approvata. Email inviata." : "Richiesta rifiutata. Email inviata.", "success");
      await Promise.all([loadCoord(), loadCalendar(), loadRequests(), loadNotifications()]);
    } catch (error) {
      toast(error.message, "error");
      loadCoord();
    }
  }

  function openReevaluate(id) {
    const req = (state.history || []).find((item) => item.id === id)
      || (state.pending || []).find((item) => item.id === id);
    if (!req) return;
    const firstName = String(req.user_name || "").split(" ")[0];
    openModal(`
      <h3>Rivaluta la richiesta</h3>
      <p class="modal-sub">${esc(req.user_name)} · ${esc(typeLabel(req))} · ${esc(fmtDays(req.dates))}</p>
      ${statusPill(req.status)}
      <label class="field"><span>Nota per ${esc(firstName)} <em>(facoltativa)</em></span>
        <textarea id="reeval-note" maxlength="500" rows="3" placeholder="Es. cambio turno concordato"></textarea></label>
      <p class="field-hint">Cambiando l'esito ${esc(firstName)} riceverà una nuova email e una notifica. Con “Metti in attesa” la richiesta torna in coda e non viene inviato alcun esito.</p>
      <div class="modal-actions">
        <button class="btn btn--ghost btn--sm" id="btn-reeval-reopen" type="button">Metti in attesa</button>
        <button class="btn btn--danger btn--sm" type="button" data-reeval="reject">Rifiuta</button>
        <button class="btn btn--primary btn--sm" type="button" data-reeval="approve">Approva</button>
      </div>`, (root) => {
      $("#btn-reeval-reopen", root).addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "Riapro…";
        try {
          await api(`/api/requests/${encodeURIComponent(id)}/reopen`, { method: "POST", body: {} });
          closeModal();
          toast("Richiesta rimessa in attesa di decisione.");
          await Promise.all([loadCoord(), loadCalendar(), loadRequests(), loadNotifications()]);
        } catch (error) {
          toast(error.message, "error");
          button.disabled = false;
          button.textContent = "Metti in attesa";
        }
      });
      $$("[data-reeval]", root).forEach((button) => {
        button.addEventListener("click", () => {
          const note = $("#reeval-note", root).value;
          closeModal();
          decide(id, button.dataset.reeval, note);
        });
      });
    });
  }

  function openProfile() {
    if (!state.me) return;
    $("#user-menu").hidden = true;
    openModal(`
      <h3>I miei dati</h3>
      <p class="modal-sub">Nome ed email con cui ti vedono i colleghi. L'email è anche il nome utente per accedere.</p>
      <form class="form" id="profile-form" novalidate>
        <label class="field"><span>Nome e cognome</span>
          <input id="profile-name" type="text" maxlength="80" autocomplete="name" value="${esc(state.me.name)}" required></label>
        <label class="field"><span>Email</span>
          <input id="profile-email" type="email" maxlength="120" autocomplete="email" value="${esc(state.me.email)}" required></label>
        <p class="field-hint">Il PIN non cambia. Dalla prossima volta accedi con la nuova email.</p>
        <p class="form-error" id="profile-error" hidden></p>
        <div class="modal-actions">
          <button class="btn btn--ghost btn--sm" type="button" data-close-modal>Annulla</button>
          <button class="btn btn--primary btn--sm" type="submit">Salva</button>
        </div>
      </form>`, (root) => {
      $("#profile-form", root).addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = $("#profile-error", root);
        const submit = event.target.querySelector('button[type="submit"]');
        const name = $("#profile-name", root).value.trim();
        const email = $("#profile-email", root).value.trim();
        error.hidden = true;
        if (name.length < 2) {
          error.textContent = "Inserisci nome e cognome.";
          error.hidden = false;
          return;
        }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          error.textContent = "L'email non è valida.";
          error.hidden = false;
          return;
        }
        submit.disabled = true;
        submit.textContent = "Salvo…";
        try {
          const data = await api("/api/profile", { method: "POST", body: { name, email } });
          applyUser(data.user);
          $("#user-menu-email").textContent = data.user.email;
          closeModal();
          toast("Dati aggiornati.", "success");
          await loadCalendar();
          if (state.me.role === "coordinatore") {
            renderTeam();
            loadCoord();
          }
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
          submit.disabled = false;
          submit.textContent = "Salva";
        }
      });
    });
  }

  function confirmDeleteUser(user) {
    if (!user || !state.me || user.id === state.me.id) return;
    openModal(`
      <h3>Eliminare ${esc(user.name)}?</h3>
      <p class="modal-sub">L'accesso e tutte le sue richieste verranno cancellati. L'operazione non si può annullare.</p>
      <p class="field-hint">Se vuoi solo cambiare colore o foto, chiudi questa finestra.</p>
      <div class="modal-actions">
        <button class="btn btn--ghost btn--sm" type="button" data-close-modal>Annulla</button>
        <button class="btn btn--danger btn--sm" id="btn-confirm-delete" type="button">Elimina definitivamente</button>
      </div>`, (root) => {
      $("#btn-confirm-delete", root).addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = "Elimino…";
        try {
          const data = await api(`/api/users/${encodeURIComponent(user.id)}/delete`,
            { method: "POST", body: {} });
          state.team = state.team.filter((item) => item.id !== user.id);
          closeModal();
          toast(`${user.name} eliminato${data.removed_requests ? ` con ${data.removed_requests} richieste` : ""}.`, "success");
          await Promise.all([loadCoord(), loadCalendar(), loadRequests(), loadNotifications()]);
        } catch (error) {
          toast(error.message, "error");
          button.disabled = false;
          button.textContent = "Elimina definitivamente";
        }
      });
    });
  }

  function renderStats() {
    const stats = state.stats;
    if (!stats) return;
    $("#stat-pending").textContent = stats.pending;
    $("#stat-days").textContent = stats.approved_days_month;
    $("#stat-away").textContent = stats.away_today;
    $("#stat-month").textContent = "nel mese di " + stats.month;
    $("#stat-team").textContent = "su " + stats.team + " " + (stats.team === 1 ? "persona" : "persone");
  }

  async function loadOutbox() {
    try {
      const data = await api("/api/outbox");
      const list = $("#outbox-list");
      $("#outbox-card").hidden = false;
      const configured = !!data.configured;
      state.emailConfigured = configured;
      $("#email-dot").classList.toggle("email-dot--off", !configured);
      $("#email-status-text").textContent = configured ? "Invio email configurato" : "Modalità simulata";
      $("#outbox-hint").textContent = configured
        ? "Registro delle ultime email inviate dall'app."
        : "Le email sono salvate qui perché non è configurato un servizio di invio.";
      $("#btn-test-email").hidden = !configured;
      const badge = $("#outbox-badge");
      if (badge) {
        badge.textContent = configured ? "live" : "demo";
        badge.classList.toggle("mini-badge--live", configured);
      }
      if (!data.messages.length) {
        list.innerHTML = '<li class="mini-empty">Nessuna email generata.</li>';
        return;
      }
      list.innerHTML = data.messages.slice(0, 8).map((mail) => `
        <li class="outbox-row">
          <button class="outbox-item" type="button" data-mail="${esc(mail.id)}"
              title="${esc(mail.provider || (configured ? "" : "demo"))}${mail.error ? " · " + esc(mail.error) : ""}${mail.reply_to ? " · rispondi a " + esc(mail.reply_to) : ""}">
            <span class="outbox-subject">${esc(mail.subject)}</span>
            <span class="outbox-to">a ${esc(mail.to)}${mail.attachments ? " · " + mail.attachments + " allegat" + (mail.attachments === 1 ? "o" : "i") : ""}</span>
          </button>
          ${mail.error ? `<div class="outbox-error"><span>${esc(mail.error)}</span><button class="btn btn--ghost btn--xs" type="button" data-resend="${esc(mail.id)}">Reinvia</button></div>` : ""}
        </li>`).join("");
    } catch (_) { /* sezione facoltativa */ }
  }

  /* ------------------------------ notifiche ------------------------------ */

  function renderNotifications() {
    const unread = state.notifications.filter((n) => n.unread).length;
    $("#bell-badge").hidden = unread === 0;
    $("#bell-badge").textContent = unread > 9 ? "9+" : String(unread);
    const list = $("#notif-list");
    if (!state.notifications.length) {
      list.innerHTML = '<div class="notif-empty">Nessuna notifica recente.</div>';
      return;
    }
    list.innerHTML = state.notifications.map((item) => `
      <button class="notif-item" type="button" data-notif-view="${item.kind === "pending" ? "coord" : "requests"}">
        <span class="notif-dot${item.kind === "rejected" ? " notif-dot--rejected" : item.kind === "pending" ? " notif-dot--pending" : ""}"></span>
        <span>
          <span class="notif-title">${esc(item.title)}</span>
          <span class="notif-body">${esc(item.body)}</span>
        </span>
      </button>`).join("");
  }

  async function loadNotifications() {
    try {
      const data = await api("/api/notifications");
      state.notifications = data.notifications;
      renderNotifications();
    } catch (_) { /* silenzioso */ }
  }

  async function openNotifications() {
    const panel = $("#notif-panel");
    const isOpen = !panel.hidden;
    panel.hidden = isOpen;
    $("#btn-bell").setAttribute("aria-expanded", isOpen ? "false" : "true");
    $("#user-menu").hidden = true;
    if (isOpen) return;
    $("#notif-status").textContent = state.notifications.length ? "recenti" : "";
    if (state.notifications.some((n) => n.unread)) {
      try {
        await api("/api/notifications/seen", { method: "POST", body: {} });
        state.notifications = state.notifications.map((n) => ({ ...n, unread: false }));
        renderNotifications();
      } catch (_) { /* ignora */ }
    }
  }

  /* ------------------------------ notifiche push ------------------------------ */

  function pushSupport() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
    if (!window.isSecureContext) return "insecure";
    return "ok";
  }

  function iosWithoutInstall() {
    const ua = navigator.userAgent || "";
    const ios = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!ios) return false;
    const standalone = navigator.standalone === true
      || (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    return !standalone;
  }

  function decodePushKey(base64) {
    const padding = "=".repeat((4 - (base64.length % 4)) % 4);
    const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  }

  async function pushSubscription() {
    if (pushSupport() !== "ok") return null;
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) return null;
      return await registration.pushManager.getSubscription();
    } catch (_) {
      return null;
    }
  }

  async function refreshPushLabel() {
    const label = $("#btn-push-label");
    const button = $("#btn-push");
    if (!label || !button) return;
    const subscription = await pushSubscription();
    label.textContent = subscription ? "Disattiva notifiche sul telefono" : "Attiva notifiche sul telefono";
    button.title = subscription
      ? "Le notifiche di conferma e rifiuto arrivano su questo dispositivo."
      : "Ricevi conferma o rifiuto della richiesta anche senza aprire l'app.";
  }

  function pushHelp() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);
    openModal(`
      <h3>Notifiche sul telefono</h3>
      <p class="modal-sub">${ios
        ? "Su iPhone le notifiche funzionano solo dopo aver aggiunto l'app alla schermata Home (iOS 16.4 o successivo) e averla aperta da lì."
        : "Questo browser non permette le notifiche push su questo indirizzo. Servono una connessione sicura (https) e un browser aggiornato."}</p>
      <p class="field-hint">In ogni caso ricevi un'email a ogni conferma o rifiuto.</p>
      <div class="modal-actions"><button class="btn btn--primary btn--sm" type="button" data-close-modal>Ho capito</button></div>`);
  }

  async function enablePush() {
    if (pushSupport() !== "ok" || typeof Notification === "undefined") {
      pushHelp();
      return;
    }
    if (iosWithoutInstall()) {
      pushHelp();
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      toast("Permesso negato: puoi riattivarlo dalle impostazioni del browser.", "warn");
      return;
    }
    const key = await api("/api/push/key");
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodePushKey(key.public_key),
      });
    }
    const json = subscription.toJSON();
    const data = await api("/api/push/subscribe", {
      method: "POST",
      body: { endpoint: json.endpoint, keys: json.keys,
        device: (navigator.userAgent || "").slice(0, 100) },
    });
    state.pushDevices = data.devices || 1;
    await refreshPushLabel();
    toast("Notifiche attive: ti avviso qui quando il coordinatore decide.", "success");
  }

  async function disablePush() {
    const subscription = await pushSubscription();
    if (!subscription) {
      await refreshPushLabel();
      return;
    }
    const endpoint = subscription.endpoint;
    try {
      const data = await api("/api/push/unsubscribe", { method: "POST", body: { endpoint } });
      state.pushDevices = data.devices || 0;
    } catch (error) {
      toast(error.message, "error");
    }
    await subscription.unsubscribe().catch(() => {});
    await refreshPushLabel();
    toast("Notifiche disattivate su questo dispositivo.");
  }

  async function togglePush(button) {
    if (!state.me) return;
    $("#user-menu").hidden = true;
    if (button) button.disabled = true;
    try {
      const subscription = await pushSubscription();
      if (subscription) await disablePush();
      else await enablePush();
    } catch (error) {
      toast(error.message || "Non riesco ad attivare le notifiche.", "error");
    } finally {
      if (button) button.disabled = false;
      await refreshPushLabel();
    }
  }

  /* ------------------------------ utente ------------------------------ */

  function handleExpired() {
    if (state.tour.active) endTour(false, false);
    state.me = null;
    toast("Sessione scaduta, accedi di nuovo.", "warn");
    showLogin();
  }

  async function login(event) {
    event.preventDefault();
    const email = $("#login-email").value.trim();
    const pin = $("#login-pin").value.trim();
    const errorBox = $("#login-error");
    const button = $("#login-submit");
    errorBox.hidden = true;
    if (!email || !pin) {
      errorBox.textContent = "Inserisci email e PIN.";
      errorBox.hidden = false;
      return;
    }
    button.disabled = true;
    button.textContent = "Accesso…";
    try {
      const data = await api("/api/login", { method: "POST", body: { email, pin } });
      state.config = data.config;
      state.notifications = data.notifications || [];
      state.allowedTypes = data.allowed_types || [];
      state.pushDevices = data.push_devices || 0;
      $("#login-pin").value = "";
      showApp(data.user);
      await Promise.all([loadCalendar(), loadRequests(), loadCoord()]);
      renderNotifications();
      maybeStartTour(data.user);
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "Accedi";
    }
  }

  async function logout() {
    if (state.tour.active) endTour(false, false);
    try { await api("/api/logout", { method: "POST", body: {} }); } catch (_) { /* ignora */ }
    try { state.config = await api("/api/config"); } catch (_) { /* config non disponibile */ }
    state.me = null;
    state.selected.clear();
    state.rangeAnchor = null;
    state.form = { type: "ferie", availability: "non_disponibile", slot: "giornata",
      timeFrom: "09:00", timeTo: "13:00", note: "" };
    $("#request-note").value = "";
    $("#note-count").textContent = "0";
    $("#user-menu").hidden = true;
    showLogin();
  }

  function openPinModal() {
    $("#user-menu").hidden = true;
    openModal(`
      <h3>Cambia PIN</h3>
      <p class="modal-sub">Il PIN protegge il tuo accesso. Usa da 4 a 8 cifre.</p>
      <form class="form" id="pin-form">
        <label class="field"><span>PIN attuale</span>
          <input type="password" id="pin-current" inputmode="numeric" maxlength="8" autocomplete="current-password" required></label>
        <label class="field"><span>Nuovo PIN</span>
          <input type="password" id="pin-new" inputmode="numeric" maxlength="8" autocomplete="new-password" required></label>
        <p class="form-error" id="pin-error" hidden></p>
        <div class="modal-actions">
          <button class="btn btn--ghost btn--sm" type="button" data-close-modal>Annulla</button>
          <button class="btn btn--primary btn--sm" type="submit">Aggiorna PIN</button>
        </div>
      </form>`, (root) => {
      $("#pin-form", root).addEventListener("submit", async (event) => {
        event.preventDefault();
        const error = $("#pin-error", root);
        error.hidden = true;
        try {
          await api("/api/pin", {
            method: "POST",
            body: { current: $("#pin-current", root).value, new: $("#pin-new", root).value },
          });
          closeModal();
          toast("PIN aggiornato.", "success");
        } catch (err) {
          error.textContent = err.message;
          error.hidden = false;
        }
      });
    });
  }

  /* ------------------------------ eventi UI ------------------------------ */

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme();
    $$("[data-theme-choice]").forEach((button) => {
      button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
    });
    const scheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (scheme) {
      const onSchemeChange = () => { if (storedTheme() === "system") applyTheme(); };
      if (scheme.addEventListener) scheme.addEventListener("change", onSchemeChange);
      else if (scheme.addListener) scheme.addListener(onSchemeChange);
    }
    $("#login-form").addEventListener("submit", login);
    $("#btn-help").addEventListener("click", () => startTour());
    $("#btn-tour").addEventListener("click", () => {
      $("#user-menu").hidden = true;
      startTour();
    });
    $("#tour-next").addEventListener("click", nextTourStep);
    $("#tour-prev").addEventListener("click", previousTourStep);
    $("#tour-skip").addEventListener("click", () => endTour(true, true, false));
    $("#tour").addEventListener("wheel", (event) => {
      if (!event.target.closest(".tour-card")) event.preventDefault();
    }, { passive: false });
    $("#btn-logout").addEventListener("click", logout);
    $("#btn-change-pin").addEventListener("click", openPinModal);
    $("#btn-profile").addEventListener("click", openProfile);
    $("#btn-appearance").addEventListener("click", () => openAppearance(state.me));
    $("#btn-push").addEventListener("click", (event) => togglePush(event.currentTarget));
    $("#btn-user").addEventListener("click", () => {
      const menu = $("#user-menu");
      const open = menu.hidden;
      menu.hidden = !open;
      $("#btn-user").setAttribute("aria-expanded", open ? "true" : "false");
      $("#notif-panel").hidden = true;
    });
    $("#btn-bell").addEventListener("click", openNotifications);

    $$(".tab").forEach((tab) => tab.addEventListener("click", () => switchView(tab.dataset.view)));
    $("#btn-open-coord").addEventListener("click", () => switchView("coord"));

    $("#btn-prev").addEventListener("click", () => {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() - 1, 1);
      renderCalendar();
      renderSelectionBar();
      loadCalendar();
    });
    $("#btn-next").addEventListener("click", () => {
      state.month = new Date(state.month.getFullYear(), state.month.getMonth() + 1, 1);
      renderCalendar();
      renderSelectionBar();
      loadCalendar();
    });
    $("#btn-today").addEventListener("click", () => {
      state.month = startOfMonth(today());
      renderCalendar();
      renderSelectionBar();
      loadCalendar();
    });

    $("#cal-grid").addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (chip) {
        event.stopPropagation();
        if (chip.classList.contains("chip--more")) {
          const day = chip.closest(".cal-day");
          if (day) openDayDetail(day.dataset.day);
        } else {
          openDayDetail(chip.dataset.day);
        }
        return;
      }
      const cell = event.target.closest(".cal-day");
      if (!cell) return;
      const key = cell.dataset.day;
      if (cell.classList.contains("cal-day--outside")) {
        const d = parseDay(key);
        state.month = startOfMonth(d);
      }
      toggleDay(key, event.shiftKey);
    });

    $("#cal-grid").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const cell = event.target.closest(".cal-day");
      if (!cell) return;
      event.preventDefault();
      toggleDay(cell.dataset.day);
    });

    $("#selected-list").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-start]");
      if (!button) return;
      const start = parseDay(button.dataset.removeStart);
      const end = parseDay(button.dataset.removeEnd);
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) state.selected.delete(iso(d));
      state.rangeAnchor = null;
      renderCalendar();
      renderSide();
      renderSelectionBar();
    });

    $("#btn-clear-selection").addEventListener("click", () => {
      state.selected.clear();
      state.rangeAnchor = null;
      renderCalendar();
      renderSide();
      renderSelectionBar();
    });

    $("#btn-goto-form").addEventListener("click", () => {
      $("#request-card").scrollIntoView({ behavior: "smooth", block: "start" });
      if (state.selected.size) $("#request-note").focus({ preventScroll: true });
    });

    $("#type-selector").addEventListener("change", (event) => {
      if (event.target.name !== "type") return;
      state.form.type = event.target.value;
      renderSide();
    });
    $("#availability-selector").addEventListener("change", (event) => {
      if (event.target.name !== "availability") return;
      state.form.availability = event.target.value;
      renderSide();
    });
    $("#request-slot").addEventListener("change", (event) => {
      state.form.slot = event.target.value;
      renderSide();
    });
    $("#request-time-from").addEventListener("input", (event) => {
      state.form.timeFrom = event.target.value;
      renderSide();
    });
    $("#request-time-to").addEventListener("input", (event) => {
      state.form.timeTo = event.target.value;
      renderSide();
    });
    $("#request-note").addEventListener("input", (event) => {
      state.form.note = event.target.value;
      $("#note-count").textContent = event.target.value.length;
    });
    $("#request-form").addEventListener("submit", submitRequest);

    $("#requests-list").addEventListener("click", (event) => {
      const cancel = event.target.closest("[data-cancel]");
      if (cancel) {
        cancelRequest(cancel.dataset.cancel);
        return;
      }
      const withdraw = event.target.closest("[data-withdraw]");
      if (withdraw) withdrawRequest(withdraw.dataset.withdraw);
    });

    $("#coord-history").addEventListener("click", (event) => {
      const button = event.target.closest("[data-reevaluate]");
      if (button) openReevaluate(button.dataset.reevaluate);
    });

    $("#btn-add-user").addEventListener("click", openAddUser);
    $("#team-list").addEventListener("click", (event) => {
      const row = event.target.closest("[data-edit-user]");
      if (!row) return;
      const member = state.team.find((user) => user.id === row.dataset.editUser);
      if (member) openAppearance(member);
    });

    $("#coord-pending").addEventListener("click", (event) => {
      const button = event.target.closest("[data-decision]");
      if (!button) return;
      const form = button.closest(".decision-form");
      const note = form ? $(".decision-note", form).value : "";
      button.disabled = true;
      decide(button.dataset.id, button.dataset.decision, note);
    });

    $("#notif-list").addEventListener("click", (event) => {
      const item = event.target.closest("[data-notif-view]");
      if (!item) return;
      $("#notif-panel").hidden = true;
      $("#btn-bell").setAttribute("aria-expanded", "false");
      switchView(item.dataset.notifView);
    });

    $("#outbox-list").addEventListener("click", async (event) => {
      const resend = event.target.closest("[data-resend]");
      if (resend) {
        event.stopPropagation();
        resend.disabled = true;
        resend.textContent = "Invio…";
        try {
          await api(`/api/outbox/${encodeURIComponent(resend.dataset.resend)}/resend`, { method: "POST", body: {} });
          toast("Email reinviata.", "success");
          loadOutbox();
        } catch (error) {
          toast(error.message, "error");
          resend.disabled = false;
          resend.textContent = "Reinvia";
        }
        return;
      }
      const item = event.target.closest("[data-mail]");
      if (!item) return;
      const id = encodeURIComponent(item.dataset.mail);
      const title = state.emailConfigured ? "Email inviata" : "Email simulata";
      const sub = state.emailConfigured ? "Copia del messaggio inviato." : "Messaggio generato dall'app in modalità simulata.";
      openModal(`<h3>${title}</h3><p class="modal-sub">${sub}</p>
        <iframe src="/api/outbox/${id}" title="Contenuto email" style="width:100%;height:min(58vh,520px);border:1px solid #e6e0d2;border-radius:12px;background:#fff;"></iframe>
        <div class="modal-actions"><button class="btn btn--ghost btn--sm" type="button" data-close-modal>Chiudi</button></div>`);
    });

    $$(".mode-btn").forEach((button) => {
      button.addEventListener("click", () => {
        state.mode = button.dataset.mode;
        state.rangeAnchor = null;
        $$(".mode-btn").forEach((other) => other.classList.toggle("is-active", other === button));
        const sub = $("#calendar-sub");
        if (sub) sub.textContent = state.mode === "range"
          ? "Tocca il primo giorno e poi l'ultimo del periodo."
          : "Seleziona i giorni, poi invia la richiesta al coordinatore.";
        renderCalendar();
      });
    });

    $$("[data-range]").forEach((button) => {
      button.addEventListener("click", () => selectWeek(button.dataset.range === "next" ? 1 : 0));
    });

    const personSelect = $("#person-filter");
    if (personSelect) {
      personSelect.addEventListener("change", () => {
        state.personFilter = personSelect.value;
        renderCalendar();
      });
    }

    const testButton = $("#btn-test-email");
    if (testButton) {
      testButton.addEventListener("click", async () => {
        testButton.disabled = true;
        const label = testButton.textContent;
        testButton.textContent = "Invio in corso…";
        try {
          const result = await api("/api/test-email", { method: "POST", body: {} });
          toast(`Email di prova inviata (${result.provider || "provider"}).`, "success");
          loadOutbox();
        } catch (error) {
          toast(error.message, "error");
        } finally {
          testButton.disabled = false;
          testButton.textContent = label;
        }
      });
    }

    $("#btn-copy-ics").addEventListener("click", async () => {
      const path = state.config?.ics_url || "/calendar.ics";
      const url = (state.config?.base_url || window.location.origin) + path;
      try {
        await navigator.clipboard.writeText(url);
        toast("Link del calendario copiato. Puoi incollarlo in Google/Apple Calendar.", "success");
      } catch (_) {
        openModal(`<h3>Link del calendario</h3><p class="modal-sub">Copia il link e aggiungilo come calendario iscritto.</p>
          <div class="req-note" style="user-select:all;word-break:break-all;">${esc(url)}</div>
          <div class="modal-actions"><button class="btn btn--ghost btn--sm" type="button" data-close-modal>Chiudi</button></div>`);
      }
    });

    document.addEventListener("click", (event) => {
      if (!event.target.closest("#user-menu") && !event.target.closest("#btn-user")) {
        $("#user-menu").hidden = true;
        $("#btn-user").setAttribute("aria-expanded", "false");
      }
      if (!event.target.closest("#notif-panel") && !event.target.closest("#btn-bell")) {
        $("#notif-panel").hidden = true;
        $("#btn-bell").setAttribute("aria-expanded", "false");
      }
    });

    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      state.installPrompt = event;
      $("#btn-install").hidden = false;
    });
    $("#btn-install").addEventListener("click", async () => {
      if (!state.installPrompt) return;
      state.installPrompt.prompt();
      await state.installPrompt.userChoice;
      state.installPrompt = null;
      $("#btn-install").hidden = true;
    });

    if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
      navigator.serviceWorker.register("/sw.js")
        .then(() => refreshPushLabel())
        .catch(() => { /* offline opzionale */ });
    }

    boot();
  });
})();
