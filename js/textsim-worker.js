// Runs the similarity maths off the main thread so the page stays smooth.
// If MEANING is on, also turns each intro into a meaning vector with a small
// sentence-embedding model (downloaded once, then cached by the browser).
import { analyse } from "./textsim.js";
import { MEANING, MEANING_MAX } from "./config.js";

const MODEL_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/dist/transformers.min.js";
let embedder = null, failed = false;

async function getEmbedder() {
  if (embedder || failed) return embedder;
  try {
    const { pipeline } = await import(MODEL_URL);
    embedder = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", { dtype: "q8" });
  } catch (err) {
    failed = true;   // no model (offline, blocked): word matching only
  }
  return embedder;
}

async function meaningVectors(titles, texts) {
  const model = await getEmbedder();
  if (!model) return null;
  const vectors = [];
  const BATCH = 16;
  for (let i = 0; i < titles.length; i += BATCH) {
    const chunk = titles.slice(i, i + BATCH).map(t => `${t}. ${texts[t] || ""}`);
    const out = await model(chunk, { pooling: "mean", normalize: true });
    const dim = out.dims[out.dims.length - 1];
    for (let b = 0; b < chunk.length; b++) vectors.push(out.data.slice(b * dim, (b + 1) * dim));
  }
  return vectors;
}

self.onmessage = async e => {
  const { id, titles, texts, edges } = e.data;
  let vectors = null;
  if (MEANING && titles.length <= MEANING_MAX) {
    try { vectors = await meaningVectors(titles, texts); } catch (err) { vectors = null; }
  }
  const result = analyse(titles, t => texts[t] || "", edges, 3, vectors);
  self.postMessage({ id, result, meaning: !!vectors });
};
