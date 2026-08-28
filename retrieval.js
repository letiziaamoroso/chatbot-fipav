// retrieval.js — ricerca delle parti di documentazione rilevanti per una domanda
// Approccio: la documentazione viene divisa in "pezzi" (chunk). Per ogni domanda,
// si calcola quali pezzi sono piu' pertinenti (algoritmo BM25, lo stesso principio
// usato dai motori di ricerca) e si passano al chatbot solo quelli, invece di tutta
// la documentazione. Cosi' non c'e' limite alla quantita' di documenti caricabili.

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
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenize(text) {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function chunkText(text, sourceName, chunkSize = 1400, overlap = 200) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length > chunkSize && current) {
      chunks.push(current.trim());
      current = current.slice(Math.max(0, current.length - overlap)) + "\n\n" + para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.map((text, i) => ({
    id: `${sourceName}#${i}`,
    source: sourceName,
    text,
    tokens: tokenize(text),
  }));
}

function buildIndex(documents) {
  let chunks = [];
  for (const doc of documents) {
    chunks = chunks.concat(chunkText(doc.content, doc.name));
  }

  const N = chunks.length;
  const df = new Map();
  for (const chunk of chunks) {
    const seen = new Set(chunk.tokens);
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }

  const avgLen = chunks.reduce((s, c) => s + c.tokens.length, 0) / (N || 1);

  return { chunks, df, N, avgLen };
}

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

  const bySource = {};
  for (const c of selected) {
    if (!bySource[c.source]) bySource[c.source] = [];
    bySource[c.source].push(c.text);
  }

  let text = "";
  const sources = Object.keys(bySource);
  for (const source of sources) {
    text += `\n\n===== DOCUMENTO: ${source} =====\n` + bySource[source].join("\n\n[...]\n\n");
  }

  return { text: text.trim(), sources };
}

module.exports = { buildIndex, search };
