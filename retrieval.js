// retrieval.js — ricerca delle parti di documentazione rilevanti per una domanda
// Approccio: la documentazione viene divisa in "pezzi" (chunk). Per ogni domanda,
// si calcola quali pezzi sono piu' pertinenti (algoritmo BM25, lo stesso principio
// usato dai motori di ricerca) e si passano al chatbot solo quelli, invece di tutta
// la documentazione. Cosi' non c'e' limite alla quantita' di documenti caricabili.
//
// In piu': ogni documento caricato e' in realta' una raccolta di piu' PDF ufficiali
// uniti insieme (es. "Regolamento Affiliazione e Tesseramento 2024.pdf",
// "Statuto FIPAV - 2025.pdf", ecc.). Queste righe segnaposto vengono riconosciute
// automaticamente e usate come "sezione/capitolo" di provenienza, cosi' il chatbot
// puo' citare non solo il documento ma anche la sezione precisa da cui ha preso
// l'informazione.

const STOPWORDS = new Set([
  "il","lo","la","i","gli","le","un","uno","una","di","a","da","in","con","su","per",
  "tra","fra","e","o","che","chi","cui","non","si","come","dove","quando","perche",
  "questo","questa","questi","queste","quello","quella","quelli","quelle",
  "del","dello","della","dei","degli","delle","al","allo","alla","ai","agli","alle",
  "dal","dallo","dalla","dai","dagli","dalle","nel","nello","nella","nei","negli","nelle",
  "sul","sullo","sulla","sui","sugli","sulle","mi","ti","ci","vi","lui","lei","loro",
  "io","tu","noi","voi","sono","sei","siamo","siete","ha","hanno","ho","hai",
  "abbiamo","avete","ma","se","anche","piu","meno","molto","poco","tutto","tutti",
  "tutta","tutte","essere","questa","questo","suo","sua","suoi","sue","loro","essi",
]);

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // rimuove accenti per un confronto piu' robusto
}

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// Una riga come "3) Guida pratica_Allenatori_2627 (23.07.26).pdf" oppure
// "Statuto FIPAV - 2025 - definitivo.pdf" segna l'inizio di un nuovo documento
// PDF originale all'interno del file unito. La riconosciamo e la usiamo come
// etichetta di sezione/capitolo.
const SECTION_MARKER_RE = /^\s*(?:\d+\)\s*)?([^\n]{3,140}?)\.pdf\s*$/i;

function cleanSectionLabel(raw) {
  return raw
    .replace(/\s*\([^)]*\d{2}\.\d{2}\.\d{2}\)\s*$/, "") // rimuove date tipo (24.07.26)
    .replace(/\s+/g, " ")
    .trim();
}

// Divide un documento lungo in pezzi di dimensione gestibile, provando a
// spezzare sui paragrafi invece che a metà frase. Ogni pezzo porta con sé
// l'etichetta di sezione (il PDF originale di provenienza) attiva in quel punto.
function chunkText(text, sourceName, chunkSize = 2200, overlap = 400) {
  const paragraphs = text.split(/\n\s*\n/).filter((para) => para.trim());
  const chunks = [];
  let current = "";
  let currentSection = null;

  function flush() {
    if (current.trim()) {
      chunks.push({ text: current.trim(), section: currentSection });
    }
    current = "";
  }

  for (const para of paragraphs) {
    const trimmed = para.trim();
    const marker = trimmed.match(SECTION_MARKER_RE);
    if (marker) {
      // Nuovo documento/sezione: chiudo il pezzo corrente e apro una nuova sezione.
      flush();
      currentSection = cleanSectionLabel(marker[1]);
      continue; // la riga segnaposto non fa parte del testo utile
    }

    if ((current + "\n\n" + trimmed).length > chunkSize && current) {
      const overlapTail = current.slice(Math.max(0, current.length - overlap));
      chunks.push({ text: current.trim(), section: currentSection });
      current = overlapTail + "\n\n" + trimmed;
    } else {
      current = current ? current + "\n\n" + trimmed : trimmed;
    }
  }
  flush();

  return chunks.map((c, i) => ({
    id: `${sourceName}#${i}`,
    source: sourceName,
    section: c.section, // null = nessuna sotto-sezione riconosciuta, si cita solo il documento
    text: c.text,
    tokens: tokenize(c.text),
  }));
}

// Costruisce l'indice a partire da un elenco di { name, content }
function buildIndex(documents) {
  let chunks = [];
  for (const doc of documents) {
    chunks = chunks.concat(chunkText(doc.content, doc.name));
  }

  const N = chunks.length;
  const df = new Map(); // in quanti chunk compare ogni parola
  for (const chunk of chunks) {
    const seen = new Set(chunk.tokens);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }

  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / (N || 1);

  return { chunks, df, N, avgLen };
}

// Cerca i chunk più pertinenti a una domanda (algoritmo BM25) fino a un
// budget massimo di caratteri, per non superare i limiti del modello.
// Il testo restituito è organizzato per DOCUMENTO e SEZIONE, con intestazioni
// esplicite che il chatbot deve ricopiare quando cita le proprie fonti.
function search(index, query, maxChars = 90000, topK = 40) {
  const { chunks, df, N, avgLen } = index;
  if (N === 0) return { text: "", sources: [] };

  const qTokens = [...new Set(tokenize(query))];
  if (qTokens.length === 0) return { text: "", sources: [] };

  const k1 = 1.5;
  const b = 0.75;

  const scored = chunks.map((chunk) => {
    const tf = new Map();
    for (const t of chunk.tokens) tf.set(t, (tf.get(t) || 0) + 1);
    const len = chunk.tokens.length || 1;

    let score = 0;
    for (const t of qTokens) {
      const f = tf.get(t) || 0;
      if (f === 0) continue;
      const n = df.get(t) || 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len) / avgLen)));
    }
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const selected = [];
  let totalChars = 0;
  for (const { chunk, score } of scored) {
    if (score <= 0) break;
    if (selected.length >= topK) break;
    if (totalChars + chunk.text.length > maxChars) continue;
    selected.push(chunk);
    totalChars += chunk.text.length;
  }

  // Raggruppa per DOCUMENTO + SEZIONE, cosi' ogni gruppo ha un'unica intestazione
  // chiara da cui il chatbot puo' copiare la citazione.
  const groups = new Map(); // key "source||section" -> { source, section, texts: [] }
  for (const c of selected) {
    const key = `${c.source}||${c.section || ""}`;
    if (!groups.has(key)) groups.set(key, { source: c.source, section: c.section, texts: [] });
    groups.get(key).texts.push(c.text);
  }

  const sources = [];
  let text = "";
  for (const { source, section, texts } of groups.values()) {
    const sectionLabel = section ? section : "generale";
    sources.push(section ? `${source} — ${section}` : source);
    text += `\n\n===== DOCUMENTO: ${source} | SEZIONE: ${sectionLabel} =====\n` + texts.join("\n\n[...]\n\n");
  }

  return { text: text.trim(), sources };
}

module.exports = { buildIndex, search };
