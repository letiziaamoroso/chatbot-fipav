// links.js — collega ogni documento/sezione rilevata nei file caricati al suo
// link ufficiale sul sito FIPAV, usando la tabella fornita in docs-links.json
// (esportata dal file Excel "chatboti_link_documenti.xlsx").
//
// Il confronto è "fuzzy": i nomi delle sezioni rilevati automaticamente nei
// .docx (es. "Guida pratica_Allenatori_2627 (23.07.26)") non coincidono mai
// esattamente con i nomi nel foglio Excel (es. "Guida pratica Allenatori"),
// quindi si normalizzano entrambi i testi e si cerca la riga con il maggior
// numero di parole in comune. Se nessuna riga supera una soglia minima di
// somiglianza, NON viene restituito alcun link: è meglio nessun link che un
// link sbagliato.

const fs = require("fs");
const path = require("path");

const LINKS_PATH = path.join(__dirname, "docs-links.json");

let LINK_ROWS = [];
try {
  LINK_ROWS = JSON.parse(fs.readFileSync(LINKS_PATH, "utf-8"));
} catch (err) {
  console.warn(`Impossibile leggere ${LINKS_PATH}: ${err.message}. Le citazioni non includeranno link.`);
}

const STOPWORDS_LINK = new Set([
  "di","del","della","dei","degli","delle","e","per","con","su","il","lo","la",
  "i","gli","le","un","uno","una","stagione","sportiva","pubblicata","pubblicato",
]);

function normalizeTokens(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 3 && !STOPWORDS_LINK.has(t) && !/^\d{1,2}$/.test(t));
}

// Precalcola i token di ogni riga, separando "documento" (più specifico,
// peso maggiore) da "categoria" (più generico, usato solo come conferma).
const INDEXED_ROWS = LINK_ROWS.map((row) => ({
  ...row,
  tokensDocOnly: new Set(normalizeTokens(row.documento)),
  tokensCatOnly: new Set(normalizeTokens(row.categoria)),
}));

function overlapCount(setA, setB) {
  let n = 0;
  for (const t of setA) if (setB.has(t)) n++;
  return n;
}

// Restituisce il link più pertinente per un'etichetta di sezione/documento,
// oppure null se non c'è una corrispondenza sufficientemente sicura.
//
// Il nome del documento (più specifico) pesa più della categoria: due righe
// con lo stesso numero di parole in comune vengono distinte confrontando
// solo il nome del documento, altrimenti categorie "generiche" (es. parole
// come "stagione" o "guida pratica" ripetute in righe diverse) potrebbero
// far scegliere il documento sbagliato. La categoria interviene solo come
// conferma aggiuntiva quando il nome del documento da solo non basta (es.
// "Regolamento Safeguarding" → parola "regolamento" + categoria "SAFEGUARDING").
function findLink(sectionOrDocLabel) {
  if (!sectionOrDocLabel || INDEXED_ROWS.length === 0) return null;
  const queryTokens = new Set(normalizeTokens(sectionOrDocLabel));
  if (queryTokens.size === 0) return null;

  // Livello 1: corrispondenza forte sul solo nome del documento.
  let best = null;
  let bestDice = 0;
  for (const row of INDEXED_ROWS) {
    const docOverlap = overlapCount(row.tokensDocOnly, queryTokens);
    if (docOverlap < 2) continue;
    const dice = (2 * docOverlap) / (row.tokensDocOnly.size + queryTokens.size);
    if (dice > bestDice || (dice === bestDice && docOverlap > (best ? best._docOverlap : 0))) {
      bestDice = dice;
      best = { ...row, _docOverlap: docOverlap };
    }
  }
  if (best && bestDice >= 0.3) {
    return { link: best.link, matchedDocumento: best.documento, matchedCategoria: best.categoria };
  }

  // Livello 2: almeno una parola del documento E una parola della categoria
  // presenti nella query, con un totale di almeno 2 parole DISTINTE in
  // comune (altrimenti una stessa parola generica condivisa tra categoria e
  // documento, es. "regionale", farebbe scattare un match troppo debole).
  for (const row of INDEXED_ROWS) {
    const docOverlap = overlapCount(row.tokensDocOnly, queryTokens);
    const catOverlap = overlapCount(row.tokensCatOnly, queryTokens);
    if (docOverlap < 1 || catOverlap < 1) continue;
    const distinctMatched = new Set([
      ...[...row.tokensDocOnly].filter((t) => queryTokens.has(t)),
      ...[...row.tokensCatOnly].filter((t) => queryTokens.has(t)),
    ]);
    if (distinctMatched.size >= 2) {
      return { link: row.link, matchedDocumento: row.documento, matchedCategoria: row.categoria };
    }
  }

  // Livello 3: nome di documento composto da una sola parola molto
  // specifica (es. "STATUTO"): basta che quella parola compaia nella query.
  for (const row of INDEXED_ROWS) {
    if (row.tokensDocOnly.size !== 1) continue;
    const [word] = row.tokensDocOnly;
    if (word.length >= 5 && queryTokens.has(word)) {
      return { link: row.link, matchedDocumento: row.documento, matchedCategoria: row.categoria };
    }
  }

  return null;
}

module.exports = { findLink };
