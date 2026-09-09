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
  setLogFaq,
  listFaqs,
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
      documents.push({ name: relativeName, content });
    }
  }
  return documents;
}

let DOCS_INDEX = { chunks: [], df: new Map(), N: 0, avgLen: 0 };
let TOTAL_DOC_CHARS = 0;

async function reloadDocs() {
  const documents = await loadDocuments();
  TOTAL_DOC_CHARS = documents.reduce((s, d) => s + d.content.length, 0);
  DOCS_INDEX = buildIndex(documents);
  console.log(
    `Documentazione caricata: ${documents.length} file, ${TOTAL_DOC_CHARS} caratteri totali, ${DOCS_INDEX.chunks.length} sezioni indicizzate.`
  );
}

const NOT_FOUND_MARKER = "NON_TROVATO:";
const NOT_FOUND_FINAL = "NON_TROVATO_DEFINITIVO";

function buildSystemPromptRound1(relevantText) {
  return `Sei l'assistente virtuale del Comitato Regionale FIPAV Marche. Rispondi alle domande degli utenti ESCLUSIVAMENTE sulla base degli estratti di documentazione forniti qui sotto (selezionati automaticamente come i più pertinenti alla domanda).

Regole:
- Rispondi in italiano, in modo chiaro e cordiale.
- IMPORTANTE: dai sempre una risposta completa e ben formata. Se stai elencando categorie, punti o un elenco, riportali per intero, non fermarti a metà.
- Sii conciso ma completo: rispondi a quanto viene chiesto senza lasciare frasi a metà.
- Se la risposta NON si trova chiaramente negli estratti forniti, NON inventare nulla e NON scrivere una risposta normale. Rispondi invece ESATTAMENTE in questo formato, senza aggiungere altro testo:
${NOT_FOUND_MARKER} <qui riscrivi la domanda originale usando la terminologia tecnica e ufficiale prevista dalla normativa/regolamenti FIPAV, per tentare una nuova ricerca più precisa>

ESTRATTI DI DOCUMENTAZIONE RILEVANTI:
${relevantText || "(nessun estratto pertinente trovato)"}`;
}

function buildSystemPromptRound2(relevantText) {
  return `Sei l'assistente virtuale del Comitato Regionale FIPAV Marche. Rispondi alle domande degli utenti ESCLUSIVAMENTE sulla base degli estratti di documentazione forniti qui sotto (selezionati automaticamente come i più pertinenti alla domanda, dopo aver riformulato la domanda con terminologia tecnica).

Regole:
- Rispondi in italiano, in modo chiaro e cordiale.
- IMPORTANTE: dai sempre una risposta completa e ben formata. Se stai elencando categorie, punti o un elenco, riportali per intero, non fermarti a metà.
- Sii conciso ma completo: rispondi a quanto viene chiesto senza lasciare frasi a metà.
- Se la risposta NON si trova negli estratti forniti nemmeno questa volta, NON inventare nulla: rispondi ESATTAMENTE con la parola ${NOT_FOUND_FINAL} e nient'altro.

ESTRATTI DI DOCUMENTAZIONE RILEVANTI:
${relevantText || "(nessun estratto pertinente trovato)"}`;
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
// Chiamata a Claude, con un secondo tentativo che riformula la domanda usando
// terminologia tecnica/normativa se la prima ricerca non trova nulla.
// ---------------------------------------------------------------------------
async function askClaude(domanda) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata sul server.");
  }

  // Primo tentativo, con la domanda originale
  const { text: relevantText1 } = search(DOCS_INDEX, domanda, 120000, 50);
  const answer1 = await callClaude(buildSystemPromptRound1(relevantText1), domanda);

  if (!answer1.startsWith(NOT_FOUND_MARKER)) {
    return answer1;
  }

  // Secondo tentativo, con la domanda riformulata con terminologia tecnica
  const riformulata = answer1.slice(NOT_FOUND_MARKER.length).trim() || domanda;
  const { text: relevantText2 } = search(DOCS_INDEX, riformulata, 120000, 50);
  const answer2 = await callClaude(buildSystemPromptRound2(relevantText2), riformulata);

  if (!answer2 || answer2.includes(NOT_FOUND_FINAL)) {
    return `Non sono riuscito a trovare questa informazione nella documentazione disponibile, nemmeno riformulando la domanda. Ti invito a scrivere a ${CONTACT_EMAIL} per ricevere assistenza dal Comitato.`;
  }

  return answer2;
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

  res.json({ token });
});

// 2. Registrazione nome/cognome/qualifica (ad ogni accesso: il codice è condiviso)
app.post("/api/register", requireSession, (req, res) => {
  const { nome, cognome, qualifica } = req.body;
  if (!nome || !cognome || !qualifica) {
    return res.status(400).json({ error: "Nome, cognome e qualifica sono obbligatori." });
  }
  setSessionIdentity(req.sessionToken, nome.trim(), cognome.trim(), qualifica.trim());
  res.json({ ok: true });
});

// 3. Domanda al chatbot
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
  const { password, societa, codiceSocieta } = req.body;
  if (!password) return res.status(400).json({ error: "Password obbligatoria." });
  try {
    addUser(password.trim(), societa ? societa.trim() : null, codiceSocieta ? codiceSocieta.trim() : null);
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

app.post("/api/admin/reload-docs", requireAdmin, async (req, res) => {
  await reloadDocs();
  res.json({ ok: true, totalChars: TOTAL_DOC_CHARS, chunks: DOCS_INDEX.chunks.length });
});

app.post("/api/admin/logs/:id/faq", requireAdmin, (req, res) => {
  const { faq } = req.body;
  setLogFaq(req.params.id, !!faq);
  res.json({ ok: true });
});

app.get("/api/admin/faqs", requireAdmin, (req, res) => {
  res.json(listFaqs());
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
