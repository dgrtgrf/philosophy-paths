// The force layout, run off the main thread. It owns the positions and forces; the page sends
// graph updates and small commands (pin, drag, mix), and gets positions back as one Float32Array per tick.
// The forces here are the ones viz.js used to run itself, unchanged. RING must match viz.js.
importScripts("vendor/d3.min.js");

const RING = 72;

// per-tab stores: title → { x, y, vx, vy, fx, fy } that survive graph updates, so layouts keep their positions
const stores = new Map();
let store = new Map();
let slot = null, gen = 0;
let mix = 0.3, R = RING;
let active = [];          // nodes of the current graph, in the order the page sent them
let neighbours = null;    // title → [[title, similarity], …], from the page's analysis
let running = false;

const hash01 = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return ((h >>> 0) % 10000) / 10000; };

const sim = d3.forceSimulation()
  .force("link", d3.forceLink().id(d => d.title).distance(l => 24 + 70 * (1 - l.sim)).strength(0.9))
  .force("relevance", d3.forceLink().id(d => d.title).distance(l => 12 + 90 * (1 - l.sim)))
  .force("charge", d3.forceManyBody().strength(-70).distanceMax(500))
  .force("collide", d3.forceCollide(d => d.r + 1.5).iterations(2))
  .force("radial", d3.forceRadial(d => d.ring, 0, 0))
  .force("topic", topicForce)
  .force("neighbours", neighbourForce)
  .alphaDecay(0.012)
  .stop();

sim.on("tick", () => { if (mix < 0.5) clampToRings(); });

/** At Relevance only: pull every article towards the middle of its own topic, so topics bunch together. */
function topicForce(alpha) {
  const w = 0.3 * mix * alpha;
  if (w <= 0) return;
  const sums = new Map();
  for (const d of active) {
    if (d.cluster == null || d.cluster < 0 || d.x == null) continue;
    const s = sums.get(d.cluster) || { x: 0, y: 0, n: 0 };
    s.x += d.x; s.y += d.y; s.n++; sums.set(d.cluster, s);
  }
  for (const d of active) {
    const s = sums.get(d.cluster);
    if (!s || s.n < 2 || d.fx != null) continue;
    d.vx += (s.x / s.n - d.x) * w; d.vy += (s.y / s.n - d.y) * w;
  }
}

/** At Relevance only: pull every article towards the similarity-weighted middle of its nearest neighbours. */
function neighbourForce(alpha) {
  const w = 0.4 * mix * alpha;
  const nb = neighbours;
  if (w <= 0 || !nb) return;
  for (const d of active) {
    if (d.fx != null || d.x == null) continue;
    const list = nb[d.title];
    if (!list) continue;
    let sx = 0, sy = 0, sw = 0;
    for (const [t, s] of list) {
      const o = store.get(t);
      if (!o || o === d || o.x == null) continue;
      sx += s * o.x; sy += s * o.y; sw += s;
    }
    if (sw <= 0) continue;
    // a pull only as strong as the matches behind it: weak matches barely move anything
    const pull = w * Math.min(1, sw / 0.8);
    d.vx += (sx / sw - d.x) * pull; d.vy += (sy / sw - d.y) * pull;
  }
}

/** At Tree rings, articles that never arrive sit outside the dashed "never arrives" ring, and reached
 *  articles never cross it. */
function clampToRings() {
  for (const d of active) {
    if (d.fx != null || d.x == null) continue;
    const r = Math.hypot(d.x, d.y);
    if (d.depth == null) {
      const lo = R * 1.04;
      if (r < 1e-3) { const a = hash01(d.title) * 2 * Math.PI; d.x = Math.cos(a) * lo; d.y = Math.sin(a) * lo; continue; }
      if (r < lo) { const sc = lo / r; d.x *= sc; d.y *= sc; }
    } else if (r > R) { const sc = R / r; d.x *= sc; d.y *= sc; }
  }
}

function applyMix() {
  for (const d of active) if (d.status === "root") { d.fx = mix < 0.5 ? 0 : null; d.fy = mix < 0.5 ? 0 : null; }
  sim.force("link").strength(0.9 * (1 - mix));
  sim.force("radial").strength(0.5 * (1 - mix));
  sim.force("relevance").strength(l => 3 * mix * (0.04 + 0.4 * l.sim));
}

function setGraph(m) {
  if (slot !== m.slot) {
    if (!stores.has(m.slot)) stores.set(m.slot, new Map());
    store = stores.get(m.slot); slot = m.slot;
  }
  gen = m.gen;
  mix = m.mix; R = m.R;
  active = m.nodes.map(n => {
    let d = store.get(n.title);
    if (!d) {   // a new article starts where the page placed it
      d = { title: n.title, x: n.x, y: n.y, vx: 0, vy: 0 };
      store.set(n.title, d);
    }
    d.r = n.r; d.ring = n.ring; d.depth = n.depth; d.cluster = n.cluster; d.status = n.status;
    d.fx = n.fx; d.fy = n.fy;
    return d;
  });
  sim.nodes(active);
  sim.force("link").links(m.links.map(l => ({ ...l })));
  sim.force("relevance").links(m.springs.map(s => ({ ...s })));
  applyMix();
  sim.alpha(m.first ? 1 : 0.35);
  start();
}

function fix(m) {
  const d = store.get(m.title);
  if (d) { d.fx = m.x; d.fy = m.y; }
}

function start() {
  if (running) return;
  running = true;
  setTimeout(loop, 0);
}

let tickN = 0;
function loop() {
  sim.tick();
  tickN++;
  const ended = sim.alpha() < sim.alphaMin();
  // while the layout is moving, every second tick is sent (less paint pressure); the last one always goes
  if (ended || tickN % 2 === 0) {
    const buf = new Float32Array(active.length * 2);
    for (let i = 0; i < active.length; i++) { buf[2 * i] = active[i].x || 0; buf[2 * i + 1] = active[i].y || 0; }
    self.postMessage({ type: "tick", gen, buf }, [buf.buffer]);
  }
  if (ended) {
    running = false;
    self.postMessage({ type: "end", gen });
    return;
  }
  setTimeout(loop, 0);
}

self.onmessage = ({ data: m }) => {
  switch (m.type) {
    case "graph": setGraph(m); break;
    case "neighbours": neighbours = m.nb; break;
    case "mix": mix = m.mix; applyMix(); break;
    case "fix": fix(m); break;
    case "alpha": sim.alpha(m.value); start(); break;
    case "target": sim.alphaTarget(m.value); start(); break;
    case "reset": stores.delete(m.slot); if (slot === m.slot) { slot = null; store = new Map(); } break;
  }
};
