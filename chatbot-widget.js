/**
 * Widget Chatbot FIPAV — incolla questo script in WordPress
 * (blocco "HTML personalizzato" oppure nel footer del tema).
 *
 * CONFIGURAZIONE: modifica solo le righe qui sotto.
 */
(function () {
  "use strict";

  // ==========================================================
  // CONFIGURAZIONE — personalizza qui
  // ==========================================================
  const CONFIG = {
    API_BASE_URL: "https://IL-TUO-DOMINIO-BACKEND.example.com", // <-- URL del backend una volta pubblicato
    LOGO_URL: "https://letiziaamoroso.github.io/chatbot-fipav/logo.png",
    BOT_NAME: "Assistente FIPAV",
    WELCOME_TEXT: "Inserisci il codice di accesso fornito.",
    QUALIFICHE: [
      "Atleta",
      "Allenatore/Allenatrice",
      "Dirigente",
      "Arbitro",
      "Genitore",
      "Altro",
    ],
  };
  // ==========================================================

  const STORAGE_KEY = "fipav_chat_session";

  // ---------- Stile ----------
  const style = document.createElement("style");
  style.textContent = `
    .fpv-launcher {
      position: fixed; bottom: 24px; right: 24px; z-index: 999999;
      width: 60px; height: 60px; border-radius: 50%;
      background: #16305C; border: none; cursor: pointer;
      box-shadow: 0 6px 20px rgba(22,48,92,0.35);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s ease;
    }
    .fpv-launcher:hover { transform: scale(1.06); }
    .fpv-launcher svg { width: 30px; height: 30px; }

    .fpv-panel {
      position: fixed; bottom: 96px; right: 24px; z-index: 999999;
      width: 360px; max-width: calc(100vw - 32px);
      height: 520px; max-height: calc(100vh - 140px);
      background: #FBF9F5; border-radius: 16px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.22);
      display: none; flex-direction: column; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      border: 1px solid rgba(22,48,92,0.08);
    }
    .fpv-panel.open { display: flex; }

    .fpv-header {
      background: #16305C; color: #fff; padding: 16px 18px;
      display: flex; align-items: center; gap: 10px;
      background-image: repeating-linear-gradient(135deg, rgba(242,169,59,0.12) 0 2px, transparent 2px 14px);
    }
    .fpv-header svg { width: 22px; height: 22px; flex-shrink: 0; }
    .fpv-header img.fpv-logo { height: 40px; width: auto; flex-shrink: 0; display: block; }
    .fpv-header-title { font-weight: 600; font-size: 15px; }
    .fpv-header-sub { font-size: 12px; opacity: 0.75; }
    .fpv-close {
      margin-left: auto; background: none; border: none; color: #fff;
      cursor: pointer; font-size: 20px; line-height: 1; opacity: 0.8;
    }
    .fpv-close:hover { opacity: 1; }

    .fpv-body { flex: 1; overflow-y: auto; padding: 16px; }

    .fpv-field-label { font-size: 13px; color: #16305C; font-weight: 600; margin: 0 0 6px; }
    .fpv-input, .fpv-select {
      width: 100%; box-sizing: border-box; padding: 10px 12px;
      border: 1.5px solid #DDD5C7; border-radius: 8px; font-size: 14px;
      margin-bottom: 12px; background: #fff; color: #222;
    }
    .fpv-input:focus, .fpv-select:focus { outline: none; border-color: #F2A93B; }
    .fpv-btn {
      width: 100%; padding: 11px; border: none; border-radius: 8px;
      background: #F2A93B; color: #16305C; font-weight: 700; font-size: 14px;
      cursor: pointer; transition: filter 0.15s ease;
    }
    .fpv-btn:hover { filter: brightness(1.05); }
    .fpv-btn:disabled { opacity: 0.55; cursor: not-allowed; }

    .fpv-error { color: #B3261E; font-size: 13px; margin: -6px 0 12px; }
    .fpv-hint { color: #7A7264; font-size: 12px; margin-top: 4px; }

    .fpv-msg { margin-bottom: 12px; display: flex; }
    .fpv-msg.user { justify-content: flex-end; }
    .fpv-bubble {
      max-width: 82%; padding: 9px 13px; border-radius: 14px; font-size: 13.5px; line-height: 1.45;
      white-space: pre-wrap;
    }
    .fpv-msg.user .fpv-bubble { background: #16305C; color: #fff; border-bottom-right-radius: 4px; }
    .fpv-msg.bot .fpv-bubble { background: #EFE9DD; color: #2A2A2A; border-bottom-left-radius: 4px; }
    .fpv-msg.system .fpv-bubble { background: transparent; color: #7A7264; font-size: 12px; text-align: center; margin: 0 auto; }

    .fpv-footer { border-top: 1px solid #EEE7D9; padding: 10px 12px; display: flex; gap: 8px; }
    .fpv-footer input {
      flex: 1; border: 1.5px solid #DDD5C7; border-radius: 20px; padding: 9px 14px; font-size: 13.5px;
    }
    .fpv-footer input:focus { outline: none; border-color: #F2A93B; }
    .fpv-send {
      width: 38px; height: 38px; border-radius: 50%; border: none; background: #16305C;
      color: #fff; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
    }
    .fpv-send:disabled { opacity: 0.5; cursor: not-allowed; }
    .fpv-counter { font-size: 11px; color: #7A7264; text-align: center; padding: 4px 0 0; }
  `;
  document.head.appendChild(style);

  const VOLLEYBALL_ICON = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="12" r="10" stroke="#F2A93B" stroke-width="1.6"/>
    <path d="M12 2C9 6 9 18 12 22" stroke="#F2A93B" stroke-width="1.6"/>
    <path d="M2 9.5C7 11.5 17 11.5 22 9.5" stroke="#F2A93B" stroke-width="1.6"/>
    <path d="M3.5 17C8 14 16 14 20.5 17" stroke="#F2A93B" stroke-width="1.6"/>
  </svg>`;

  // ---------- DOM ----------
  const launcher = document.createElement("button");
  launcher.className = "fpv-launcher";
  launcher.innerHTML = VOLLEYBALL_ICON;
  launcher.setAttribute("aria-label", "Apri chat assistente");

  const panel = document.createElement("div");
  panel.className = "fpv-panel";
  panel.innerHTML = `
    <div class="fpv-header">
      <img class="fpv-logo" src="${CONFIG.LOGO_URL}" alt="${CONFIG.BOT_NAME}" onerror="this.style.display='none'" />
      <div>
        <div class="fpv-header-title">${CONFIG.BOT_NAME}</div>
        <div class="fpv-header-sub">Comitato Regionale</div>
      </div>
      <button class="fpv-close" aria-label="Chiudi">&times;</button>
    </div>
    <div class="fpv-body" id="fpv-body"></div>
    <div class="fpv-footer" id="fpv-footer" style="display:none;">
      <input type="text" id="fpv-input" placeholder="Scrivi una domanda..." />
      <button class="fpv-send" id="fpv-send" aria-label="Invia">&#10148;</button>
    </div>
  `;

  document.body.appendChild(launcher);
  document.body.appendChild(panel);

  const body = panel.querySelector("#fpv-body");
  const footer = panel.querySelector("#fpv-footer");
  const input = panel.querySelector("#fpv-input");
  const sendBtn = panel.querySelector("#fpv-send");

  launcher.addEventListener("click", () => {
    panel.classList.add("open");
    if (!body.dataset.init) initFlow();
  });
  panel.querySelector(".fpv-close").addEventListener("click", () => panel.classList.remove("open"));

  // ---------- Stato sessione ----------
  function getSession() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
    } catch {
      return null;
    }
  }
  function saveSession(s) {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  }
  function clearSession() {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  function addMsg(text, who) {
    const row = document.createElement("div");
    row.className = `fpv-msg ${who}`;
    const bubble = document.createElement("div");
    bubble.className = "fpv-bubble";
    bubble.textContent = text;
    row.appendChild(bubble);
    body.appendChild(row);
    body.scrollTop = body.scrollHeight;
  }

  async function api(path, opts = {}) {
    const session = getSession();
    const headers = { "Content-Type": "application/json" };
    if (session && session.token) headers["x-session-token"] = session.token;
    const resp = await fetch(CONFIG.API_BASE_URL + path, {
      ...opts,
      headers: { ...headers, ...(opts.headers || {}) },
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(data.error || "Errore di comunicazione con il server.");
    return data;
  }

  // ---------- Step 1: codice di accesso ----------
  function showPasswordStep() {
    body.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <p class="fpv-field-label">Accesso</p>
      <p class="fpv-hint" style="margin-bottom:12px;">${CONFIG.WELCOME_TEXT}</p>
      <input type="password" class="fpv-input" id="fpv-password" placeholder="Codice di accesso" />
      <div class="fpv-error" id="fpv-pw-error" style="display:none;"></div>
      <button class="fpv-btn" id="fpv-pw-submit">Entra</button>
    `;
    body.appendChild(wrap);
    const pwInput = wrap.querySelector("#fpv-password");
    const errEl = wrap.querySelector("#fpv-pw-error");
    const submit = async () => {
      const password = pwInput.value.trim();
      errEl.style.display = "none";
      if (!password) return;
      try {
        const data = await api("/api/login", { method: "POST", body: JSON.stringify({ password }) });
        saveSession({ token: data.token });
        showRegisterStep(data.token);
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = "block";
      }
    };
    wrap.querySelector("#fpv-pw-submit").addEventListener("click", submit);
    pwInput.addEventListener("keydown", (e) => e.key === "Enter" && submit());
  }

  // ---------- Step 2: nome/cognome/qualifica (sempre richiesto: il codice è condiviso) ----------
  function showRegisterStep(token) {
    body.innerHTML = "";
    const opts = CONFIG.QUALIFICHE.map((q) => `<option value="${q}">${q}</option>`).join("");
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <p class="fpv-field-label">I tuoi dati</p>
      <p class="fpv-hint" style="margin-bottom:12px;">Questo codice è condiviso dalla società: indica chi sei ogni volta che accedi.</p>
      <input type="text" class="fpv-input" id="fpv-nome" placeholder="Nome" />
      <input type="text" class="fpv-input" id="fpv-cognome" placeholder="Cognome" />
      <select class="fpv-select" id="fpv-qualifica">
        <option value="" disabled selected>Seleziona la qualifica...</option>
        ${opts}
      </select>
      <div class="fpv-error" id="fpv-reg-error" style="display:none;"></div>
      <button class="fpv-btn" id="fpv-reg-submit">Continua</button>
    `;
    body.appendChild(wrap);
    const errEl = wrap.querySelector("#fpv-reg-error");
    wrap.querySelector("#fpv-reg-submit").addEventListener("click", async () => {
      const nome = wrap.querySelector("#fpv-nome").value.trim();
      const cognome = wrap.querySelector("#fpv-cognome").value.trim();
      const qualifica = wrap.querySelector("#fpv-qualifica").value;
      errEl.style.display = "none";
      if (!nome || !cognome || !qualifica) {
        errEl.textContent = "Compila tutti i campi.";
        errEl.style.display = "block";
        return;
      }
      try {
        await api("/api/register", { method: "POST", body: JSON.stringify({ nome, cognome, qualifica }) });
        saveSession({ token, registered: true });
        startChat();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.style.display = "block";
      }
    });
  }

  // ---------- Step 3: chat ----------
  function startChat() {
    body.innerHTML = "";
    footer.style.display = "flex";
    addMsg("Buongiorno, come posso aiutarti?", "bot");
    input.focus();
  }

  async function sendQuestion() {
    const text = input.value.trim();
    if (!text) return;
    addMsg(text, "user");
    input.value = "";
    sendBtn.disabled = true;
    try {
      const data = await api("/api/chat", { method: "POST", body: JSON.stringify({ domanda: text }) });
      addMsg(data.risposta, "bot");
      if (typeof data.remaining === "number") {
        const counterEl = document.createElement("div");
        counterEl.className = "fpv-counter";
        counterEl.textContent = `Domande rimanenti questo mese: ${data.remaining}`;
        body.appendChild(counterEl);
        body.scrollTop = body.scrollHeight;
      }
    } catch (err) {
      addMsg(err.message, "system");
      if (/sessione|registrazione/i.test(err.message)) {
        clearSession();
        setTimeout(initFlow, 1200);
      }
    } finally {
      sendBtn.disabled = false;
    }
  }
  sendBtn.addEventListener("click", sendQuestion);
  input.addEventListener("keydown", (e) => e.key === "Enter" && sendQuestion());

  // ---------- Avvio ----------
  function initFlow() {
    body.dataset.init = "1";
    footer.style.display = "none";
    const session = getSession();
    if (session && session.token && session.registered) {
      startChat();
    } else {
      showPasswordStep();
    }
  }
})();
