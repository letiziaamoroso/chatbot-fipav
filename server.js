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
  createSession,
  setSessionIdentity,
  getSession,
  addLog,
  listLogs,
} = require("./db");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "cambia-questa-password";
const MAX_QUESTIONS_PER_MONTH = parseInt(process.env.MAX_QUESTIONS_PER_MONTH || "50", 10);
const DOCS_DIR = path.join(__dirname, "docs");

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

function buildSystemPrompt(relevantText) {
  return `Sei l'assistente virtuale del Comitato Regionale FIPAV. Rispondi alle domande degli utenti ESCLUSIVAMENTE sulla base degli estratti di documentazione forniti qui sotto (selezionati automaticamente come i più pertinenti alla domanda).

Regole:
- Se la risposta non si trova negli estratti forniti, di' chiaramente che non hai questa informazione e suggerisci di contattare la segreteria del Comitato. Non inventare nulla.
- Rispondi in italiano, in modo chiaro e cordiale.
- Sii conciso: rispondi solo a quanto viene chiesto, senza aggiungere sezioni o informazioni non richieste.

ESTRATTI DI DOCUMENTAZIONE RILEVANTI:
${relevantText || "(nessun estratto pertinente trovato)"}`;
}

async function askClaude(domanda) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata sul server.");
  }

  const { text: relevantText } = search(DOCS_INDEX, domanda, 90000, 40);

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 1000,
      system: buildSystemPrompt(relevantText),
      messages: [{ role: "user", content: domanda }],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Errore API Claude (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === "text");
  return textBlock ? textBlock.text : "Non sono riuscito a generare una risposta.";
}

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

function requireAdmin(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: "Password amministratore non valida." });
  next();
}

app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Codice di accesso mancante." });

  const user = getUserByPassword(password.trim());
  if (!user) return res.status(401).json({ error: "Codice di accesso non riconosciuto." });
  if (user.blocked) return res.status(403).json({ error: "Questo codice di accesso è stato sospeso. Contatta il Comitato." });

  touchLogin(user.id);
  const token = crypto.randomBytes(24).toString("hex");
  createSession(token, user.id);

  res.json({ token });
});

app.post("/api/register", requireSession, (req, res) => {
  const { nome, cognome, qualifica } = req.body;
  if (!nome || !cognome || !qualifica) {
    return res.status(400).json({ error: "Nome, cognome e qualifica sono obbligatori." });
  }
  setSessionIdentity(req.sessionToken, nome.trim(), cognome.trim(), qualifica.trim());
  res.json({ ok: true });
});

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
    return res.status(403).json({ error: "Questo codice di accesso è stato sospeso. Contatta il Comitato." });
  }
  if (user.question_count >= MAX_QUESTIONS_PER_MONTH) {
    return res.status(429).json({
      error: `Hai raggiunto il limite di ${MAX_QUESTIONS_PER_MONTH} domande per questo mese. Riprova dal mese prossimo o contatta il Comitato.`,
    });
  }

  try {
    const risposta = await askClaude(domanda.trim());
    incrementQuestionCount(user.id);
    addLog(user.id, req.session.nome, req.session.cognome, req.session.qualifica, domanda.trim(), risposta);
    const remaining = MAX_QUESTIONS_PER_MONTH - (user.question_count + 1);
    res.json({ risposta, remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Errore nel generare la risposta. Riprova tra poco." });
  }
});

app.post("/api/admin/verify", requireAdmin, (req, res) => res.json({ ok: true }));

app.get("/api/admin/users", requireAdmin, (req, res) => {
  res.json(listUsers());
});

app.get("/api/admin/logs", requireAdmin, (req, res) => {
  const limit = parseInt(req.query.limit || "500", 10);
  res.json(listLogs(limit));
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Codice di accesso obbligatorio." });
  try {
    addUser(password.trim());
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: "Codice già esistente o dati non validi." });
  }
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  deleteUser(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/reset-counter", requireAdmin, (req, res) => {
  resetCounter(req.params.id);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/block", requireAdmin, (req, res) => {
  setBlocked(req.params.id, true);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/unblock", requireAdmin, (req, res) => {
  setBlocked(req.params.id, false);
  res.json({ ok: true });
});

app.post("/api/admin/reload-docs", requireAdmin, async (req, res) => {
  await reloadDocs();
  res.json({ ok: true, totalChars: TOTAL_DOC_CHARS, chunks: DOCS_INDEX.chunks.length });
});

app.get("/api/health", (req, res) =>
  res.json({ ok: true, totalDocChars: TOTAL_DOC_CHARS, chunks: DOCS_INDEX.chunks.length })
);

async function start() {
  await reloadDocs();
  app.listen(PORT, () => {
    console.log(`Chatbot FIPAV in ascolto sulla porta ${PORT}`);
  });
}

start();
