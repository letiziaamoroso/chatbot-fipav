// db.js — inizializzazione database SQLite e funzioni di accesso ai dati
const path = require("path");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "chatbot.db");
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

// ---------- SCHEMA ----------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  password TEXT UNIQUE NOT NULL,
  societa TEXT,
  codice_societa TEXT,
  nome TEXT,
  cognome TEXT,
  qualifica TEXT,
  registered INTEGER NOT NULL DEFAULT 0,
  question_count INTEGER NOT NULL DEFAULT 0,
  count_month TEXT,                 -- formato 'YYYY-MM', mese a cui si riferisce question_count
  blocked INTEGER NOT NULL DEFAULT 0, -- blocco (manuale o automatico al raggiungimento del limite)
  blocked_reason TEXT,                -- 'limite' oppure 'manuale', null se non bloccato
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  nome TEXT,
  cognome TEXT,
  qualifica TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  nome TEXT,
  cognome TEXT,
  qualifica TEXT,
  domanda TEXT NOT NULL,
  risposta TEXT,
  faq INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

// Migrazioni: se il database esisteva già prima di queste colonne, aggiungile.
for (const stmt of [
  "ALTER TABLE users ADD COLUMN societa TEXT",
  "ALTER TABLE users ADD COLUMN codice_societa TEXT",
  "ALTER TABLE logs ADD COLUMN faq INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE users ADD COLUMN blocked_reason TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (err) {
    // colonna già presente, va bene così
  }
}

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ---------- UTENTI ----------
function getUserByPassword(password) {
  return db.prepare("SELECT * FROM users WHERE password = ?").get(password);
}

function getUserById(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}

function touchLogin(userId) {
  db.prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(userId);
}

function registerUser(userId, nome, cognome, qualifica) {
  db.prepare(
    "UPDATE users SET nome = ?, cognome = ?, qualifica = ?, registered = 1 WHERE id = ?"
  ).run(nome, cognome, qualifica, userId);
}

// Assicura che il contatore sia relativo al mese corrente; se il mese è cambiato, lo azzera.
function ensureCurrentMonth(user) {
  const m = currentMonth();
  if (user.count_month !== m) {
    db.prepare("UPDATE users SET question_count = 0, count_month = ? WHERE id = ?").run(m, user.id);
    user.question_count = 0;
    user.count_month = m;
  }
  return user;
}

function incrementQuestionCount(userId) {
  db.prepare("UPDATE users SET question_count = question_count + 1 WHERE id = ?").run(userId);
}

function addUser(password, societa = null, codiceSocieta = null) {
  const stmt = db.prepare(
    "INSERT INTO users (password, societa, codice_societa, count_month) VALUES (?, ?, ?, ?)"
  );
  return stmt.run(password, societa, codiceSocieta, currentMonth());
}

function listUsers() {
  return db.prepare("SELECT * FROM users ORDER BY created_at DESC").all();
}

function deleteUser(id) {
  db.prepare("DELETE FROM logs WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}

function resetCounter(id) {
  db.prepare("UPDATE users SET question_count = 0, count_month = ? WHERE id = ?").run(currentMonth(), id);
}

function setBlocked(id, blocked, reason = null) {
  db.prepare("UPDATE users SET blocked = ?, blocked_reason = ? WHERE id = ?").run(
    blocked ? 1 : 0,
    blocked ? reason : null,
    id
  );
}

function updatePassword(id, newPassword) {
  db.prepare("UPDATE users SET password = ? WHERE id = ?").run(newPassword, id);
}

// ---------- SESSIONI ----------
function createSession(token, userId, ttlHours = 12) {
  const expires = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
  db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").run(
    token,
    userId,
    expires
  );
}

function setSessionIdentity(token, nome, cognome, qualifica) {
  db.prepare("UPDATE sessions SET nome = ?, cognome = ?, qualifica = ? WHERE token = ?").run(
    nome,
    cognome,
    qualifica,
    token
  );
}

function getSession(token) {
  const s = db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
  if (!s) return null;
  if (new Date(s.expires_at) < new Date()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return null;
  }
  return s;
}

// ---------- LOG DOMANDE ----------
function addLog(userId, nome, cognome, qualifica, domanda, risposta) {
  db.prepare(
    "INSERT INTO logs (user_id, nome, cognome, qualifica, domanda, risposta) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(userId, nome, cognome, qualifica, domanda, risposta);
}

function listLogs(limit = 500) {
  return db
    .prepare(`SELECT id, user_id, nome, cognome, qualifica, domanda, risposta, faq, timestamp
              FROM logs ORDER BY timestamp DESC LIMIT ?`)
    .all(limit);
}

function setLogFaq(id, faq) {
  db.prepare("UPDATE logs SET faq = ? WHERE id = ?").run(faq ? 1 : 0, id);
}

function listFaqs() {
  return db
    .prepare(`SELECT id, user_id, nome, cognome, qualifica, domanda, risposta, faq, timestamp
              FROM logs WHERE faq = 1 ORDER BY timestamp DESC`)
    .all();
}

module.exports = {
  db,
  currentMonth,
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
  updatePassword,
  createSession,
  setSessionIdentity,
  getSession,
  addLog,
  listLogs,
  setLogFaq,
  listFaqs,
};
