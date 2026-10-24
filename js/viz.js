// viz.js — draws a tree of routes. Same look and features as the Python version's page.
/* global d3 */

const TARGET = "Philosophy";
const TOPIC_COLOURS = ["#4c78a8", "#54a24b", "#b279a2", "#d4a72c", "#72b7b2", "#9d755d", "#6b6ecf", "#e17c9a"];
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
let svg, world, gRings, gLinks, gNodes, gLabels, tip, sim, zoom;
let nodes = [], links = [], springs = [];
let byTitle = new Map();
const slots = new Map();      // "mine" / "everyone" → { byTitle, autoFitDone, transform }
let slotKey = null;
let current = { routes: [], mode: "classic", analysis: {}, subtitle: "" };
let graph = null;
let linkSel, nodeSel, labelSel, ringSel;
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
const relevanceWeight = () => 2 * mix;

// ================================================================ public API
export function initViz() {
  svg = d3.select("#viz");
  world = svg.append("g");
  gRings = world.append("g");
  gLinks = world.append("g");
  gNodes = world.append("g");
  gLabels = world.append("g");
  tip = document.getElementById("tip");
  linkSel = gLinks.selectAll("line"); nodeSel = gNodes.selectAll("circle");
  labelSel = gLabels.selectAll("text"); ringSel = gRings.selectAll("g");
  mix = +document.getElementById("mix").value;

  sim = d3.forceSimulation()
    .force("link", d3.forceLink().id(d => d.title).distance(l => 24 + 70 * (1 - l.sim)).strength(0.9))
    .force("relevance", d3.forceLink().id(d => d.title).distance(l => 18 + 130 * (1 - l.sim)))
    .force("charge", d3.forceManyBody().strength(-70).distanceMax(500))
    .force("collide", d3.forceCollide(d => radius(d) + 1.5).iterations(2))
    .force("radial", d3.forceRadial(d => ringOf(d), 0, 0))
    .alphaDecay(0.012);
  sim.on("tick", () => {
    if (mix < 0.05) clampToRings();
    linkSel.attr("x1", d => d.source.x).attr("y1", d => d.source.y)
           .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nodeSel.attr("cx", d => d.x).attr("cy", d => d.y);
    labelSel.attr("x", d => d.x + radius(d) + 4 / k).attr("y", d => d.y);
  });
  sim.on("end.fit", () => { if (!autoFitDone) fitView(600); });
  window.addEventListener("resize", () => { if (!autoFitDone) fitView(300); });

  zoom = d3.zoom().scaleExtent([0.05, 12]).on("zoom", e => {
    world.attr("transform", e.transform);
    k = e.transform.k; updateLabels();
    if (slotKey) slots.get(slotKey).transform = e.transform;
  });
  svg.call(zoom).on("dblclick.zoom", null);
  svg.call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2, innerHeight / 2).scale(0.5));
  // While you're just watching, the view keeps the whole tree in frame as it grows.
  // The moment you start browsing (hover a dot, click, scroll, drag, search), it stops
  // moving on its own. F re-frames once.
  svg.node().addEventListener("pointerdown", stopAutoFit, true);
  svg.node().addEventListener("wheel", stopAutoFit, true);
  document.getElementById("search").addEventListener("focus", stopAutoFit);
  svg.on("click", e => { if (e.target === svg.node() && pinned) unpin(); });

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
    pinned = null; hovered = null;
    if (s.transform) svg.call(zoom.transform, s.transform);
    else svg.call(zoom.transform, d3.zoomIdentity.translate(innerWidth / 2, innerHeight / 2).scale(0.5));
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
  sim.force("radial").strength(radialStrength());
  sim.force("relevance").strength(l => relevanceWeight() * (0.04 + 0.4 * l.sim));
  gRings.style("display", mix < 0.005 ? null : "none");  // rings only show at Tree rings
  drawRings();
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
  const ringData = !nodes.length ? [] : d3.range(5, Math.ceil(maxDepth / 5) * 5 + 1, 5)
    .map(d => ({ d, r: d * RING, label: plural(d, "click") }));
  if (nodes.some(n => n.status === "stranded"))
    ringData.push({ d: "x", r: (maxDepth + 2) * RING, label: "never arrives", stranded: true });
  ringSel = gRings.selectAll("g").data(ringData, d => d.d).join(enter => {
    const gg = enter.append("g");
    gg.append("path");
    gg.append("text").attr("class", "ring-label top").attr("dy", "-0.4em");
    gg.append("text").attr("class", "ring-label bottom").attr("dy", "1.1em");
    return gg;
  });
  ringSel.select("path").attr("class", d => "ring" + (d.stranded ? " stranded" : ""));
  ringSel.select("text.top").attr("x", 0).attr("y", d => -d.r).text(d => d.label);
  ringSel.select("text.bottom").attr("x", 0).attr("y", d => d.r).text(d => d.label);

  linkSel = gLinks.selectAll("line")
    .data(links, d => (d.source.title ?? d.source) + "\t" + (d.target.title ?? d.target))
    .join("line").attr("class", "link")
    .attr("stroke-width", d => strokeW(d.count))
    .attr("stroke-opacity", d => strokeO(d.count))
    .attr("stroke-dasharray", d => d.rescued ? `${strokeW(d.count) + 2} ${strokeW(d.count) + 3}` : null);
  linkSel.order();

  nodeSel = gNodes.selectAll("circle").data(nodes, d => d.title)
    .join(enter => enter.append("circle").call(bindNode))
    .attr("class", d => `node ${d.status}${d.leaf && d.status === "reaches" ? " leaf" : ""}${fresh.has(d) && !first ? " fresh" : ""}`)
    .attr("r", radius);
  if (!first && fresh.size) setTimeout(() => nodeSel.classed("fresh", false), 2500);
  paintTopics();

  const labelled = nodes.slice(0, 400);
  labelled.forEach((d, i) => d.rank = i);
  labelSel = gLabels.selectAll("text").data(labelled, d => d.title)
    .join("text")
    .attr("class", d => "label" + (d.status === "root" ? " root" : ""))
    .attr("dy", "0.35em").text(d => d.title);
  updateLabels();

  sim.nodes(nodes);
  sim.force("link").links(links);
  sim.force("relevance").links(springs);
  sim.force("radial").radius(d => ringOf(d));
  sim.force("collide").radius(d => radius(d) + 1.5);
  applyMix();
  sim.alpha(first ? 1 : 0.35).restart();

  document.getElementById("titles").innerHTML = nodes.map(n => `<option value="${esc(n.title)}">`).join("");
  if (pinned && !byTitle.has(pinned.title)) pinned = null;
  if (pinned) highlight(pinned); else if (hovered) highlight(hovered);
  renderSide();
  renderLegend();
  scheduleFit(first);
}

function updateLabels() {
  labelSel.attr("font-size", 11.5 / k).attr("stroke-width", 3 / k)
    .style("display", d => (d.status === "root" || d.rank < 14 * k * k) ? null : "none");
  ringSel.selectAll("text").attr("font-size", 10 / k).attr("stroke-width", 3 / k);
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
  svg.transition().duration(duration).call(zoom.transform,
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

function renderLegend() {
  const sw = (inner, w = 12) => `<span class="sw"><svg width="${w}" height="12">${inner}</svg></span>`;
  let html = `<div>${sw('<circle cx="6" cy="6" r="5" fill="var(--accent)"/>')}Philosophy</div>`;
  const labels = current.analysis.clusterLabels || [];
  if (topicsOn && labels.length) {
    const present = new Set(nodes.map(n => n.cluster));
    labels.forEach((lab, i) => {
      if (present.has(i)) html += `<div>${sw(`<circle cx="6" cy="6" r="4.5" fill="${TOPIC_COLOURS[i % 8]}"/>`)}${esc(lab)}</div>`;
    });
  } else {
    html += `<div>${sw('<circle cx="6" cy="6" r="4" fill="var(--ink)"/>')}Gets there</div>`;
  }
  html += `<div>${sw('<circle cx="6" cy="6" r="4" fill="none" stroke="var(--stranded)" stroke-width="1.4"/>')}Never arrives</div>`;
  const line = (stroke, dash = "") => sw(`<line x1="1" y1="6" x2="21" y2="6" stroke="${stroke}" stroke-width="3" stroke-linecap="round" ${dash}/>`, 22);
  html += `<div>${line("var(--ink)")}Thicker = more routes</div>`;
  if (graph.links.some(l => l.rescued)) html += `<div>${line("var(--ink)", 'stroke-dasharray="4 4"')}Rescued by smart rules</div>`;
  html += `<div class="hint">Scroll to zoom · F to re-frame · Esc to unpin</div>`;
  document.getElementById("legend").innerHTML = html;
}

function paintTopics() {
  const col = d => TOPIC_COLOURS[(d.cluster >= 0 ? d.cluster : 0) % 8];
  nodeSel
    .style("fill", d => !topicsOn || d.cluster < 0 || d.status !== "reaches" ? null : col(d))
    .style("stroke", d => topicsOn && d.status === "stranded" && d.cluster >= 0 ? col(d) : null);
}

// ================================================================ hover, pin, drag
function bindNode(sel) {
  sel.call(d3.drag()
    .on("start", (e, d) => { if (!e.active) sim.alphaTarget(0.2).restart(); d.fx = d.x; d.fy = d.y; })
    .on("drag", (e, d) => { d.fx = e.x; d.fy = e.y; })
    .on("end", (e, d) => {
      if (!e.active) sim.alphaTarget(0);
      if (d.status !== "root") { d.fx = null; d.fy = null; }
    }))
    .on("mouseenter", (e, d) => { stopAutoFit(); hovered = d; if (!pinned) highlight(d); showTip(d); placeTip(e.clientX, e.clientY); })
    .on("mousemove", e => placeTip(e.clientX, e.clientY))
    .on("mouseleave", () => { hovered = null; tip.style.opacity = 0; if (!pinned) clearHighlight(); })
    .on("click", (e, d) => { if (e.defaultPrevented) return; e.stopPropagation(); pin(d); })
    .on("dblclick", (e, d) => { e.stopPropagation(); window.open(wikiURL(d.title), "_blank"); });
}

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
  const onRoute = new Set(route.map(n => n.title)), hops = new Set();
  for (let i = 0; i < route.length - 1; i++) hops.add(route[i].title + "\t" + route[i + 1].title);
  svg.classed("dim", true);
  nodeSel.classed("hl", n => onRoute.has(n.title));
  labelSel.classed("hl", n => onRoute.has(n.title));
  linkSel.classed("hl", l => hops.has(l.source.title + "\t" + l.target.title));
}
function clearHighlight() {
  svg.classed("dim", false);
  nodeSel.classed("hl", false); labelSel.classed("hl", false); linkSel.classed("hl", false);
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
function unpin() { pinned = null; clearHighlight(); if (hovered) highlight(hovered); renderSide(); }

function focusOn(d) {
  if (!d) return;
  stopAutoFit();
  const s = Math.max(k, 1.4);
  svg.transition().duration(700).call(zoom.transform,
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
const circlePath = r => `M${-r},0a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0Z`;

/** Contour rings are perfect circles, and are only shown at Tree rings. */
function drawRings() {
  if (!ringSel || ringSel.empty()) return;
  ringSel.each(function (d) {
    const g = d3.select(this);
    g.select("path").attr("d", circlePath(d.r));
    g.select("text.top").attr("y", -d.r);
    g.select("text.bottom").attr("y", d.r);
  });
}

/** At Tree rings, articles that never arrive sit strictly outside the dashed "never arrives"
 *  ring, and reached articles never cross it. */
function clampToRings() {
  const R = (maxDepth + 2) * RING;
  for (const d of nodes) {
    if (d.fx != null || d.x == null) continue;
    const r = Math.hypot(d.x, d.y);
    if (d.depth == null) {
      const lo = R * 1.04, hi = R * 1.2;
      if (r < 1e-3) { const a = hash01(d.title) * 2 * Math.PI; d.x = Math.cos(a) * lo; d.y = Math.sin(a) * lo; continue; }
      const t = Math.min(hi, Math.max(lo, r));
      if (t !== r) { const sc = t / r; d.x *= sc; d.y *= sc; }
    } else if (r > R) { const sc = R / r; d.x *= sc; d.y *= sc; }
  }
}

// ================================================================ export
function exportPNG() {
  const src = svg.node(), W = innerWidth, H = innerHeight, S = 3;
  const clone = src.cloneNode(true);
  const a = src.querySelectorAll("*"), b = clone.querySelectorAll("*");
  const props = ["fill", "stroke", "stroke-width", "stroke-opacity", "fill-opacity", "opacity", "stroke-dasharray",
    "stroke-linecap", "stroke-linejoin", "paint-order", "font-size", "font-weight", "font-family", "display", "text-anchor"];
  a.forEach((el, i) => { const cs = getComputedStyle(el); props.forEach(p => b[i].style.setProperty(p, cs.getPropertyValue(p))); });
  const css = getComputedStyle(document.documentElement);
  const ns = "http://www.w3.org/2000/svg";
  clone.setAttribute("xmlns", ns);
  clone.setAttribute("width", W * S); clone.setAttribute("height", H * S);
  clone.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", W); bg.setAttribute("height", H); bg.setAttribute("fill", css.getPropertyValue("--bg").trim());
  clone.insertBefore(bg, clone.firstChild);
  const s = graph.stats;
  const cap = document.createElementNS(ns, "text");
  cap.setAttribute("x", 28); cap.setAttribute("y", H - 28);
  cap.setAttribute("style", `font: 600 15px -apple-system, system-ui, sans-serif; fill: ${css.getPropertyValue("--ink").trim()}`);
  cap.textContent = `All roads lead to Philosophy · ${current.subtitle} · ${plural(s.runs, "route")} · ${s.runs ? Math.round(100 * s.reached / s.runs) : 0}% reached`;
  clone.appendChild(cap);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = W * S; c.height = H * S;
    c.getContext("2d").drawImage(img, 0, 0);
    c.toBlob(blob => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `philosophy-tree-${slotKey}.png`; link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    });
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(clone));
}
