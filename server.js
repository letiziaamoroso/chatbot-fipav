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
  registerUser,
  ensureCurrentMonth,
  incrementQuestionCount,
  addUser,
  listUsers,
  deleteUser,
  resetCounter,
  setBlocked,
  createSession,
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

// ---------------------------------------------------------------------------
// Caricamento documentazione (RAG "semplice": tutta la documentazione viene
// inserita nel system prompt di Claude, che risponde SOLO su questa base).
// Per corpus molto grandi (centinaia di pagine) valutare in futuro un
// approccio con ricerca per similarità (embeddings + vector DB).
// ---------------------------------------------------------------------------
function loadDocumentation() {
  if (!fs.existsSync(DOCS_DIR)) return "";
  const files = fs
    .readdirSync(DOCS_DIR)
    .filter((f) => /\.(txt|md)$/i.test(f));
  let combined = "";
  for (const f of files) {
    const content = fs.readFileSync(path.join(DOCS_DIR, f), "utf-8");
    combined += `\n\n===== DOCUMENTO: ${f} =====\n${content}`;
  }
  return combined.trim();
}

let DOCUMENTATION = loadDocumentation();
const DOC_CHAR_LIMIT = 400000; // ~ margine di sicurezza sotto la context window
if (DOCUMENTATION.length > DOC_CHAR_LIMIT) {
  console.warn(
    `ATTENZIONE: la documentazione supera ${DOC_CHAR_LIMIT} caratteri (${DOCUMENTATION.length}). ` +
      `Verrà troncata. Valutare un sistema di ricerca per similarità (embeddings).`
  );
  DOCUMENTATION = DOCUMENTATION.slice(0, DOC_CHAR_LIMIT);
}

function buildSystemPrompt() {
  return `Sei l'assistente virtuale del Comitato Regionale FIPAV. Rispondi alle domande degli utenti ESCLUSIVAMENTE sulla base della documentazione fornita qui sotto.

Regole:
- Se la risposta non si trova nella documentazione, di' chiaramente che non hai questa informazione e suggerisci di contattare la segreteria del Comitato. Non inventare nulla.
- Rispondi in italiano, in modo chiaro e cordiale.
- Sii conciso: rispondi solo a quanto viene chiesto, senza aggiungere sezioni o informazioni non richieste.

DOCUMENTAZIONE DISPONIBILE:
${DOCUMENTATION || "(nessuna documentazione caricata)"}`;
}

// ---------------------------------------------------------------------------
// Chiamata a Claude
// ---------------------------------------------------------------------------
async function askClaude(domanda) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY non configurata sul server.");
  }
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
      system: buildSystemPrompt(),
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

// 1. Login con password personale
app.post("/api/login", (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password mancante." });

  const user = getUserByPassword(password.trim());
  if (!user) return res.status(401).json({ error: "Utente non riconosciuto." });
  if (user.blocked) return res.status(403).json({ error: "Il tuo accesso è stato sospeso. Contatta il Comitato." });

  touchLogin(user.id);
  const token = crypto.randomBytes(24).toString("hex");
  createSession(token, user.id);

  res.json({
    token,
    registered: !!user.registered,
    nome: user.nome,
    cognome: user.cognome,
    qualifica: user.qualifica,
  });
});

// 2. Registrazione nome/cognome/qualifica (solo al primo accesso)
app.post("/api/register", requireSession, (req, res) => {
  const { nome, cognome, qualifica } = req.body;
  if (!nome || !cognome || !qualifica) {
    return res.status(400).json({ error: "Nome, cognome e qualifica sono obbligatori." });
  }
  registerUser(req.user.id, nome.trim(), cognome.trim(), qualifica.trim());
  res.json({ ok: true });
});

// 3. Domanda al chatbot
app.post("/api/chat", requireSession, async (req, res) => {
  const { domanda } = req.body;
  if (!domanda || !domanda.trim()) {
    return res.status(400).json({ error: "Domanda vuota." });
  }

  let user = ensureCurrentMonth(req.user);
  if (!user.registered) {
    return res.status(403).json({ error: "Completa prima la registrazione (nome, cognome, qualifica)." });
  }
  if (user.blocked) {
    return res.status(403).json({ error: "Il tuo accesso è stato sospeso. Contatta il Comitato." });
  }
  if (user.question_count >= MAX_QUESTIONS_PER_MONTH) {
    return res.status(429).json({
      error: `Hai raggiunto il limite di ${MAX_QUESTIONS_PER_MONTH} domande per questo mese. Riprova dal mese prossimo o contatta il Comitato.`,
    });
  }

  try {
    const risposta = await askClaude(domanda.trim());
    incrementQuestionCount(user.id);
    addLog(user.id, domanda.trim(), risposta);
    const remaining = MAX_QUESTIONS_PER_MONTH - (user.question_count + 1);
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
  const { password, nome, cognome, qualifica } = req.body;
  if (!password) return res.status(400).json({ error: "Password obbligatoria." });
  try {
    addUser(password.trim(), nome || null, cognome || null, qualifica || null);
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

app.post("/api/admin/reload-docs", requireAdmin, (req, res) => {
  DOCUMENTATION = loadDocumentation();
  res.json({ ok: true, chars: DOCUMENTATION.length });
});

app.get("/api/health", (req, res) => res.json({ ok: true, docsChars: DOCUMENTATION.length }));

app.listen(PORT, () => {
  console.log(`Chatbot FIPAV in ascolto sulla porta ${PORT}`);
  console.log(`Documentazione caricata: ${DOCUMENTATION.length} caratteri`);
});
