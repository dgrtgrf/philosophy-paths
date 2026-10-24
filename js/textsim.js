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
    .filter(w => !STOP.has(w) && !/^\d+$/.test(w));
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
  const vocab = new Map(), terms = [], shown = [];   // terms: stems; shown: a readable word for each
  const tfs = titles.map(t => {
    const counts = new Map();
    for (const raw of tokens(`${t}. ${t}. ${textOf(t) || ""}`)) {
      const w = stem(raw);
      let id = vocab.get(w);
      if (id === undefined) { id = terms.length; vocab.set(w, id); terms.push(w); shown.push(raw); }
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

  // topic groups: k-means, with the number of groups chosen by silhouette score (3 to 12).
  // With meaning vectors, groups follow meaning; otherwise word overlap. Labels are the words
  // most specific to each group, so they change as the articles change.
  let clusters = {}, clusterLabels = [];
  if (n >= 8) {
    const dense = !!vectors, dim = dense ? vectors[0].length : 0;
    const pts = dense ? vectors : docs;
    const dotP = dense
      ? (x, y) => { let v = 0; for (let k = 0; k < dim; k++) v += x[k] * y[k]; return v; }
      : dot;
    const zero = () => (dense ? new Float32Array(dim) : new Map());
    const copy = p => (dense ? Float32Array.from(p) : new Map(p));
    const addTo = (c, p, w) => {
      if (dense) { for (let k = 0; k < dim; k++) c[k] += w * p[k]; }
      else for (const [id, v] of p) c.set(id, (c.get(id) || 0) + w * v);
    };
    const scale = (c, f) => {
      if (dense) { for (let k = 0; k < dim; k++) c[k] *= f; }
      else for (const [id, v] of c) c.set(id, v * f);
    };

    function kmeans(K) {
      // steady start: the busiest article, then repeatedly the one least like any chosen centre
      const seeds = [0];
      const closest = pts.map(p => dotP(p, pts[0]));
      while (seeds.length < K) {
        let far = -1, farVal = Infinity;
        for (let i = 0; i < n; i++) if (!seeds.includes(i) && closest[i] < farVal) { farVal = closest[i]; far = i; }
        if (far < 0) break;
        seeds.push(far);
        pts.forEach((p, i) => { closest[i] = Math.max(closest[i], dotP(p, pts[far])); });
      }
      let centres = seeds.map(s => copy(pts[s]));
      const assign = new Int32Array(n);
      for (let iter = 0; iter < 12; iter++) {
        const norms = centres.map(c => Math.sqrt(dotP(c, c)) || 1);
        let changed = false;
        for (let i = 0; i < n; i++) {
          let bestC = 0, bestS = -Infinity;
          for (let c = 0; c < centres.length; c++) {
            const s = dotP(pts[i], centres[c]) / norms[c];
            if (s > bestS) { bestS = s; bestC = c; }
          }
          if (assign[i] !== bestC) { changed = true; assign[i] = bestC; }
        }
        const next = centres.map(zero), sizes = new Array(centres.length).fill(0);
        for (let i = 0; i < n; i++) { sizes[assign[i]]++; addTo(next[assign[i]], pts[i], 1); }
        next.forEach((c, k) => { if (sizes[k]) scale(c, 1 / sizes[k]); else next[k] = centres[k]; });
        centres = next;
        if (!changed && iter > 0) break;
      }
      return { assign, K: centres.length };
    }

    // average silhouette over a sample: how well each article fits its own group (-1 to 1)
    function silhouette(assign, K) {
      const step = Math.max(1, Math.floor(n / 150));
      let total = 0, count = 0;
      for (let p = 0; p < n; p += step) {
        const sum = new Float64Array(K), cnt = new Int32Array(K);
        for (let q = 0; q < n; q++) if (q !== p) { sum[assign[q]] += 1 - dotP(pts[p], pts[q]); cnt[assign[q]]++; }
        const c = assign[p];
        count++;
        if (cnt[c] === 0) continue;
        const a = sum[c] / cnt[c];
        let b = Infinity;
        for (let k = 0; k < K; k++) if (k !== c && cnt[k]) b = Math.min(b, sum[k] / cnt[k]);
        if (b !== Infinity) total += (b - a) / Math.max(a, b, 1e-9);
      }
      return count ? total / count : -1;
    }

    const Kmax = Math.min(12, Math.max(3, Math.floor(n / 5)));
    let best = null;
    for (let K = 3; K <= Kmax; K++) {
      const r = kmeans(K);
      const score = silhouette(r.assign, r.K);
      if (!best || score > best.score) best = { ...r, score };
    }

    // label each group with the one word most specific to it (frequent here, rare elsewhere)
    const K = best.K;
    const inGroup = Array.from({ length: K }, () => new Map());
    const groupTotal = new Float64Array(K);
    tfs.forEach((counts, i) => {
      const c = best.assign[i];
      for (const [id, cnt] of counts) { inGroup[c].set(id, (inGroup[c].get(id) || 0) + cnt); groupTotal[c] += cnt; }
    });
    const groupsWith = new Map();
    for (const m of inGroup) for (const id of m.keys()) groupsWith.set(id, (groupsWith.get(id) || 0) + 1);
    const used = new Set();
    clusterLabels = inGroup.map((m, c) => {
      const scored = [...m].map(([id, cnt]) => [id, (cnt / groupTotal[c]) * Math.log(1 + K / groupsWith.get(id))])
        .sort((x, y) => y[1] - x[1]);
      const words = [];
      for (const [id] of scored) {
        if (words.length === 1) break;
        if (!used.has(shown[id])) { words.push(shown[id]); used.add(shown[id]); }
      }
      return words.join(" · ") || "misc";
    });
    titles.forEach((t, i) => { clusters[t] = best.assign[i]; });
  }
  return { sims, springs, neighbours, clusters, clusterLabels };
}
