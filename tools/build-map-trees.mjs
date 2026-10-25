// build-map-trees.mjs — the Trees page, built from the shared node map (Classic routes).
//
// Philosophy tree: every article that reaches Philosophy in the map. An article's parent is the article
// it most often goes to next, among those one step closer to Philosophy, so it is a true tree.
//
// Never-arrive trees: every other article ends up in exactly one of two kinds of tree:
//   - a loop: articles that go round in a circle. The tree is rooted at the broadest article in the loop
//     (the one that the most articles lead into).
//   - a dead end: articles whose most-used next article leads to an article with no next article in the map.
//     The tree is rooted at that dead-end article.
// Run:  REPO=<repo> node build-map-trees.mjs <repo>/data/trees.json
import fs from "node:fs";
import path from "node:path";

const repo = process.env.REPO || "/home/claude/philosophy-site";
const { SUPABASE_URL, SUPABASE_ANON_KEY } = await import(path.join(repo, "js/config.js"));
const TARGET = "Philosophy", MODE = "classic", PAGE = 1000;

async function fetchRoutes() {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const url = `${SUPABASE_URL}/rest/v1/routes?select=id,path,outcome&mode=eq.${MODE}&order=id.asc`;
    const res = await fetch(url, { headers: { apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY, Range: `${from}-${from + PAGE - 1}` } });
    if (!res.ok) throw new Error("Supabase HTTP " + res.status);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

const routes = await fetchRoutes();
const visits = new Map(), out = new Map(), rev = new Map();
for (const r of routes) {
  const p = r.path;
  for (const t of p) visits.set(t, (visits.get(t) || 0) + 1);
  for (let i = 0; i < p.length - 1; i++) {
    const a = p[i], b = p[i + 1];
    if (!out.has(a)) out.set(a, new Map());
    out.get(a).set(b, (out.get(a).get(b) || 0) + 1);
    if (!rev.has(b)) rev.set(b, new Set());
    rev.get(b).add(a);
  }
}
const titles = [...visits.keys()];

// distance to Philosophy, following the map's links backwards (the reach the map shows)
const depth = new Map([[TARGET, 0]]);
const queue = [TARGET];
for (let i = 0; i < queue.length; i++) {
  const c = queue[i];
  for (const prev of rev.get(c) || []) if (!depth.has(prev)) { depth.set(prev, depth.get(c) + 1); queue.push(prev); }
}

// the most-used next article, among those accepted by ok(); ties go alphabetically
const best = (u, ok) => {
  let bestV = null, bestN = -1;
  for (const [v, n] of out.get(u) || []) {
    if (!ok(v)) continue;
    if (n > bestN || (n === bestN && v < bestV)) { bestV = v; bestN = n; }
  }
  return bestV;
};

// Philosophy tree
const parent = new Map();
for (const u of titles) {
  if (u === TARGET || !depth.has(u)) continue;
  const p = best(u, v => depth.has(v) && depth.get(v) === depth.get(u) - 1);
  if (p) parent.set(u, p);
}

// never-arrive articles: their most-used next article (any article). Following it either loops or stops.
const stranded = titles.filter(t => !depth.has(t));
const next = new Map();
for (const u of stranded) { const v = best(u, () => true); if (v) next.set(u, v); }

// where each stranded article ends up: a loop (its id) or a dead end (the article it stops at)
const sinkOf = new Map();          // article → "loop:<n>" or "end:<title>"
const loops = [];
const state = new Map();           // 1 = on the walk now, 2 = done
for (const s of stranded) {
  if (state.has(s)) continue;
  const walk = [];
  let u = s;
  while (u && !state.has(u)) { state.set(u, 1); walk.push(u); u = next.get(u); }
  let sink;
  if (u && state.get(u) === 1) {         // came back onto this walk: a loop
    const members = walk.slice(walk.indexOf(u));
    loops.push(members);
    sink = `loop:${loops.length - 1}`;
    for (const m of members) sinkOf.set(m, sink);
  } else if (!u) {                       // stopped at a dead end
    sink = `end:${walk[walk.length - 1]}`;
  } else {                               // reached an earlier walk (already placed)
    sink = sinkOf.get(u);
  }
  for (const x of walk) { state.set(x, 2); if (!sinkOf.has(x)) sinkOf.set(x, sink); }
}

// members of each never-arrive tree, and its root
const treeMembers = new Map();
for (const s of stranded) {
  const k = sinkOf.get(s);
  if (!treeMembers.has(k)) treeMembers.set(k, []);
  treeMembers.get(k).push(s);
}
const catchment = new Map();       // how many articles pass through each article on their way out
for (const s of stranded) {
  let u = s; const seen = new Set();
  while (u && !seen.has(u)) { seen.add(u); catchment.set(u, (catchment.get(u) || 0) + 1); u = next.get(u); }
}
const byBroadest = (a, b) => (catchment.get(b) || 0) - (catchment.get(a) || 0) || (visits.get(b) || 0) - (visits.get(a) || 0) || (a < b ? -1 : 1);

function build(root, parentOf, members) {
  const kids = new Map();
  for (const m of members) {
    const p = parentOf.get(m);
    if (p == null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(m);
  }
  const make = t => ({ title: t, visits: visits.get(t) || 0, children: (kids.get(t) || []).sort((a, b) => visits.get(b) - visits.get(a) || (a < b ? -1 : 1)).map(make) });
  return make(root);
}
const count = n => 1 + n.children.reduce((a, c) => a + count(c), 0);

const neverTrees = [];
for (const [k, members] of treeMembers) {
  const root = k.startsWith("end:") ? k.slice(4) : members.slice().sort(byBroadest)[0];
  const parentOf = new Map();
  for (const m of members) if (m !== root) parentOf.set(m, next.get(m));
  neverTrees.push({ kind: k.startsWith("loop:") ? "loop" : "end", root, tree: build(root, parentOf, members), size: members.length });
}
neverTrees.sort((a, b) => b.size - a.size);
const loopTrees = neverTrees.filter(t => t.kind === "loop");
const endTrees = neverTrees.filter(t => t.kind === "end");

const philosophyRoot = build(TARGET, parent, titles.filter(t => depth.has(t)));
const main = loopTrees[0];
const others = [...loopTrees.slice(1), ...endTrees];
const out2 = {
  generated: new Date().toISOString().slice(0, 10),
  mode: MODE, routes: routes.length, articles: titles.length,
  trees: [
    { key: "philosophy", title: TARGET, role: "reaches", size: count(philosophyRoot) - 1, root: philosophyRoot },
    { key: "knowledge", title: main.root, role: "loop", size: count(main.tree) - 1, root: main.tree },
  ],
  otherLoops: others.map(t => ({ title: t.root, kind: t.kind, size: t.size - 1, root: t.tree })),
  neverArrive: { articles: stranded.length, loops: loopTrees.length, deadEnds: endTrees.length, inMainLoop: main.size, inOtherTrees: others.reduce((n, t) => n + t.size - 1, 0) },
};
const dest = process.argv[2] || path.join(repo, "data/trees.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out2));
console.log(JSON.stringify({ routes: routes.length, articles: titles.length, reach: out2.trees[0].size, mainRoot: out2.trees[1].title, mainSize: out2.trees[1].size, neverArrive: out2.neverArrive, check: out2.trees[0].size + out2.neverArrive.articles }, null, 1));
