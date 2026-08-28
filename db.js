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
  nome TEXT,
  cognome TEXT,
  qualifica TEXT,
  registered INTEGER NOT NULL DEFAULT 0,
  question_count INTEGER NOT NULL DEFAULT 0,
  count_month TEXT,                 -- formato 'YYYY-MM', mese a cui si riferisce question_count
  blocked INTEGER NOT NULL DEFAULT 0, -- blocco manuale opzionale da pannello admin
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  domanda TEXT NOT NULL,
  risposta TEXT,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
`);

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

function addUser(password, nome = null, cognome = null, qualifica = null) {
  const stmt = db.prepare(
    "INSERT INTO users (password, nome, cognome, qualifica, registered, count_month) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const registered = nome && cognome && qualifica ? 1 : 0;
  return stmt.run(password, nome, cognome, qualifica, registered, currentMonth());
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

function setBlocked(id, blocked) {
  db.prepare("UPDATE users SET blocked = ? WHERE id = ?").run(blocked ? 1 : 0, id);
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
function addLog(userId, domanda, risposta) {
  db.prepare("INSERT INTO logs (user_id, domanda, risposta) VALUES (?, ?, ?)").run(
    userId,
    domanda,
    risposta
  );
}

function listLogs(limit = 500) {
  return db
    .prepare(
      `SELECT logs.id, logs.domanda, logs.risposta, logs.timestamp,
              users.nome, users.cognome, users.qualifica, users.id AS user_id
       FROM logs JOIN users ON logs.user_id = users.id
       ORDER BY logs.timestamp DESC LIMIT ?`
    )
    .all(limit);
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
  createSession,
  getSession,
  addLog,
  listLogs,
};
