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
function buildGraph(routesIn, analysis, upTo = Infinity) {
  const routes = routesIn.slice(0, upTo);
  const visits = new Map(), startCount = new Map(), edges = new Map(), outs = new Map();
  for (const r of routes) {
    const p = r.path;
    startCount.set(p[0], (startCount.get(p[0]) || 0) + 1);
    for (const t of new Set(p)) visits.set(t, (visits.get(t) || 0) + 1);
    const rescued = new Set(r.rescued || []);
    for (let i = 0; i < p.length - 1; i++) {
      const key = p[i] + "\t" + p[i + 1];
      let e = edges.get(key);
      if (!e) { e = { source: p[i], target: p[i + 1], count: 0, rescued: 0 }; edges.set(key, e); }
      e.count++; if (rescued.has(i)) e.rescued++;
      if (!outs.has(p[i])) outs.set(p[i], new Map());
      const m = outs.get(p[i]); m.set(p[i + 1], (m.get(p[i + 1]) || 0) + 1);
    }
  }
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
  const argmax = m => m ? [...m.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;
  const nodes = [...visits.keys()].sort((a, b) => visits.get(b) - visits.get(a) || (a < b ? -1 : 1)).map(t => ({
    title: t, visits: visits.get(t), starts: startCount.get(t) || 0,
    depth: depth.has(t) ? depth.get(t) : null,
    status: t === TARGET ? "root" : depth.has(t) ? "reaches" : "stranded",
    leaf: !rev.has(t), next: argmax(outs.get(t)), cluster: analysis.clusters?.[t] ?? -1,
  }));
  const links = [...edges.values()].map(e => ({
    source: e.source, target: e.target, count: e.count,
    sim: analysis.sims?.[e.source + "\t" + e.target] ?? 0, rescued: e.rescued > 0,
  })).sort((a, b) => a.count - b.count);
  const springs = (analysis.springs || []).filter(s => visits.has(s.source) && visits.has(s.target)).map(s => ({ ...s }));

  const reached = routes.filter(r => r.outcome === "philosophy");
  const clicks = reached.map(r => r.path.length - 1).sort((a, b) => a - b);
  const stats = {
    runs: routes.length, articles: nodes.length, reached: reached.length,
    median: clicks.length ? clicks[Math.floor(clicks.length / 2)] : null,
    longest: clicks.length ? clicks[clicks.length - 1] : null,
    rescued: routes.reduce((n, r) => n + (r.rescued || []).length, 0),
    clicks,
  };
  return { nodes, links, springs, stats, routes };
}

// ================================================================ state
let cv = null, ctx2 = null, tip, sim, zoom;
let transform = d3.zoomIdentity, dpr = 1, rings = [];   // rings: contour rings, drawn on the canvas
let qt = null, qtDirty = true, maxHitR = 0;             // quadtree over visible nodes, for pointer lookups
let drawQueued = false, drag = null, suppressClick = false;
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
let tickN = 0;

// at Tree rings, only clicks decide position; at Relevance, only similarity does
const radialStrength = () => 0.5 * (1 - mix);
const relevanceWeight = () => 3 * mix;

// ================================================================ public API
export function initViz() {
  cv = d3.select("#viz");
  ctx2 = cv.node().getContext("2d");
  tip = document.getElementById("tip");
  mix = +document.getElementById("mix").value;
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  sim = d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d.title).distance(l => 24 + 70 * (1 - l.sim)).strength(0.9))
    .force("relevance", d3.forceLink().id(d => d.title).distance(l => 12 + 90 * (1 - l.sim)))
    .force("charge", d3.forceManyBody().strength(-70).distanceMax(500))
    .force("collide", d3.forceCollide(d => radius(d) + 1.5).iterations(2))
    .force("radial", d3.forceRadial(d => ringOf(d), 0, 0))
    .force("topic", topicForce)
    .force("neighbours", neighbourForce)
    .alphaDecay(0.012);
  sim.on("tick", () => {
    if (mix < 0.5) clampToRings();
    qtDirty = true;      // positions moved, so the pointer lookup tree is stale
    requestDraw();
  });
  sim.on("end.fit", () => { if (!autoFitDone) fitView(600); });
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

  document.getElementById("mix").addEventListener("input", e => {
    mix = +e.target.value; applyMix(); sim.alpha(0.5).restart();
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
    if (s.transform) cv.call(zoom.transform, s.transform);
    else cv.call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2, innerHeight / 2).scale(0.5));
  }
  current = { routes, mode, analysis: analysis || {}, subtitle };
  if (replaying) return;               // replay keeps going; it picks up the new data when done
  update(buildGraph(routes, current.analysis), switching || !graph);
}

/** Start a new tree in this slot (forget positions). */
export function resetSlot(slot) {
  slots.delete(slot);
  if (slot === slotKey) { slotKey = null; byTitle = new Map(); graph = null; autoFitDone = false; }
}

export const isReplaying = () => replaying;

// ================================================================ drawing
function applyMix() {
  // Philosophy is held at the centre at Tree rings; at Relevance it is placed by similarity like everything else
  const root = nodes.find(d => d.status === "root");
  if (root) { root.fx = mix < 0.5 ? 0 : null; root.fy = mix < 0.5 ? 0 : null; }
  sim.force("link").strength(0.9 * (1 - mix));   // route links only matter at Tree rings; at Relevance, topic similarity alone decides
  sim.force("radial").strength(radialStrength());
  sim.force("relevance").strength(l => relevanceWeight() * (0.04 + 0.4 * l.sim));
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
  links = g.links.map(l => ({ ...l }));
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

  sim.nodes(nodes);
  sim.force("link").links(links);
  sim.force("relevance").links(springs);
  sim.force("radial").radius(d => ringOf(d));
  sim.force("collide").radius(d => radius(d) + 1.5);
  applyMix();
  sim.alpha(first ? 1 : 0.35).restart();

  document.getElementById("titles").innerHTML = nodes.map(n => `<option value="${esc(n.title)}">`).join("");
  if (pinned && !byTitle.has(pinned.title)) pinned = null;
  if (pinned) highlight(pinned);
  renderSide();
  renderLegend();
  applyHidden();
  scheduleFit(first);
}

function updateLabels() { requestDraw(); }

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
  document.getElementById("stats").innerHTML = rows.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("");
  document.getElementById("subtitle").textContent = replaying ? `Replaying · ${plural(s.runs, "route")}` : current.subtitle;
}

function renderSide() {
  const side = document.getElementById("side");
  document.body.classList.toggle("has-pin", !!pinned);
  if (pinned) { side.innerHTML = pinnedHTML(pinned); wireSide(side); return; }
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
  side.innerHTML = html;
  wireSide(side);
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
  for (const id of ["legend", "legendMobile"]) { const el = document.getElementById(id); el.innerHTML = html; el.onclick = toggleLegend; }
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
  byTitle.clear(); update(buildGraph(current.routes, current.analysis, 0), true);
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

// ================================================================ rings that bend, clamp
/** At Relevance only: pull every article towards the middle of its own topic, so topics bunch together. */
function topicForce(alpha) {
  const w = 0.3 * mix * alpha;
  if (w <= 0) return;
  const sums = new Map();
  for (const d of nodes) {
    if (d.cluster == null || d.cluster < 0 || d.x == null) continue;
    const s = sums.get(d.cluster) || { x: 0, y: 0, n: 0 };
    s.x += d.x; s.y += d.y; s.n++; sums.set(d.cluster, s);
  }
  for (const d of nodes) {
    const s = sums.get(d.cluster);
    if (!s || s.n < 2 || d.fx != null) continue;
    d.vx += (s.x / s.n - d.x) * w; d.vy += (s.y / s.n - d.y) * w;
  }
}

/** At Relevance only: pull every article towards the similarity-weighted middle of its nearest
 *  neighbours, so close relatives sit together even when they are not direct springs. */
function neighbourForce(alpha) {
  const w = 0.4 * mix * alpha;
  const nb = current.analysis?.neighbours;
  if (w <= 0 || !nb) return;
  for (const d of nodes) {
    if (d.fx != null || d.x == null) continue;
    const list = nb[d.title];
    if (!list) continue;
    let sx = 0, sy = 0, sw = 0;
    for (const [t, s] of list) {
      const o = byTitle.get(t);
      if (!o || o === d || o.x == null) continue;
      sx += s * o.x; sy += s * o.y; sw += s;
    }
    if (sw <= 0) continue;
    // a pull only as strong as the matches behind it: weak matches barely move anything
    const pull = w * Math.min(1, sw / 0.8);
    d.vx += (sx / sw - d.x) * pull; d.vy += (sy / sw - d.y) * pull;
  }
}

/** At Tree rings, articles that never arrive sit strictly outside the dashed "never arrives"
 *  ring, and reached articles never cross it. */
function clampToRings() {
  const R = (maxDepth + 2) * RING;
  for (const d of nodes) {
    if (d.fx != null || d.x == null) continue;
    const r = Math.hypot(d.x, d.y);
    if (d.depth == null) {
      // never inside the dashed ring; no outer limit, so they can sit as far past it as they need
      const lo = R * 1.04;
      if (r < 1e-3) { const a = hash01(d.title) * 2 * Math.PI; d.x = Math.cos(a) * lo; d.y = Math.sin(a) * lo; continue; }
      if (r < lo) { const sc = lo / r; d.x *= sc; d.y *= sc; }
    } else if (r > R) { const sc = R / r; d.x *= sc; d.y *= sc; }
  }
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

/** Paint the whole tree into c. t is the view transform; s is device pixels per CSS pixel. */
function drawScene(c, t, s) {
  const css = colours(), k = t.k, now = performance.now(), dim = hl.on;
  c.setTransform(s * k, 0, 0, s * k, s * t.x, s * t.y);
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

  // route links
  c.lineCap = "round";
  for (const l of links) {
    if (linkHidden(l)) continue;
    const hop = dim && hl.hops.has(l.source.title + "\t" + l.target.title);
    const w = strokeW(l.count), a = strokeO(l.count);
    c.globalAlpha = dim && !hop ? a * 0.05 : a;
    c.strokeStyle = hop ? css.accent : css.ink;
    c.lineWidth = w;
    c.setLineDash(l.rescued ? [w + 2, w + 3] : []);
    c.beginPath(); c.moveTo(l.source.x, l.source.y); c.lineTo(l.target.x, l.target.y); c.stroke();
  }
  c.setLineDash([]); c.lineCap = "butt";

  // articles
  for (const d of nodes) {
    if (d.x == null || hiddenNode(d)) continue;
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
    c.globalAlpha = dim && !onHl ? 0.15 : 1;
    c.beginPath(); c.arc(d.x, d.y, radius(d), 0, 2 * Math.PI);
    c.fillStyle = fill; c.fill();
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = sw; c.stroke(); }
  }

  // labels: the first 400 articles, plus more as you zoom in; the root always shows
  c.textAlign = "left"; c.textBaseline = "alphabetic";
  for (const d of nodes) {
    if (d.x == null || hiddenNode(d) || d.rank >= 400) continue;
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
function requestDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(); });
}
function draw() {
  if (!ctx2) return;
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
    sim.alphaTarget(0.2).restart();
    hideHover();
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* not supported: drag still works while the pointer stays over the canvas */ }
  });
  el.addEventListener("pointermove", e => {
    if (drag && e.pointerId === drag.pid) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
      if (drag.moved) { const [x, y] = worldAt(e.clientX, e.clientY); drag.d.fx = x; drag.d.fy = y; }
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
    sim.alphaTarget(0);
    if (d.status !== "root") { d.fx = null; d.fy = null; }
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
