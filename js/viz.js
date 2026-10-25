// viz.js — draws a tree of routes. Same look and features as the Python version's page.
/* global d3 */

const TARGET = "Philosophy";
const TOPIC_COLOURS = ["#4c78a8", "#54a24b", "#b279a2", "#d4a72c", "#72b7b2", "#9d755d", "#6b6ecf", "#e17c9a",
  "#17becf", "#bcbd22", "#8c564b", "#7f7f7f"];
const RING = 72;

export const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const wikiURL = t => "https://en.wikipedia.org/wiki/" + encodeURIComponent(t.replace(/ /g, "_"));

// ================================================================ routes → graph
/** Route counts that grow batch by batch. Adding a route and removing it are exact inverses, so the
 *  route still being crawled can be shown without re-reading the finished routes each time. */
function createBuilder() {
  return { ingested: [], visits: new Map(), startCount: new Map(), edges: new Map(), outs: new Map() };
}
function bump(map, key, by) {
  const v = (map.get(key) || 0) + by;
  if (v) map.set(key, v); else map.delete(key);
  return v;
}
function count(acc, routes, sign) {
  for (const r of routes) {
    const p = r.path;
    bump(acc.startCount, p[0], sign);
    for (const t of new Set(p)) bump(acc.visits, t, sign);
    const rescued = new Set(r.rescued || []);
    for (let i = 0; i < p.length - 1; i++) {
      const key = p[i] + "\t" + p[i + 1];
      let e = acc.edges.get(key);
      if (!e) { e = { source: p[i], target: p[i + 1], count: 0, rescued: 0 }; acc.edges.set(key, e); }
      e.count += sign; if (rescued.has(i)) e.rescued += sign;
      if (e.count === 0) acc.edges.delete(key);
      let m = acc.outs.get(p[i]);
      if (!m) { m = new Map(); acc.outs.set(p[i], m); }
      bump(m, p[i + 1], sign);
      if (!m.size) acc.outs.delete(p[i]);
    }
  }
}

/** The tree for a set of routes, from the counts in acc. routes is used only for the statistics. */
function graphFrom(acc, analysis, routes) {
  const { visits, startCount, edges, outs } = acc;
  const rev = new Map();
  for (const e of edges.values()) { if (!rev.has(e.target)) rev.set(e.target, []); rev.get(e.target).push(e.source); }
  const depth = new Map();
  if (visits.has(TARGET)) {
    depth.set(TARGET, 0);
    const q = [TARGET];
    while (q.length) {
      const c = q.shift();
      for (const pv of rev.get(c) || []) if (!depth.has(pv)) { depth.set(pv, depth.get(c) + 1); q.push(pv); }
    }
  }
  const argmax = m => m ? [...m.entries()].sort((x, y) => y[1] - x[1])[0][0] : null;
  const nodes = [...visits.keys()].sort((x, y) => visits.get(y) - visits.get(x) || (x < y ? -1 : 1)).map(t => ({
    title: t, visits: visits.get(t), starts: startCount.get(t) || 0,
    depth: depth.has(t) ? depth.get(t) : null,
    status: t === TARGET ? "root" : depth.has(t) ? "reaches" : "stranded",
    leaf: !rev.has(t), next: argmax(outs.get(t)), cluster: analysis.clusters?.[t] ?? -1,
  }));
  const links = [...edges.values()].map(e => ({
    source: e.source, target: e.target, count: e.count,
    sim: analysis.sims?.[e.source + "\t" + e.target] ?? 0, rescued: e.rescued > 0,
  })).sort((x, y) => x.count - y.count);
  const springs = (analysis.springs || []).filter(sp => visits.has(sp.source) && visits.has(sp.target)).map(sp => ({ ...sp }));

  const reached = routes.filter(r => r.outcome === "philosophy");
  const clicks = reached.map(r => r.path.length - 1).sort((x, y) => x - y);
  const stats = {
    runs: routes.length, articles: nodes.length, reached: reached.length,
    median: clicks.length ? clicks[Math.floor(clicks.length / 2)] : null,
    longest: clicks.length ? clicks[clicks.length - 1] : null,
    rescued: routes.reduce((n, r) => n + (r.rescued || []).length, 0),
    clicks,
  };
  return { nodes, links, springs, stats, routes };
}

/** Full build from a list of routes (used by replay, and whenever the slot can't be extended). */
function buildGraph(routesIn, analysis, upTo = Infinity) {
  const routes = routesIn.slice(0, upTo);
  const acc = createBuilder();
  count(acc, routes, +1);
  return graphFrom(acc, analysis, routes);
}

/** Incremental build for a tab: finished routes are counted once, and only new ones are added after that.
 *  A route still being crawled (outcome "walking") is added for this build only, then taken out again. */
function graphForSlot(slot, routes, analysis) {
  const s = slots.get(slot);
  const n = routes.length;
  const tail = n && routes[n - 1].outcome === "walking" ? routes[n - 1] : null;
  const body = tail ? routes.slice(0, n - 1) : routes;
  let acc = s.builder;
  const extendable = acc && body.length >= acc.ingested.length && acc.ingested.every((r, i) => r === body[i]);
  if (!extendable) {
    acc = createBuilder();
    count(acc, body, +1);
    acc.ingested = body.slice();
  } else if (body.length > acc.ingested.length) {
    const fresh = body.slice(acc.ingested.length);
    count(acc, fresh, +1);
    for (const r of fresh) acc.ingested.push(r);
  }
  s.builder = acc;
  if (!tail) return graphFrom(acc, analysis, routes);
  count(acc, [tail], +1);
  const g = graphFrom(acc, analysis, routes);
  count(acc, [tail], -1);
  return g;
}

// ================================================================ state
let cv = null, ctx2 = null, tip, zoom;
let transform = d3.zoomIdentity, dpr = 1, rings = [];   // rings: contour rings, drawn on the canvas
let qt = null, qtDirty = true, maxHitR = 0;             // quadtree over visible nodes, for pointer lookups
let dirty = false, pendingSnap = null, drag = null, suppressClick = false;
const hl = { on: false, nodes: new Set(), hops: new Set() };   // the route lit by a click
let nodes = [], links = [], springs = [];
let byTitle = new Map();
const slots = new Map();      // "mine" / "everyone" → { byTitle, autoFitDone, transform }
let slotKey = null;
let current = { routes: [], mode: "classic", analysis: {}, subtitle: "" };
let graph = null;
let maxDepth = 1, rScale = d3.scaleSqrt(), strokeW = d3.scaleSqrt(), strokeO = d3.scaleSqrt();
const radius = d => d.status === "root" ? Math.max(9, rScale(d.visits)) : rScale(d.visits);
// a stable 0..1 number for a title, so the same article always lands in the same place
const hash01 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };
// articles that never arrive sit just outside the "never arrives" ring, spread across a band beyond it
const ringOf = d => d.depth == null ? (maxDepth + 2) * RING * (1.04 + 0.16 * hash01(d.title)) : d.depth * RING;
let mix = 0.3, k = 1, topicsOn = false;
let hovered = null, pinned = null;
let autoFitDone = false, fitTimer = null;
function stopAutoFit() { autoFitDone = true; clearTimeout(fitTimer); fitTimer = null; }
let replaying = false, replayTimer = null;
let worker = null, gen = 0, lastAnalysis = null;


// ================================================================ public API
export function initViz() {
  cv = d3.select("#viz");
  ctx2 = cv.node().getContext("2d");
  tip = document.getElementById("tip");
  mix = +document.getElementById("mix").value;
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  // the force layout runs in js/sim-worker.js; positions come back in snapshots
  worker = new Worker("js/sim-worker.js");
  worker.onmessage = ({ data: m }) => {
    if (m.gen !== gen) return;      // a snapshot from a graph that has since changed
    if (m.type === "tick") applySnapshot(m.buf);
    else if (m.type === "end" && !autoFitDone) fitView(600);
  };
  window.addEventListener("resize", () => { if (!autoFitDone) fitView(300); });

  zoom = d3.zoom().scaleExtent([0.05, 12]).filter(zoomFilter).on("zoom", e => {
    transform = e.transform;
    requestDraw();
    if (slotKey) slots.get(slotKey).transform = transform;
  });
  cv.call(zoom).on("dblclick.zoom", null);
  cv.call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2, innerHeight / 2).scale(0.5));
  // While you're just watching, the view keeps the whole tree in frame as it grows.
  // The moment you start browsing (hover a dot, click, scroll, drag, search), it stops
  // moving on its own. F re-frames once.
  cv.node().addEventListener("wheel", stopAutoFit, true);
  document.getElementById("search").addEventListener("focus", stopAutoFit);
  wirePointer();
  requestAnimationFrame(frame);

  document.getElementById("mix").addEventListener("input", e => {
    mix = +e.target.value; applyMix(); worker.postMessage({ type: "alpha", value: 0.5 });
  });
  document.getElementById("topics").addEventListener("change", e => {
    topicsOn = e.target.checked; paintTopics(); renderLegend();
  });
  document.getElementById("replay").addEventListener("click", toggleReplay);
  document.getElementById("export").addEventListener("click", exportPNG);
  document.getElementById("search").addEventListener("change", e => {
    const q = e.target.value.trim().toLowerCase();
    const d = nodes.find(n => n.title.toLowerCase() === q);
    if (d) { e.target.blur(); focusOn(d); }
  });
  window.addEventListener("keydown", e => {
    if (e.key === "Escape") { document.activeElement.blur(); unpin(); return; }
    if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
    if (e.key === "f" || e.key === "F") fitView();
  });
  // read-only hooks for the browser tests
  window.__viz = { nodes: () => nodes, transform: () => transform, lit: () => hl.nodes.size };
  applyMix();
}

let titleSet = new Set();
function resetTitles() { titleSet = new Set(); document.getElementById("titles").innerHTML = ""; }

/** Show (or update) a tree. slot keeps each tab's layout separate. */
export function setData(slot, { routes, mode, analysis, subtitle }) {
  const switching = slot !== slotKey;
  if (switching) {
    stopReplay();
    if (slotKey) slots.get(slotKey).autoFitDone = autoFitDone;
    if (!slots.has(slot)) slots.set(slot, { byTitle: new Map(), autoFitDone: false, transform: null });
    const s = slots.get(slot);
    clearTimeout(fitTimer); fitTimer = null;
    slotKey = slot; byTitle = s.byTitle; autoFitDone = s.autoFitDone;
    pinned = null; hovered = null; clearHighlight();
    resetTitles();
    if (s.transform) cv.call(zoom.transform, s.transform);
    else cv.call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2, innerHeight / 2).scale(0.5));
  }
  current = { routes, mode, analysis: analysis || {}, subtitle };
  if (replaying) return;               // replay keeps going; it picks up the new data when done
  update(graphForSlot(slot, routes, current.analysis), switching || !graph);
}

/** Start a new tree in this slot (forget positions). */
export function resetSlot(slot) {
  slots.delete(slot);
  worker.postMessage({ type: "reset", slot });
  if (slot === slotKey) { slotKey = null; byTitle = new Map(); graph = null; autoFitDone = false; }
}

export const isReplaying = () => replaying;

// ================================================================ drawing
function applyMix() {
  // Philosophy is held at the centre at Tree rings; at Relevance it is placed by similarity like everything else
  const root = nodes.find(d => d.status === "root");
  if (root) { root.fx = mix < 0.5 ? 0 : null; root.fy = mix < 0.5 ? 0 : null; }
  worker.postMessage({ type: "mix", mix });   // the worker sets the force strengths for this mix
  requestDraw();   // contour rings are only drawn at Tree rings
}

function update(g, first) {
  graph = g;
  renderHeader();
  maxDepth = d3.max(g.nodes, d => d.depth ?? 0) || 1;

  const fresh = new Set();
  nodes = g.nodes.map(n => {
    let d = byTitle.get(n.title);
    if (!d) { d = { title: n.title }; byTitle.set(n.title, d); fresh.add(d); }
    Object.assign(d, n);
    return d;
  });
  // place new arrivals next to the article they point to (reverse order so anchors come first)
  for (const d of [...nodes].reverse()) {
    if (!fresh.has(d)) continue;
    const anchor = d.next && byTitle.get(d.next);
    if (mix > 0.5) {   // towards Relevance, clicks mean nothing: start anywhere in a disc
      const a = Math.random() * 2 * Math.PI, r = Math.sqrt(Math.random()) * (maxDepth + 2) * RING * 0.5;
      d.x = Math.cos(a) * r; d.y = Math.sin(a) * r;
    } else if (d.depth != null && anchor && anchor.x != null && anchor !== d) {
      d.x = anchor.x + (Math.random() - 0.5) * 30; d.y = anchor.y + (Math.random() - 0.5) * 30;
    } else {
      const a = Math.random() * 2 * Math.PI, r = ringOf(d) || 0.001;
      d.x = Math.cos(a) * r; d.y = Math.sin(a) * r;
    }
    if (d.status === "root") { d.fx = 0; d.fy = 0; d.x = 0; d.y = 0; }
  }
  links = g.links.map(l => ({ ...l, source: byTitle.get(l.source), target: byTitle.get(l.target) }));
  springs = g.springs;

  const maxCount = d3.max(links, d => d.count) || 1;
  const maxVisits = d3.max(nodes, d => d.visits) || 1;
  strokeW = d3.scaleSqrt().domain([1, Math.max(2, maxCount)]).range([0.5, 9]);
  strokeO = d3.scaleSqrt().domain([1, Math.max(2, maxCount)]).range([0.25, 0.9]);
  rScale = d3.scaleSqrt().domain([1, Math.max(2, maxVisits)]).range([2.2, 16]);

  // faint contour rings every 5 clicks from Philosophy
  rings = !nodes.length ? [] : d3.range(5, Math.ceil(maxDepth / 5) * 5 + 1, 5)
    .map(d => ({ d, r: d * RING, label: plural(d, "click") }));
  if (nodes.some(n => n.status === "stranded"))
    rings.push({ d: "x", r: (maxDepth + 2) * RING, label: "never arrives", stranded: true });

  // labels: the first 400 articles, and more as you zoom in (see drawScene)
  nodes.forEach((d, i) => { d.rank = i; });
  // new arrivals glow for 2.5 seconds
  for (const d of fresh) d.freshUntil = first ? 0 : performance.now() + 2500;
  if (!first && fresh.size) setTimeout(requestDraw, 2600);
  qtDirty = true;
  requestDraw();

  if (current.analysis !== lastAnalysis) {
    lastAnalysis = current.analysis;
    worker.postMessage({ type: "neighbours", nb: current.analysis?.neighbours || null });
  }
  gen++;
  worker.postMessage({
    type: "graph", slot: slotKey, gen, first: !!first, mix, R: (maxDepth + 2) * RING,
    nodes: nodes.map(d => ({ title: d.title, x: d.x, y: d.y, r: radius(d), ring: ringOf(d), depth: d.depth,
      cluster: d.cluster, status: d.status, fx: d.fx ?? null, fy: d.fy ?? null })),
    links: links.map(l => ({ source: l.source.title, target: l.target.title, sim: l.sim })),
    springs: springs.map(sp => ({ source: sp.source, target: sp.target, sim: sp.sim })),
  });

  const titlesEl = document.getElementById("titles");
  for (const d of fresh) {
    if (titleSet.has(d.title)) continue;
    titleSet.add(d.title);
    const opt = document.createElement("option"); opt.value = d.title; titlesEl.appendChild(opt);
  }
  if (pinned && !byTitle.has(pinned.title)) pinned = null;
  if (pinned) highlight(pinned);
  renderSide();
  renderLegend();
  applyHidden();
  scheduleFit(first);
}

function updateLabels() { requestDraw(); }

/** Positions from the worker: one x,y pair per article, in the order the graph was sent. */
function applySnapshot(buf) {
  pendingSnap = buf;   // applied on the next frame, so messages never draw
  dirty = true;
}

/** Frame the whole tree inside the space the panels leave free. */
function fitView(duration = 900) {
  if (!nodes.length) return;
  const narrow = innerWidth < 900;
  let left = 30, right = innerWidth - 30, top = 40, bottom = innerHeight - 40;
  if (narrow) {
    top = document.getElementById("head").getBoundingClientRect().bottom + 16;
    bottom = document.getElementById("controls").getBoundingClientRect().top - 16;
    left = 16; right = innerWidth - 16;
  } else {
    left = document.getElementById("head").getBoundingClientRect().right + 24;
    right = document.getElementById("side").getBoundingClientRect().left - 24;
  }
  if (bottom - top < 120) { top = 40; bottom = innerHeight - 40; }
  const [x0, x1] = d3.extent(nodes, d => d.x), [y0, y1] = d3.extent(nodes, d => d.y);
  const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1);
  const s = Math.max(0.05, Math.min(2.5, Math.min((right - left) / w, (bottom - top) / h)));
  const cx = (left + right) / 2, cy = (top + bottom) / 2;
  cv.transition().duration(duration).call(zoom.transform,
    d3.zoomIdentity.translate(cx, cy).scale(s).translate(-(x0 + x1) / 2, -(y0 + y1) / 2));
}
function scheduleFit(first) {
  if (autoFitDone || fitTimer) return;     // at most one pending re-frame, so a stream of routes can't starve it
  fitTimer = setTimeout(() => { fitTimer = null; if (!autoFitDone) fitView(); }, first ? 1500 : 1000);
}
// ================================================================ panels
function renderHeader() {
  const s = graph.stats;
  const rows = [["Routes", s.runs], ["Articles", s.articles],
    ["Reached Philosophy", s.runs ? Math.round(100 * s.reached / s.runs) + "%" : "–"],
    ["Median clicks", s.median ?? "–"], ["Longest route", s.longest ?? "–"]];
  if (current.mode === "smart") rows.push(["Rescued clicks", s.rescued]);
  const statsHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("");
  const statsEl = document.getElementById("stats");
  if (statsEl.dataset.html !== statsHTML) { statsEl.innerHTML = statsHTML; statsEl.dataset.html = statsHTML; }
  document.getElementById("subtitle").textContent = replaying ? `Replaying · ${plural(s.runs, "route")}` : current.subtitle;
}

let lastSide = null, lastLegend = null;
function renderSide() {
  const side = document.getElementById("side");
  document.body.classList.toggle("has-pin", !!pinned);
  const setSide = html => { if (html !== lastSide) { side.innerHTML = html; lastSide = html; wireSide(side); } };
  if (pinned) { setSide(pinnedHTML(pinned)); return; }
  const s = graph.stats;
  const busiest = graph.nodes.filter(n => n.status !== "root").slice(0, 8);
  const top = busiest[0]?.visits || 1;
  let html = `<div class="section"><h2>Busiest articles</h2>` + (busiest.length ? busiest.map(n => `
      <div class="row" data-t="${esc(n.title)}"><span>${esc(n.title)}</span><b>${n.visits}</b>
      <div class="bar"><i style="width:${(100 * n.visits / top).toFixed(1)}%"></i></div></div>`).join("")
      : `<div class="sub">Nothing yet.</div>`) + `</div>`;
  if (s.clicks.length) {
    const lo = s.clicks[0], hi = s.clicks[s.clicks.length - 1];
    const bins = d3.range(lo, hi + 1).map(c => s.clicks.filter(x => x === c).length);
    const peak = Math.max(...bins);
    html += `<div class="section"><h2>Clicks to Philosophy</h2>
      <div class="hist">${bins.map((b, i) => `<i title="${lo + i} clicks: ${plural(b, "route")}" style="height:${(100 * b / peak).toFixed(1)}%"></i>`).join("")}</div>
      <div class="hist-axis"><span>${lo}</span><span>${hi}</span></div></div>`;
  }
  html += `<div class="section sub" style="margin-bottom:0">Click a dot to pin its route · double-click to open it on Wikipedia.</div>`;
  setSide(html);
}

function pinnedHTML(d) {
  const where = d.status === "root" ? "The destination."
    : d.depth != null ? `${plural(d.depth, "click")} to Philosophy` : "Never reaches Philosophy";
  let html = `<button class="close" title="Unpin (Esc)">×</button>
    <div class="pin-title">${esc(d.title)}</div>
    <div class="sub">${where} · on ${plural(d.visits, "route")}</div>`;
  const route = routeFrom(d);
  if (route.length > 1)
    html += `<div class="section"><h2>Route from here</h2><div class="route">` +
      route.map(n => `<span class="step" data-t="${esc(n.title)}">${esc(n.title)}</span>`).join(" → ") + `</div></div>`;
  const starts = new Map();
  for (const r of graph.routes) if (r.path.includes(d.title) && r.path[0] !== d.title)
    starts.set(r.path[0], (starts.get(r.path[0]) || 0) + 1);
  const list = [...starts.entries()].sort((a, b) => b[1] - a[1]);
  if (list.length) {
    html += `<div class="section"><h2>Routes flowing through here start at</h2>` +
      list.slice(0, 12).map(([t, n]) => `<div class="row" data-t="${esc(t)}"><span>${esc(t)}</span><b>${n > 1 ? "×" + n : ""}</b></div>`).join("") +
      (list.length > 12 ? `<div class="sub" style="margin:6px 0 0">+ ${list.length - 12} more</div>` : "") + `</div>`;
  }
  const by = new Map();
  for (const r of graph.routes) if (r.author && r.path.includes(d.title)) by.set(r.author, (by.get(r.author) || 0) + 1);
  if (by.size)
    html += `<div class="section"><h2>Routes through here by</h2><div class="sub" style="margin:0">` +
      [...by].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c]) => esc(n) + (c > 1 ? ` ×${c}` : "")).join(" · ") + `</div></div>`;
  html += `<a class="wiki" target="_blank" rel="noopener" href="${wikiURL(d.title)}">Open on Wikipedia ↗</a>`;
  return html;
}

function wireSide(side) {
  side.querySelectorAll("[data-t]").forEach(el => el.onclick = () => focusOn(byTitle.get(el.dataset.t)));
  const c = side.querySelector(".close"); if (c) c.onclick = unpin;
}

/** Legend entries pick what is shown. With nothing picked, everything shows; picking some hides the rest. */
const picked = new Set();
const isHidden = key => picked.size > 0 && !picked.has(key);
const catOf = d => d.status === "stranded" ? "stranded" : (topicsOn && d.cluster >= 0 ? "topic:" + d.cluster : "reaches");
const hiddenNode = d => d.status !== "root" && isHidden(catOf(d));
function applyHidden() {
  qtDirty = true;
  requestDraw();
}
function toggleLegend(e) {
  const el = e.target.closest("[data-k]");
  if (!el) return;
  const k = el.dataset.k;
  picked.has(k) ? picked.delete(k) : picked.add(k);
  applyHidden();
  renderLegend();
}

function renderLegend() {
  const sw = (inner, w = 12) => `<span class="sw"><svg width="${w}" height="12">${inner}</svg></span>`;
  const keys = [];
  const item = (key, inner, text) => { keys.push(key); return `<div data-k="${key}" class="${isHidden(key) ? "off" : ""}">${inner}${text}</div>`; };
  let html = `<div>${sw('<circle cx="6" cy="6" r="5" fill="var(--accent)"/>')}Philosophy</div>`;
  const labels = current.analysis.clusterLabels || [];
  if (topicsOn && labels.length) {
    const present = new Set(nodes.map(n => n.cluster));
    labels.forEach((lab, i) => {
      if (present.has(i)) html += item("topic:" + i, sw(`<circle cx="6" cy="6" r="4.5" fill="${TOPIC_COLOURS[i % TOPIC_COLOURS.length]}"/>`), esc(lab));
    });
  } else {
    html += item("reaches", sw('<circle cx="6" cy="6" r="4" fill="var(--ink)"/>'), "Gets there");
  }
  html += item("stranded", sw('<circle cx="6" cy="6" r="4" fill="none" stroke="var(--stranded)" stroke-width="1.4"/>'), "Never arrives");
  const line = (stroke, dash = "") => sw(`<line x1="1" y1="6" x2="21" y2="6" stroke="${stroke}" stroke-width="3" stroke-linecap="round" ${dash}/>`, 22);
  html += `<div>${line("var(--ink)")}Thicker = more routes</div>`;
  if (graph.links.some(l => l.rescued)) html += item("rescued", line("var(--ink)", 'stroke-dasharray="4 4"'), "Rescued by smart rules");
  html += `<div class="hint">Scroll to zoom · F to re-frame · Esc to unpin</div>`;
  // forget picks for groups that no longer exist, so the map can't end up empty
  for (const k of [...picked]) if (!keys.includes(k)) picked.delete(k);
  if (html !== lastLegend) {
    lastLegend = html;
    for (const id of ["legend", "legendMobile"]) document.getElementById(id).innerHTML = html;
  }
  for (const id of ["legend", "legendMobile"]) document.getElementById(id).onclick = toggleLegend;
}

function paintTopics() { requestDraw(); }

// ================================================================ hover, pin, drag
function routeFrom(d) {
  const route = [d], seen = new Set([d.title]);
  let cur = d;
  while (true) {
    const nx = cur.next;
    if (!nx || !byTitle.has(nx)) break;
    if (seen.has(nx)) { route.push(byTitle.get(nx)); break; }   // close a loop
    cur = byTitle.get(nx); route.push(cur); seen.add(nx);
  }
  return route;
}

function highlight(d) {
  const route = routeFrom(d);
  hl.nodes = new Set(route.map(n => n.title));
  hl.hops = new Set();
  for (let i = 0; i < route.length - 1; i++) hl.hops.add(route[i].title + "\t" + route[i + 1].title);
  hl.on = true;
  requestDraw();
}
/** Hovering only shows the name; a path is highlighted when a node is clicked. */
function showHover(d) { hovered = d; showTip(d); }
function hideHover() { hovered = null; tip.style.opacity = 0; }
/** The visible node under the pointer (within about 14 screen pixels), found with a quadtree. */
function worldAt(clientX, clientY) {
  const r = cv.node().getBoundingClientRect();
  return transform.invert([clientX - r.left, clientY - r.top]);
}
function ensureTree() {
  if (!qtDirty) return qt;
  const visible = nodes.filter(d => d.x != null && !hiddenNode(d));
  maxHitR = d3.max(visible, d => radius(d)) || 0;
  qt = d3.quadtree().x(d => d.x).y(d => d.y).addAll(visible);
  qtDirty = false;
  return qt;
}
function nodeAt(clientX, clientY) {
  const [x, y] = worldAt(clientX, clientY);
  const slack = 14 / transform.k;
  const hit = ensureTree().find(x, y, maxHitR + slack);
  if (!hit) return null;
  return Math.hypot(hit.x - x, hit.y - y) < radius(hit) + slack ? hit : null;
}
function clearHighlight() {
  hl.on = false; hl.nodes = new Set(); hl.hops = new Set();
  requestDraw();
}
function showTip(d) {
  const where = d.status === "root" ? "The destination."
    : d.depth != null ? `${plural(d.depth, "click")} to Philosophy` : "Never reaches Philosophy";
  let html = `<div class="t">${esc(d.title)}</div><div class="m">${where} · on ${plural(d.visits, "route")}</div>`;
  let names = routeFrom(d).map(n => esc(n.title));
  if (names.length > 1) {
    if (names.length > 14) names = [...names.slice(0, 6), "…", ...names.slice(-6)];
    html += `<div class="r">${names.join(" → ")}</div>`;
  }
  tip.innerHTML = html; tip.style.opacity = 1;
}
function placeTip(x, y) {
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(x + 16, innerWidth - w - 12) + "px";
  tip.style.top = Math.min(y + 16, innerHeight - h - 12) + "px";
}
function pin(d) { pinned = d; highlight(d); renderSide(); }
function unpin() { pinned = null; clearHighlight(); renderSide(); }

function focusOn(d) {
  if (!d) return;
  stopAutoFit();
  const s = Math.max(k, 1.4);
  cv.transition().duration(700).call(zoom.transform,
    d3.zoomIdentity.translate(innerWidth / 2, innerHeight / 2).scale(s).translate(-d.x, -d.y));
  pin(d);
}

// ================================================================ replay
function stopReplay() {
  if (!replaying) return;
  replaying = false; clearTimeout(replayTimer);
  document.getElementById("replay").textContent = "▶ Replay";
}
function toggleReplay() {
  if (replaying) { stopReplay(); update(buildGraph(current.routes, current.analysis), false); return; }
  const total = current.routes.length;
  if (!total) return;
  replaying = true; document.getElementById("replay").textContent = "■ Stop";
  pinned = null;
  byTitle.clear(); resetTitles(); update(buildGraph(current.routes, current.analysis, 0), true);
  const step = Math.max(60, Math.min(400, 12000 / total));
  let n = 0;
  (function tick() {
    if (!replaying) return;
    n++;
    update(buildGraph(current.routes, current.analysis, n), false);
    if (n >= current.routes.length) { stopReplay(); renderHeader(); return; }
    replayTimer = setTimeout(tick, step);
  })();
}

// ================================================================ canvas drawing
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif';
function colours() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  return { bg: v("--bg"), ink: v("--ink"), muted: v("--muted"), accent: v("--accent"), stranded: v("--stranded") };
}
const topicColour = d => TOPIC_COLOURS[(d.cluster >= 0 ? d.cluster : 0) % TOPIC_COLOURS.length];
/** A link is drawn only when both ends are shown, and rescued links are shown only if their group is. */
const linkHidden = l => {
  if (typeof l.source !== "object" || typeof l.target !== "object") return true;
  return hiddenNode(l.source) || hiddenNode(l.target) || (isHidden("rescued") && !!l.rescued);
};

/** Anything this far (in graph units) outside the screen is still drawn, so edges and labels never pop in at the border. */
const CULL_PAD = 100;

/** Paint the whole tree into c. t is the view transform; s is device pixels per CSS pixel. */
function drawScene(c, t, s) {
  const css = colours(), k = t.k, now = performance.now(), dim = hl.on;
  c.setTransform(s * k, 0, 0, s * k, s * t.x, s * t.y);
  // visible world rectangle, padded: the screen corners mapped back into graph units
  const cw = c.canvas.width / s, ch = c.canvas.height / s;
  const x0 = -t.x / k - CULL_PAD, x1 = (cw - t.x) / k + CULL_PAD;
  const y0 = -t.y / k - CULL_PAD, y1 = (ch - t.y) / k + CULL_PAD;
  const inView = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  c.globalAlpha = 1;
  c.lineJoin = "round";

  // contour rings: circles, only at Tree rings
  if (mix < 0.005) {
    const fs = 10 / k;
    c.font = `500 ${fs}px ${FONT}`; c.textAlign = "center"; c.textBaseline = "alphabetic";
    for (const ring of rings) {
      c.beginPath(); c.arc(0, 0, ring.r, 0, 2 * Math.PI);
      c.globalAlpha = 0.1; c.strokeStyle = css.ink; c.lineWidth = 1 / k;
      c.setLineDash(ring.stranded ? [3, 5] : []); c.stroke(); c.setLineDash([]);
      c.globalAlpha = 0.55; c.lineWidth = 3 / k; c.strokeStyle = css.bg; c.fillStyle = css.muted;
      c.strokeText(ring.label, 0, -ring.r - 0.4 * fs); c.fillText(ring.label, 0, -ring.r - 0.4 * fs);
      c.strokeText(ring.label, 0, ring.r + 1.1 * fs); c.fillText(ring.label, 0, ring.r + 1.1 * fs);
    }
  }

  // route links, batched: one stroke per style instead of one per link
  const linkGroups = new Map();
  for (const l of links) {
    if (linkHidden(l)) continue;
    const ax = l.source.x, ay = l.source.y, bx = l.target.x, by = l.target.y;
    // drawn if an end is on screen, or the segment crosses the screen (both ends can be off it)
    if (!inView(ax, ay) && !inView(bx, by) &&
        !(Math.max(ax, bx) >= x0 && Math.min(ax, bx) <= x1 && Math.max(ay, by) >= y0 && Math.min(ay, by) <= y1)) continue;
    const hop = dim && hl.hops.has(l.source.title + "\t" + l.target.title);
    const w = strokeW(l.count), a = strokeO(l.count);
    const alpha = dim && !hop ? a * 0.05 : a;
    const colour = hop ? css.accent : css.ink;
    const key = colour + "|" + w.toFixed(2) + "|" + alpha.toFixed(3) + "|" + (l.rescued ? 1 : 0);
    let g = linkGroups.get(key);
    if (!g) { g = { colour, w, alpha, rescued: !!l.rescued, p: new Path2D() }; linkGroups.set(key, g); }
    g.p.moveTo(ax, ay); g.p.lineTo(bx, by);
  }
  c.lineCap = "round";
  for (const g of linkGroups.values()) {
    c.globalAlpha = g.alpha; c.strokeStyle = g.colour; c.lineWidth = g.w;
    c.setLineDash(g.rescued ? [g.w + 2, g.w + 3] : []);
    c.stroke(g.p);
  }
  c.setLineDash([]); c.lineCap = "butt";

  // articles, batched: one fill and one stroke per style instead of one per article
  const nodeGroups = new Map();
  for (const d of nodes) {
    if (d.x == null || hiddenNode(d) || !inView(d.x, d.y)) continue;
    const onHl = hl.nodes.has(d.title);
    let fill = d.status === "root" ? css.accent
      : d.status === "stranded" ? css.bg
      : (d.leaf && d.status === "reaches" ? css.muted : css.ink);
    let stroke = d.status === "root" ? null : d.status === "stranded" ? css.stranded : css.bg;
    let sw = d.status === "stranded" ? 1.2 : 1;
    if (topicsOn && d.cluster >= 0) {
      if (d.status === "reaches") fill = topicColour(d);
      else if (d.status === "stranded") stroke = topicColour(d);
    }
    if (d.freshUntil > now) { stroke = css.accent; sw = 2; }
    if (onHl) { stroke = css.accent; sw = 2; }
    const alpha = dim && !onHl ? 0.15 : 1;
    const key = fill + "|" + stroke + "|" + sw + "|" + alpha;
    let g = nodeGroups.get(key);
    if (!g) { g = { fill, stroke, sw, alpha, p: new Path2D() }; nodeGroups.set(key, g); }
    const r = radius(d);
    g.p.moveTo(d.x + r, d.y); g.p.arc(d.x, d.y, r, 0, 2 * Math.PI);
  }
  for (const g of nodeGroups.values()) {
    c.globalAlpha = g.alpha;
    c.fillStyle = g.fill; c.fill(g.p);
    if (g.stroke) { c.strokeStyle = g.stroke; c.lineWidth = g.sw; c.stroke(g.p); }
  }

  // labels: the first 400 articles, plus more as you zoom in; the root always shows
  c.textAlign = "left"; c.textBaseline = "alphabetic";
  for (const d of nodes) {
    if (d.x == null || hiddenNode(d) || d.rank >= 400 || !inView(d.x, d.y)) continue;
    if (!(d.status === "root" || d.rank < 14 * k * k)) continue;
    const fs = 11.5 / k, onHl = hl.nodes.has(d.title), root = d.status === "root";
    const x = d.x + radius(d) + 4 / k, y = d.y + 0.35 * fs;
    c.font = `${root ? 650 : 500} ${fs}px ${FONT}`;
    c.globalAlpha = dim && !onHl ? 0.1 : 1;
    c.lineWidth = 3 / k; c.strokeStyle = css.bg; c.strokeText(d.title, x, y);
    c.fillStyle = root ? css.accent : css.ink; c.fillText(d.title, x, y);
  }
  c.globalAlpha = 1;
}

/** Draw at most once per animation frame, however many events ask for it. */
function requestDraw() { dirty = true; }
/** The only place that draws: runs on the browser's frame clock and paints only when something changed. */
function frame() {
  requestAnimationFrame(frame);
  if (!dirty) return;
  dirty = false;
  draw();
}
function draw() {
  if (!ctx2) return;
  if (pendingSnap) {   // the newest positions from the worker, applied once per frame
    const buf = pendingSnap; pendingSnap = null;
    if (buf.length === nodes.length * 2) {
      for (let i = 0; i < nodes.length; i++) { nodes[i].x = buf[2 * i]; nodes[i].y = buf[2 * i + 1]; }
      qtDirty = true;
    }
  }
  const el = cv.node();
  ctx2.setTransform(1, 0, 0, 1, 0, 0);
  ctx2.clearRect(0, 0, el.width, el.height);
  drawScene(ctx2, transform, dpr);
}
function sizeCanvas() {
  dpr = window.devicePixelRatio || 1;
  const el = cv.node();
  el.width = Math.round(innerWidth * dpr);
  el.height = Math.round(innerHeight * dpr);
  requestDraw();
}

// ================================================================ pointer: drag, hover, click, zoom
const pointOf = e => (e.touches && e.touches.length ? [e.touches[0].clientX, e.touches[0].clientY] : [e.clientX, e.clientY]);
/** Zoom and pan ignore presses on a node, so the node can be dragged instead. */
function zoomFilter(e) {
  if (e.type === "wheel") return true;
  if (e.button) return false;
  const [x, y] = pointOf(e);
  if (x == null) return true;
  return !nodeAt(x, y);
}
function wirePointer() {
  const el = cv.node();
  el.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    stopAutoFit();
    suppressClick = false;
    const d = nodeAt(e.clientX, e.clientY);
    if (!d) return;
    drag = { d, pid: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    d.fx = d.x; d.fy = d.y;
    worker.postMessage({ type: "fix", title: d.title, x: d.fx, y: d.fy });
    worker.postMessage({ type: "target", value: 0.2 });
    hideHover();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* not supported: drag still works while the pointer stays over the canvas */ }
  });
  el.addEventListener("pointermove", e => {
    if (drag && e.pointerId === drag.pid) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) {
        const [x, y] = worldAt(e.clientX, e.clientY);
        drag.d.fx = x; drag.d.fy = y;
        worker.postMessage({ type: "fix", title: drag.d.title, x, y });
      }
      return;
    }
    if (e.buttons) return;   // panning
    const d = nodeAt(e.clientX, e.clientY);
    el.style.cursor = d ? "pointer" : "";
    if (d === hovered) { if (d) placeTip(e.clientX, e.clientY); return; }
    if (d) { stopAutoFit(); showHover(d); placeTip(e.clientX, e.clientY); }
    else hideHover();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.pid) return;
    const d = drag.d;
    if (drag.moved) suppressClick = true;   // a drag is not a click
    worker.postMessage({ type: "target", value: 0 });
    if (d.status !== "root") { d.fx = null; d.fy = null; worker.postMessage({ type: "fix", title: d.title, x: null, y: null }); }
    drag = null;
    try { el.releasePointerCapture(e.pointerId); } catch (err) { /* already released */ }
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
  el.addEventListener("pointerleave", () => { if (!drag) hideHover(); });
  el.addEventListener("click", e => {
    if (suppressClick) { suppressClick = false; return; }
    const d = nodeAt(e.clientX, e.clientY);
    if (d) pin(d); else if (pinned) unpin();   // a click on empty map clears the pin
  });
  el.addEventListener("dblclick", e => {
    const d = nodeAt(e.clientX, e.clientY);
    if (d) window.open(wikiURL(d.title), "_blank");
  });
}

// ================================================================ export
function exportPNG() {
  const W = innerWidth, H = innerHeight, S = 3;
  const out = document.createElement("canvas");
  out.width = W * S; out.height = H * S;
  const c = out.getContext("2d");
  c.fillStyle = colours().bg; c.fillRect(0, 0, out.width, out.height);
  drawScene(c, transform, S);
  const s = graph.stats;
  c.setTransform(S, 0, 0, S, 0, 0);
  c.font = `600 15px ${FONT}`; c.fillStyle = colours().ink; c.textAlign = "left"; c.textBaseline = "alphabetic";
  c.fillText(`All roads lead to Philosophy · ${current.subtitle} · ${plural(s.runs, "route")} · ${s.runs ? Math.round(100 * s.reached / s.runs) : 0}% reached`, 28, H - 28);
  out.toBlob(blob => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `philosophy-tree-${slotKey}.png`; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  });
}
