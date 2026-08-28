// seed-users.js — crea rapidamente un elenco di utenti con password
// Uso: node seed-users.js utenti.csv
// Il CSV deve avere una password per riga (opzionalmente: password,nome,cognome,qualifica)
require("dotenv").config();
const fs = require("fs");
const { addUser } = require("./db");

const file = process.argv[2];
if (!file) {
  console.log("Uso: node seed-users.js percorso/al/file.csv");
  console.log("Formato riga: password[,nome,cognome,qualifica]");
  process.exit(1);
}

const lines = fs
  .readFileSync(file, "utf-8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean);

let created = 0;
for (const line of lines) {
  const [password, nome, cognome, qualifica] = line.split(",").map((s) => (s || "").trim());
  if (!password) continue;
  try {
    addUser(password, nome || null, cognome || null, qualifica || null);
    created++;
  } catch (err) {
    console.warn(`Riga saltata (password duplicata?): ${line}`);
  }
}

console.log(`Creati ${created} utenti su ${lines.length} righe.`);
