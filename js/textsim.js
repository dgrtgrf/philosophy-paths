// textsim.js — how related articles are, and which topic each belongs to.
// TF-IDF over each article's intro (title counted twice), cosine similarity,
// each article's 3 nearest neighbours, and k-means topic groups.

const STOP = new Set(`a about above across after afterwards again against all almost alone along already also although always am among
amongst amount an and another any anyhow anyone anything anyway anywhere are around as at back be became because become becomes
becoming been before beforehand behind being below beside besides between beyond both but by call can cannot could did do does
done down due during each eg either else elsewhere enough etc even ever every everyone everything everywhere except few first for
former formerly from front full further get give go had has have he hence her here hereafter hereby herein hereupon hers herself
him himself his how however i ie if in inc indeed interest into is it its itself just keep last latter latterly least less ltd made
many may me meanwhile might more moreover most mostly move much must my myself name namely neither never nevertheless next no nobody
none noone nor not nothing now nowhere of off often on once one only onto or other others otherwise our ours ourselves out over own
part per perhaps please put rather re same see seem seemed seeming seems serious several she should show side since so some somehow
someone something sometime sometimes somewhere still such take than that the their them themselves then thence there thereafter
thereby therefore therein thereupon these they thing third this those though three through throughout thru thus to together too top
toward towards two under until up upon us very via was we well were what whatever when whence whenever where whereafter whereas
whereby wherein whereupon wherever whether which while whither who whoever whole whom whose why will with within without would yet
you your yours yourself yourselves used known including also called`.split(/\s+/));

// Light suffix stripping, so "belief"/"beliefs" and "believe"/"believed" count as one word.
function stem(w) {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 4 && /(s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 4 && w.endsWith("e")) return w.slice(0, -1);
  return w;
}

function tokens(text) {
  return (text.toLowerCase().match(/[a-z][a-z0-9]+/g) || [])
    .filter(w => !STOP.has(w) && !/^\d+$/.test(w)).map(stem);
}

/**
 * titles: string[] (busiest first is best — it makes topic colours steadier)
 * textOf: title → intro text
 * edges:  [[a, b], …] route links (get a similarity each, and are skipped as springs)
 * vectors: optional, title index → unit-length meaning vector (Float32Array). When given,
 *          similarity is a 50/50 blend of word overlap and meaning. Null = word overlap only.
 * → { sims: {"a\tb": s}, springs: [{source, target, sim}], clusters: {title: id}, clusterLabels: [] }
 */
export function analyse(titles, textOf, edges, k = 3, vectors = null) {
  const n = titles.length;
  const empty = { sims: {}, springs: [], neighbours: {}, clusters: {}, clusterLabels: [] };
  const KN = 10;   // how many nearest neighbours each article keeps for layout
  if (!n) return empty;
  const index = new Map(titles.map((t, i) => [t, i]));

  // term frequencies
  const vocab = new Map(), terms = [];
  const tfs = titles.map(t => {
    const counts = new Map();
    for (const w of tokens(`${t}. ${t}. ${textOf(t) || ""}`)) {
      let id = vocab.get(w);
      if (id === undefined) { id = terms.length; vocab.set(w, id); terms.push(w); }
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  });
  const df = new Float64Array(terms.length);
  for (const c of tfs) for (const id of c.keys()) df[id]++;
  const idf = Array.from(df, d => Math.log((1 + n) / (1 + d)) + 1);

  // sublinear tf · idf, L2-normalised; docs[i] = Map(termId → weight)
  const docs = tfs.map(c => {
    const v = new Map();
    let norm = 0;
    for (const [id, cnt] of c) { const w = (1 + Math.log(cnt)) * idf[id]; v.set(id, w); norm += w * w; }
    norm = Math.sqrt(norm) || 1;
    for (const [id, w] of v) v.set(id, w / norm);
    return v;
  });
  const dot = (a, b) => {
    if (a.size > b.size) [a, b] = [b, a];
    let s = 0;
    for (const [id, w] of a) { const o = b.get(id); if (o) s += w * o; }
    return s;
  };

  // how alike two articles are: words only, or words blended with meaning
  const cos = (i, j) => { const a = vectors[i], b = vectors[j]; let s = 0; for (let x = 0; x < a.length; x++) s += a[x] * b[x]; return s; };
  const similar = (i, j) => vectors ? 0.5 * dot(docs[i], docs[j]) + 0.5 * cos(i, j) : dot(docs[i], docs[j]);

  // similarity of every route link
  const sims = {};
  const edgeKeys = new Set();
  for (const [a, b] of edges) {
    const i = index.get(a), j = index.get(b);
    if (i === undefined || j === undefined) continue;
    sims[`${a}\t${b}`] = +similar(i, j).toFixed(4);
    edgeKeys.add(i < j ? `${i},${j}` : `${j},${i}`);
  }

  // each article's k most similar others, via an inverted index
  const postings = Array.from({ length: terms.length }, () => []);
  docs.forEach((v, i) => { for (const [id, w] of v) postings[id].push(i, w); });
  const tooCommon = Math.max(40, n * 0.05);   // very common words say little about relatedness
  const springs = [], seen = new Set();
  const neighbours = {};   // title → [[other title, similarity], …], wider than the springs
  // Weak matches are noise: with meaning vectors, unrelated text still scores about 0.1
  const floor = vectors ? 0.2 : 0.05, springMin = vectors ? 0.2 : 0.08;
  const acc = new Float64Array(n), touched = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    let best = [];
    if (vectors) {
      // meaning matters too, so compare with every other article (fine up to a few thousand)
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const s = similar(i, j);
        if (best.length < KN) { best.push([j, s]); best.sort((a, b) => b[1] - a[1]); }
        else if (s > best[KN - 1][1]) { best[KN - 1] = [j, s]; best.sort((a, b) => b[1] - a[1]); }
      }
    } else {
      let nt = 0;
      for (const [id, w] of docs[i]) {
        const p = postings[id];
        if (p.length / 2 > tooCommon) continue;
        for (let x = 0; x < p.length; x += 2) {
          const j = p[x];
          if (j === i) continue;
          if (acc[j] === 0) touched[nt++] = j;
          acc[j] += w * p[x + 1];
        }
      }
      // top k without sorting everything
      for (let x = 0; x < nt; x++) {
        const j = touched[x], s = acc[j];
        acc[j] = 0;
        if (best.length < KN) { best.push([j, s]); best.sort((a, b) => b[1] - a[1]); }
        else if (s > best[KN - 1][1]) { best[KN - 1] = [j, s]; best.sort((a, b) => b[1] - a[1]); }
      }
    }
    neighbours[titles[i]] = best.filter(([, s]) => s >= floor).map(([j, s]) => [titles[j], +s.toFixed(4)]);
    for (const [j, s] of best.slice(0, 3)) {
      const key = i < j ? `${i},${j}` : `${j},${i}`;
      if (s >= springMin && !seen.has(key) && !edgeKeys.has(key)) {
        seen.add(key);
        springs.push({ source: titles[i], target: titles[j], sim: +s.toFixed(4) });
      }
    }
  }

  // topic groups (k-means on the same vectors)
  let clusters = {}, clusterLabels = [];
  if (n >= 8) {
    const K = Math.min(8, Math.max(3, Math.round(Math.sqrt(n / 6))));
    // steady start: the busiest article, then repeatedly the one least like any chosen centre
    const seeds = [0];
    const closest = docs.map(d => dot(d, docs[0]));
    while (seeds.length < K) {
      let far = -1, farVal = Infinity;
      for (let i = 0; i < n; i++) if (!seeds.includes(i) && closest[i] < farVal) { farVal = closest[i]; far = i; }
      if (far < 0) break;
      seeds.push(far);
      docs.forEach((d, i) => { closest[i] = Math.max(closest[i], dot(d, docs[far])); });
    }
    let centres = seeds.map(s => new Map(docs[s]));
    let assign = new Int32Array(n);
    for (let iter = 0; iter < 10; iter++) {
      const norms = centres.map(c => { let s = 0; for (const w of c.values()) s += w * w; return Math.sqrt(s) || 1; });
      let changed = false;
      for (let i = 0; i < n; i++) {
        let bestC = 0, bestS = -1;
        for (let c = 0; c < centres.length; c++) {
          const s = dot(docs[i], centres[c]) / norms[c];
          if (s > bestS) { bestS = s; bestC = c; }
        }
        if (assign[i] !== bestC || iter === 0) { changed = changed || assign[i] !== bestC; assign[i] = bestC; }
      }
      const next = centres.map(() => new Map()), sizes = new Array(centres.length).fill(0);
      for (let i = 0; i < n; i++) {
        const c = assign[i]; sizes[c]++;
        for (const [id, w] of docs[i]) next[c].set(id, (next[c].get(id) || 0) + w);
      }
      next.forEach((m, c) => { if (sizes[c]) for (const [id, w] of m) m.set(id, w / sizes[c]); else next[c] = centres[c]; });
      centres = next;
      if (!changed && iter > 0) break;
    }
    titles.forEach((t, i) => { clusters[t] = assign[i]; });
    clusterLabels = centres.map(c => [...c].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([id]) => terms[id]).join(" · ") || "misc");
  }
  return { sims, springs, neighbours, clusters, clusterLabels };
}
