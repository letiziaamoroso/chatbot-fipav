// server.js — API del chatbot FIPAV
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const {
  getUserByPassword,
  getUserById,
  touchLogin,
  ensureCurrentMonth,
  incrementQuestionCount,
  addUser,
  setUserEmail,
  listUsers,
  deleteUser,
  resetCounter,
  setBlocked,
  updatePassword,
  createSession,
  setSessionIdentity,
  getSession,
  addLog,
  listLogs,
  listLogsForUser,
  setLogFaq,
  setLogCategoria,
  listFaqs,
  addManualFaq,
} = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambia-questa-password";
const MAX_QUESTIONS_PER_MONTH = parseInt(process.env.MAX_QUESTIONS_PER_MONTH || "100", 10);
const CONTACT_EMAIL = "marche@federvolley.it";
const DOCS_DIR = path.join(__dirname, "docs");

// ---------------------------------------------------------------------------
// Caricamento documentazione (RAG "semplice": tutta la documentazione viene
// inserita nel system prompt di Claude, che risponde SOLO su questa base).
// Per corpus molto grandi (centinaia di pagine) valutare in futuro un
// approccio con ricerca per similarità (embeddings + vector DB).
// ---------------------------------------------------------------------------
const mammoth = require("mammoth");
const { buildIndex, search } = require("./retrieval");
const { findLink } = require("./links");

// Dato un documento/sezione, trova il link ufficiale corrispondente (se
// riconosciuto nella tabella docs-links.json) da mostrare insieme alla
// citazione della fonte. Usa SOLO la sezione (il PDF originale specifico,
// es. "Regolamento Affiliazione e Tesseramento 2024") e non il nome del
// documento generale (es. "Documenti Istituzionali (Statuto, Regolamenti...)"),
// che è volutamente descrittivo/ampio e darebbe match falsi. Meglio nessun
// link che un link sbagliato.
function linkResolver(source, section) {
  const match = findLink(section);
  return match ? match.link : null;
}

// Nomi "leggibili" mostrati nelle citazioni delle fonti, al posto del nome
// tecnico del file. Se un nuovo documento viene aggiunto senza essere elencato
// qui, si usa comunque il suo nome file cosi' come si presenta (nessun errore).
const DISPLAY_NAMES = {
  "istituzionali.docx": "Documenti Istituzionali (Statuto, Regolamenti, Normativa federale)",
  "regionale.docx": "Documentazione del Comitato Regionale Marche (circolari, formule campionati)",
  "guida_pratica_indoor.docx": "Guida Pratica Campionati Indoor",
  "guida_pratica_scuola_promozione.docx": "Guida Pratica Scuola e Promozione (Minivolley/S3)",
  "beach_volley_guida_pratica.docx": "Guida Pratica Beach Volley",
  "regole gioco beach ridotto.docx": "Regolamento di Gioco - Beach Volley",
  "regole gioco indoor ridotto.docx": "Regolamento di Gioco - Pallavolo Indoor",
  "regole gioco sittin.docx": "Regolamento di Gioco - Sitting Volley",
};

// DOCUMENTI PRIORITARI: un file il cui nome inizia con "PRIORITA_" (oppure che
// si trova in una sottocartella chiamata "prioritari") viene consultato per
// PRIMO dal chatbot; solo se la risposta non c'è lì si passa agli altri.
const PRIORITY_NAME_RE = /^priorit[aà][_\- ]/i;

function isPriorityFile(relativeName) {
  const parts = relativeName.split(/[\\/]/);
  const base = parts[parts.length - 1];
  const folders = parts.slice(0, -1).map((f) => f.toLowerCase());
  return PRIORITY_NAME_RE.test(base) || folders.includes("prioritari");
}

function displayNameFor(relativeName) {
  if (DISPLAY_NAMES[relativeName]) return DISPLAY_NAMES[relativeName];
  // Per i documenti prioritari non elencati sopra: nome file senza prefisso,
  // estensione e underscore (es. "PRIORITA_Circolare_Tesseramento.docx" ->
  // "Circolare Tesseramento").
  if (isPriorityFile(relativeName)) {
    const base = relativeName.split(/[\\/]/).pop();
    return base
      .replace(PRIORITY_NAME_RE, "")
      .replace(/\.(txt|md|docx)$/i, "")
      .replace(/_+/g, " ")
      .trim() || relativeName;
  }
  return relativeName;
}

async function loadDocuments() {
  if (!fs.existsSync(DOCS_DIR)) return [];

  function walk(dir) {
    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(walk(fullPath));
      } else if (/\.(txt|md|docx)$/i.test(entry.name)) {
        results.push(fullPath);
      }
    }
    return results;
  }

  const files = walk(DOCS_DIR);
  const documents = [];
  for (const filePath of files) {
    const relativeName = path.relative(DOCS_DIR, filePath);
    let content;
    if (/\.docx$/i.test(filePath)) {
      try {
        const result = await mammoth.extractRawText({ path: filePath });
        content = result.value;
      } catch (err) {
        console.warn(`Impossibile leggere ${relativeName}: ${err.message}`);
        continue;
      }
    } else {
      content = fs.readFileSync(filePath, "utf-8");
    }
    if (content && content.trim()) {
      documents.push({
        name: displayNameFor(relativeName),
        content,
        priority: isPriorityFile(relativeName),
      });
    }
  }
  return documents;
}

let DOCS_INDEX = { chunks: [], df: new Map(), N: 0, avgLen: 0, hasPriority: false };
let TOTAL_DOC_CHARS = 0;

async function reloadDocs() {
  const documents = await loadDocuments();
  TOTAL_DOC_CHARS = documents.reduce((s, d) => s + d.content.length, 0);
  DOCS_INDEX = buildIndex(documents);
  const priorityDocs = documents.filter((d) => d.priority).map((d) => d.name);
  console.log(
    `Documentazione caricata: ${documents.length} file, ${TOTAL_DOC_CHARS} caratteri totali, ${DOCS_INDEX.chunks.length} sezioni indicizzate.`
  );
  console.log(
    priorityDocs.length
      ? `Documenti prioritari (consultati per primi): ${priorityDocs.join("; ")}`
      : "Nessun documento prioritario (nome file che inizia con PRIORITA_)."
  );
}

const NOT_FOUND_MARKER = "NON_TROVATO:";
const MAX_REFORMULATIONS = 3; // tentativi di riformulazione oltre alla domanda originale

function buildSystemPrompt(relevantText, priorityText = "") {
  const hasPriority = !!priorityText;
  const priorityRule = hasPriority
    ? `
- ORDINE DI CONSULTAZIONE DELLE FONTI (regola prioritaria su tutte le altre): gli estratti sono divisi in due sezioni, "FONTI PRIORITARIE" e "ALTRE FONTI". Consulta SEMPRE per prime le FONTI PRIORITARIE: se la risposta è presente lì, rispondi basandoti su di esse. Puoi aggiungere dettagli dalle ALTRE FONTI solo se non contraddicono le fonti prioritarie; in caso di discordanza prevale SEMPRE la fonte prioritaria (anche rispetto alla regola sulla data più recente). Solo se la risposta NON si trova nelle FONTI PRIORITARIE, consulta le ALTRE FONTI. Nella riga "Fonte:" cita solo i documenti che hai effettivamente usato.`
    : "";
  const extracts = hasPriority
    ? `FONTI PRIORITARIE (da consultare per prime):
${priorityText}

ALTRE FONTI (da consultare solo se la risposta non è nelle fonti prioritarie):
${relevantText || "(nessun estratto pertinente trovato)"}`
    : relevantText || "(nessun estratto pertinente trovato)";
  return `Sei l'assistente virtuale del Comitato Regionale FIPAV Marche. Rispondi alle domande degli utenti ESCLUSIVAMENTE sulla base degli estratti di documentazione forniti qui sotto (selezionati automaticamente come i più pertinenti alla domanda).

Gli estratti sono organizzati in blocchi preceduti da un'intestazione del tipo:
===== DOCUMENTO: <nome documento> | SEZIONE: <nome sezione o "generale"> | DATA: <data o stagione, se nota> | LINK: <url, se noto> =====
(DATA e LINK compaiono solo quando disponibili: non tutti i blocchi li hanno.)

Regole:
- Rispondi in italiano, in modo chiaro e cordiale.
- IMPORTANTE: dai sempre una risposta completa e ben formata. Se stai elencando categorie, punti o un elenco, riportali per intero, non fermarti a metà.
- Sii conciso ma completo: rispondi a quanto viene chiesto senza lasciare frasi a metà.
- PRIORITÀ ALLE FONTI PIÙ RECENTI (valida tra fonti dello stesso livello): se due blocchi riportano informazioni discordanti sullo stesso argomento (es. regole o importi cambiati da una stagione all'altra) e hanno entrambi un campo DATA, usa SEMPRE l'informazione del blocco con la data più recente, e segnalalo brevemente nella risposta (es. "la normativa più recente, aggiornata al ..., prevede che..."). Se la data non è indicata in nessuno dei due blocchi, non puoi dedurre quale sia più recente: in quel caso segnala la discordanza all'utente invece di sceglierne una a caso.
- CITAZIONE DELLA FONTE (obbligatoria in ogni risposta che non sia NON_TROVATO): alla fine della risposta aggiungi sempre una riga separata che inizia con "Fonte:" seguita dal/i nome/i di DOCUMENTO e, quando la SEZIONE non è "generale", anche dalla SEZIONE, copiati esattamente come compaiono nell'intestazione del blocco da cui hai preso l'informazione. Se il blocco ha un campo LINK, aggiungi il link tra parentesi subito dopo. Se hai usato più blocchi, elenca tutte le fonti separate da un punto e virgola. Esempi:
  Fonte: Documenti Istituzionali (Statuto, Regolamenti, Normativa federale) — Regolamento Affiliazione e Tesseramento 2024 (https://www.federvolley.it/regolamenti-0)
  Fonte: Guida Pratica Campionati Indoor — Guida pratica_Allenatori_2627; Documenti Istituzionali (Statuto, Regolamenti, Normativa federale) — Statuto FIPAV - 2025 - definitivo (https://www.federvolley.it/statuto)
- NON inventare MAI un link: usa solo quelli che compaiono esplicitamente come LINK nell'intestazione del blocco. Se un blocco non ha LINK, cita solo documento e sezione, senza link.${priorityRule}
- Se la risposta NON si trova chiaramente negli estratti forniti, NON inventare nulla e NON scrivere una risposta normale (e in questo caso NON aggiungere la riga "Fonte:"). Rispondi invece ESATTAMENTE in questo formato, senza aggiungere altro testo:
${NOT_FOUND_MARKER} <qui riscrivi la domanda in modo più chiaro e dettagliato, usando la terminologia tecnica e ufficiale prevista dalla normativa/regolamenti FIPAV, per tentare una nuova ricerca più precisa>

ESTRATTI DI DOCUMENTAZIONE RILEVANTI:
${extracts}`;
}

async function callClaude(systemPrompt, domanda) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: "user", content: domanda }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Errore API Claude (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text.trim() : "";
}

// ---------------------------------------------------------------------------
// Chiamata a Claude. Se la prima ricerca non trova la risposta, il sistema
// prova a riformulare la domanda con terminologia tecnica/normativa fino a
// MAX_REFORMULATIONS volte, prima di indirizzare l'utente via email.
// ---------------------------------------------------------------------------
async function askClaude(domanda) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata sul server.");
  }

  let currentQuery = domanda;

  for (let attempt = 0; attempt <= MAX_REFORMULATIONS; attempt++) {
    let systemPrompt;
    if (DOCS_INDEX.hasPriority) {
      // Prima i documenti prioritari, poi (con il budget rimanente) tutti gli altri.
      const { text: priorityText } = search(DOCS_INDEX, currentQuery, 50000, 20, linkResolver, true);
      const { text: otherText } = search(DOCS_INDEX, currentQuery, 70000, 30, linkResolver, false);
      systemPrompt = buildSystemPrompt(otherText, priorityText);
    } else {
      const { text: relevantText } = search(DOCS_INDEX, currentQuery, 120000, 50, linkResolver);
      systemPrompt = buildSystemPrompt(relevantText);
    }
    const answer = await callClaude(systemPrompt, currentQuery);

    if (!answer.startsWith(NOT_FOUND_MARKER)) {
      return answer;
    }

    const reformulated = answer.slice(NOT_FOUND_MARKER.length).trim();
    if (!reformulated) break; // il modello non ha proposto una riformulazione: inutile continuare
    currentQuery = reformulated;
  }

  return `Non sono riuscito a trovare questa informazione nella documentazione disponibile, nemmeno dopo aver riformulato la domanda più volte con terminologia tecnica. Ti invito a scrivere a ${CONTACT_EMAIL} per ricevere assistenza dal Comitato.`;
}

// ---------------------------------------------------------------------------
// Middleware: richiede una sessione utente valida (header x-session-token)
// ---------------------------------------------------------------------------
function requireSession(req, res, next) {
  const token = req.headers["x-session-token"];
  if (!token) return res.status(401).json({ error: "Sessione mancante." });
  const session = getSession(token);
  if (!session) return res.status(401).json({ error: "Sessione scaduta o non valida. Effettua di nuovo l'accesso." });
  const user = getUserById(session.user_id);
  if (!user) return res.status(401).json({ error: "Utente non trovato." });
  req.user = user;
  req.session = session;
  req.sessionToken = token;
  next();
}

// Middleware: richiede la password admin (header x-admin-password)
function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: "Password amministratore non valida." });
  next();
}

// ---------------------------------------------------------------------------
// ROTTE PUBBLICHE (widget)
// ---------------------------------------------------------------------------

// 1. Login con password
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password mancante." });

  const user = getUserByPassword(password.trim());
  if (!user) return res.status(401).json({ error: "Password non riconosciuta." });
  if (user.blocked) return res.status(403).json({ error: `Questo accesso è stato bloccato. Contatta il Comitato scrivendo a ${CONTACT_EMAIL}.` });

  touchLogin(user.id);
  const token = crypto.randomBytes(24).toString("hex");
  createSession(token, user.id);

  // La mail società è un dato unico per società (come il codice società): la
  // segnaliamo al widget solo se manca ancora, così chiede di inserirla una
  // volta sola e non ad ogni accesso.
  res.json({ token, needsEmail: !user.email });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// 2. Registrazione nome/cognome/qualifica (ad ogni accesso: il codice è condiviso)
// + eventualmente la mail società, richiesta solo se non è già stata inserita.
app.post("/api/register", requireSession, (req, res) => {
  const { nome, cognome, qualifica, email } = req.body;
  if (!nome || !cognome || !qualifica) {
    return res.status(400).json({ error: "Nome, cognome e qualifica sono obbligatori." });
  }
  if (!req.user.email) {
    if (!email || !email.trim() || !EMAIL_RE.test(email.trim())) {
      return res.status(400).json({ error: "Inserisci una mail società valida." });
    }
    setUserEmail(req.user.id, email.trim());
  }
  setSessionIdentity(req.sessionToken, nome.trim(), cognome.trim(), qualifica.trim());
  res.json({ ok: true });
});

// 3. Domande già fatte dalla propria società (per evitare ripetizioni)
app.get("/api/mie-domande", requireSession, (req, res) => {
  res.json(listLogsForUser(req.user.id));
});

// 4. Domanda al chatbot
app.post("/api/chat", requireSession, async (req, res) => {
  const { domanda } = req.body;
  if (!domanda || !domanda.trim()) {
    return res.status(400).json({ error: "Domanda vuota." });
  }

  let user = ensureCurrentMonth(req.user);
  if (!req.session.nome) {
    return res.status(403).json({ error: "Completa prima i tuoi dati (nome, cognome, qualifica)." });
  }
  if (user.blocked) {
    return res.status(403).json({ error: `Questo accesso è stato bloccato. Contatta il Comitato scrivendo a ${CONTACT_EMAIL}.` });
  }
  if (user.question_count >= MAX_QUESTIONS_PER_MONTH) {
    setBlocked(user.id, true, "limite");
    return res.status(429).json({
      error: `Hai raggiunto il limite di ${MAX_QUESTIONS_PER_MONTH} domande e il tuo accesso è stato bloccato automaticamente. Contatta il Comitato scrivendo a ${CONTACT_EMAIL} per sbloccarlo.`,
    });
  }

  try {
    const risposta = await askClaude(domanda.trim());
    incrementQuestionCount(user.id);
    addLog(user.id, req.session.nome, req.session.cognome, req.session.qualifica, domanda.trim(), risposta);
    const newCount = user.question_count + 1;
    if (newCount >= MAX_QUESTIONS_PER_MONTH) {
      setBlocked(user.id, true, "limite");
    }
    const remaining = Math.max(0, MAX_QUESTIONS_PER_MONTH - newCount);
    res.json({ risposta, remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel generare la risposta. Riprova tra poco." });
  }
});

// ---------------------------------------------------------------------------
// ROTTE ADMIN (pannello di controllo)
// ---------------------------------------------------------------------------

app.post("/api/admin/verify", requireAdmin, (req, res) => res.json({ ok: true }));

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json(listUsers());
});

app.get("/api/admin/logs", requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit || "500", 10);
  res.json(listLogs(limit));
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { password, societa, codiceSocieta, email } = req.body;
  if (!password) return res.status(400).json({ error: "Password obbligatoria." });
  if (email && email.trim() && !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: "Mail società non valida." });
  }
  try {
    addUser(
      password.trim(),
      societa ? societa.trim() : null,
      codiceSocieta ? codiceSocieta.trim() : null,
      email ? email.trim() : null
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Password già esistente o dati non validi." });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  deleteUser(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/reset-counter", requireAdmin, (req, res) => {
  resetCounter(req.params.id);
  setBlocked(req.params.id, false);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/block", requireAdmin, (req, res) => {
  setBlocked(req.params.id, true, "manuale");
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/unblock", requireAdmin, (req, res) => {
  setBlocked(req.params.id, false);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/password", requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password || !password.trim()) return res.status(400).json({ error: "Nuova password obbligatoria." });
  try {
    updatePassword(req.params.id, password.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Password già in uso da un altro accesso." });
  }
});

app.post("/api/admin/users/:id/email", requireAdmin, (req, res) => {
  const { email } = req.body;
  if (email && email.trim() && !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: "Mail società non valida." });
  }
  setUserEmail(req.params.id, email || null);
  res.json({ ok: true });
});

app.post("/api/admin/reload-docs", requireAdmin, async (req, res) => {
  await reloadDocs();
  res.json({ ok: true, totalChars: TOTAL_DOC_CHARS, chunks: DOCS_INDEX.chunks.length });
});

app.post("/api/admin/logs/:id/faq", requireAdmin, (req, res) => {
  const { faq } = req.body;
  setLogFaq(req.params.id, !!faq);
  res.json({ ok: true });
});

app.post("/api/admin/logs/:id/categoria", requireAdmin, (req, res) => {
  const { categoria } = req.body;
  setLogCategoria(req.params.id, categoria ? String(categoria).trim() : null);
  res.json({ ok: true });
});

app.get("/api/admin/faqs", requireAdmin, (req, res) => {
  res.json(listFaqs());
});

app.post("/api/admin/faqs", requireAdmin, (req, res) => {
  const { domanda, risposta } = req.body;
  if (!domanda || !domanda.trim() || !risposta || !risposta.trim()) {
    return res.status(400).json({ error: "Domanda e risposta sono entrambe obbligatorie." });
  }
  addManualFaq(domanda.trim(), risposta.trim());
  res.json({ ok: true });
});

app.get("/api/health", (req, res) =>
  res.json({ ok: true, totalDocChars: TOTAL_DOC_CHARS, chunks: DOCS_INDEX.chunks.length, maxQuestionsPerMonth: MAX_QUESTIONS_PER_MONTH })
);

async function start() {
  await reloadDocs();
  app.listen(PORT, () => {
    console.log(`Chatbot FIPAV in ascolto sulla porta ${PORT}`);
  });
}

start();
