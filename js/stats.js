// stats.js — "Today": a route of the day, and charts about everyone's shared routes.
/* global d3 */

const TARGET = "Philosophy";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const wikiURL = t => "https://en.wikipedia.org/wiki/" + encodeURIComponent(t.replace(/ /g, "_"));
const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "–";
const pctNum = p => Math.round(100 * p);
/** Wilson score interval for a proportion k/n at 95% confidence, as [low, high] in 0–1. */
function wilson(k, n) {
  if (!n) return [0, 1];
  const z = 1.96, p = k / n, d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
/** Quantile of an ascending-sorted array (nearest rank). */
const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] : null;
const MODE = m => m === "smart" ? "Smart rules" : "Classic rules";
const width = sel => Math.max(280, Math.round(sel.node().getBoundingClientRect().width) || 480);
const trim = (s, n) => s.length > n ? s.slice(0, n - 1) + "…" : s;
const OUTCOME_COLOURS = { philosophy: "#e4572e", loop: "#8f8f96", dead_end: "#4c78a8", too_long: "#d4a72c", missing: "#72b7b2" };

/** The first sentence of an article's introduction, for explaining each step. */
function firstSentence(text) {
  const s = ((text || "").trim().split(/(?<=[.!?])\s/)[0] || "").trim();
  return s.length > 200 ? s.slice(0, 197).trimEnd() + "…" : s;
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/** Score each route that reaches Philosophy by how much there is to learn from it,
 *  then pick one of the best ten. The pick changes from day to day. */
export function pickRouteOfDay(routes, clusterOf, date) {
  const visits = new Map();
  for (const r of routes) for (const t of new Set(r.path)) visits.set(t, (visits.get(t) || 0) + 1);
  const scored = routes
    .filter(r => r.outcome === "philosophy" && r.path.length >= 6)
    .map(r => {
      const topics = [...new Set(r.path.map(t => clusterOf.get(t)).filter(c => c != null && c >= 0))];
      const rare = r.path.filter(t => t !== TARGET && (visits.get(t) || 0) <= 2).length;
      const rescued = (r.rescued || []).length;
      const score = r.path.length + 3 * topics.length + 2 * rescued + (rare ? 4 : 0);
      return { route: r, score, topics, rare, rescued };
    })
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return null;
  const pool = scored.slice(0, 10);
  return pool[hash(date) % pool.length];
}

// ─────────────────────────────────────────────── charts (d3, drawn into SVG) ──
function hbar(sel, items, format = d => d.value) {
  sel.html("");
  if (!items.length) { sel.append("div").attr("class", "sub").text("Nothing yet."); return; }
  const W = width(sel), L = Math.min(170, Math.round(W * 0.42)), RH = 24, H = items.length * RH + 6;
  const svg = sel.append("svg").attr("width", W).attr("height", H).attr("class", "chart");
  const x = d3.scaleLinear().domain([0, d3.max(items, d => d.value) || 1]).range([0, W - L - 70]);
  const g = svg.selectAll("g").data(items).join("g").attr("transform", (d, i) => `translate(0,${i * RH + 4})`);
  g.append("title").text(d => d.label);
  g.append("text").attr("class", "tick").attr("x", L - 8).attr("y", 13).attr("text-anchor", "end").text(d => trim(d.label, 24));
  g.append("rect").attr("class", "bar-fill").attr("x", L).attr("y", 3).attr("height", 15).attr("rx", 3)
    .attr("width", d => Math.max(2, x(d.value)));
  g.append("text").attr("class", "val").attr("x", d => L + x(d.value) + 6).attr("y", 14).text(d => format(d));
}

function histogram(sel, clicks) {
  sel.html("");
  if (!clicks.length) { sel.append("div").attr("class", "sub").text("No route has reached Philosophy yet."); return; }
  const lo = clicks[0], hi = clicks[clicks.length - 1];
  const data = d3.range(lo, hi + 1).map(c => ({ c, n: clicks.filter(x => x === c).length }));
  const W = width(sel), H = 200, m = { l: 34, r: 8, t: 10, b: 28 };
  const svg = sel.append("svg").attr("width", W).attr("height", H).attr("class", "chart");
  const x = d3.scaleBand().domain(data.map(d => d.c)).range([m.l, W - m.r]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(data, d => d.n)]).nice().range([H - m.b, m.t]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).tickValues(data.map(d => d.c).filter(c => c % Math.ceil(data.length / 12) === 0 || c === lo))
      .tickSize(0).tickPadding(6)).call(a => a.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickSize(-(W - m.l - m.r)).tickFormat(d3.format("d")))
    .call(a => a.select(".domain").remove());
  svg.selectAll("rect.col").data(data).join("rect").attr("class", "bar-fill col")
    .attr("x", d => x(d.c)).attr("width", x.bandwidth()).attr("y", d => y(d.n)).attr("height", d => y(0) - y(d.n))
    .append("title").text(d => `${d.c} clicks: ${plural(d.n, "route")}`);
  svg.append("text").attr("class", "tick").attr("x", (m.l + W) / 2).attr("y", H - 2).attr("text-anchor", "middle").text("clicks to Philosophy");
}

function donut(sel, routes) {
  sel.html("");
  const counts = Object.entries({ philosophy: "Reached Philosophy", loop: "Loop back", dead_end: "Dead end",
    too_long: "Too long", missing: "Missing page" }).map(([k, label]) => ({
    key: k, label, value: routes.filter(r => r.outcome === k).length,
  })).filter(d => d.value);
  const total = routes.length;
  const wrap = sel.append("div").attr("class", "donut");
  const svg = wrap.append("svg").attr("viewBox", "0 0 200 200").attr("class", "chart pie");
  const arc = d3.arc().innerRadius(56).outerRadius(90);
  const pie = d3.pie().value(d => d.value).sort(null);
  svg.selectAll("path").data(pie(counts)).join("path").attr("d", arc).attr("transform", "translate(100,100)")
    .attr("fill", d => OUTCOME_COLOURS[d.data.key]).attr("stroke", "var(--bg)").attr("stroke-width", 2)
    .append("title").text(d => `${d.data.label}: ${plural(d.data.value, "route")}`);
  const reached = counts.find(d => d.key === "philosophy")?.value || 0;
  svg.append("text").attr("x", 100).attr("y", 104).attr("text-anchor", "middle").attr("class", "donut-big")
    .text(pct(reached, total));
  svg.append("text").attr("x", 100).attr("y", 122).attr("text-anchor", "middle").attr("class", "tick").text("reached");
  const legend = wrap.append("ul").attr("class", "legend");
  counts.forEach(d => {
    const li = legend.append("li");
    li.append("i").style("background", OUTCOME_COLOURS[d.key]);
    li.append("span").text(`${d.label}`);
    li.append("b").text(`${pct(d.value, total)}`);
  });
}

function reachLine(sel, routes) {
  sel.html("");
  if (routes.length < 2) { sel.append("div").attr("class", "sub").text("Needs a few more routes."); return; }
  let ok = 0;
  const step = Math.max(1, Math.ceil(routes.length / 400));
  const pts = [];
  routes.forEach((r, i) => {
    if (r.outcome === "philosophy") ok++;
    if ((i + 1) % step === 0 || i === routes.length - 1) {
      const [lo, hi] = wilson(ok, i + 1);
      pts.push({ i: i + 1, v: 100 * ok / (i + 1), lo: 100 * lo, hi: 100 * hi });
    }
  });
  const W = width(sel), H = 200, m = { l: 36, r: 12, t: 10, b: 28 };
  const svg = sel.append("svg").attr("width", W).attr("height", H).attr("class", "chart");
  const x = d3.scaleLinear().domain([1, routes.length]).range([m.l, W - m.r]);
  const y = d3.scaleLinear().domain([0, 100]).range([H - m.b, m.t]);
  svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
    .call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(6)).call(a => a.select(".domain").remove());
  svg.append("g").attr("class", "axis").attr("transform", `translate(${m.l},0)`)
    .call(d3.axisLeft(y).ticks(4).tickFormat(d => d + "%").tickSize(-(W - m.l - m.r)))
    .call(a => a.select(".domain").remove());
  const area = d3.area().x(d => x(d.i)).y0(y(0)).y1(d => y(d.v));
  const line = d3.line().x(d => x(d.i)).y(d => y(d.v));
  const band = d3.area().x(d => x(d.i)).y0(d => y(d.lo)).y1(d => y(d.hi));
  svg.append("path").datum(pts).attr("d", band).attr("fill", "var(--accent)").attr("fill-opacity", 0.12);
  svg.append("path").datum(pts).attr("class", "area").attr("d", area);
  svg.append("path").datum(pts).attr("class", "line").attr("d", line);
  svg.append("text").attr("class", "tick").attr("x", (m.l + W) / 2).attr("y", H - 2).attr("text-anchor", "middle")
    .text("routes, in order of sharing (n)");
}

// ─────────────────────────────────────────────── the page ──
function routeOfDayHTML(pick, texts, labels, mode, date) {
  const { route, topics, rare, rescued } = pick;
  const steps = route.path.map(t => {
    const s = firstSentence(texts.get(t));
    return `<li><a href="${wikiURL(t)}" target="_blank" rel="noopener">${esc(t)}</a>${s ? `<span class="why">${esc(s)}</span>` : ""}</li>`;
  }).join("");
  const facts = [
    topics.length >= 2 ? `Passes through ${topics.length} topics: ${topics.slice(0, 4).map(c => esc(labels[c] || "…")).join(", ")}` : null,
    rescued && mode === "smart" ? `${plural(rescued, "step")} that only smart rules could follow` : null,
    rare ? "Visits at least one article that very few routes touch" : null,
  ].filter(Boolean);
  return `<section class="card rotd">
    <details>
      <summary>
        <div class="kicker">Route of the day · ${esc(date)}</div>
        <h2 class="big">${esc(trim(route.start, 40))} → Philosophy</h2>
        <div class="sub">${plural(route.path.length - 1, "click")}${topics.length ? ` · ${topics.length} topics` : ""} · tap to read the route</div>
      </summary>
      <ol class="steps">${steps}</ol>
      ${facts.length ? `<ul class="facts">${facts.map(f => `<li>${f}</li>`).join("")}</ul>` : ""}
    </details>
  </section>`;
}

/** Draw the whole page into root. */
export function renderStats(root, o) {
  const msg = t => `<div class="sub">${esc(t)}</div>`;
  if (o.loading) { root.innerHTML = msg("Loading everyone's routes…"); return; }
  if (o.error) { root.innerHTML = msg(o.error); return; }
  const { routes, texts, clusterOf, labels, mode, date } = o;
  const cap = t => `<div class="sub caption">${esc(t)}</div>`;
  if (!routes.length) {
    root.innerHTML = `<h1>Today</h1>` + msg(`No shared routes yet for ${MODE(mode).toLowerCase()}. Once people share theirs, the stats appear here.`);
    return;
  }
  const n = routes.length;
  const reached = routes.filter(r => r.outcome === "philosophy");
  const count = out => routes.filter(r => r.outcome === out).length;
  const clicks = reached.map(r => r.path.length - 1).sort((a, b) => a - b);
  const [lo95, hi95] = wilson(reached.length, n);
  const pick = pickRouteOfDay(routes, clusterOf, date);

  root.innerHTML = `
    <h1>Today</h1>
    <div class="sub">Everyone's tree · ${MODE(mode)} · ${plural(n, "route")}</div>
    <div class="cards">
      ${pick ? routeOfDayHTML(pick, texts, labels, mode, date) : ""}
      <section class="card"><h2>Reach rate</h2><div class="big-number">${pct(reached.length, n)}</div>
        <div class="sub">n = ${n} · 95% CI ${pctNum(lo95)}–${pctNum(hi95)}% (Wilson)${clicks.length ? ` · path length median ${quantile(clicks, 0.5)}, IQR ${quantile(clicks, 0.25)}–${quantile(clicks, 0.75)}` : ""}</div></section>
    </div>
    <div class="cards">
      <section class="card"><h2>Distribution of path length</h2>${cap("Clicks from start to Philosophy, reaching routes only")}<div data-c="hist"></div></section>
      <section class="card"><h2>Terminal outcomes</h2>${cap("Share of routes by how they end")}<div data-c="donut"></div></section>
      <section class="card wide"><h2>Cumulative reach rate</h2>${cap("Reach rate with 95% Wilson interval, as routes accumulate")}<div data-c="line"></div></section>
      <section class="card"><h2>Penultimate articles</h2>${cap("Last article before Philosophy, reaching routes")}<div data-c="gate"></div></section>
      <section class="card"><h2>Terminal articles</h2>${cap("Final article of routes that do not reach Philosophy")}<div data-c="stuck"></div></section>
      <section class="card"><h2>Topic incidence</h2>${cap("Routes passing through at least one article in each topic")}<div data-c="topic"></div></section>
    </div>`;

  const c = name => d3.select(root).select(`[data-c=${name}]`);
  histogram(c("hist"), clicks);
  donut(c("donut"), routes);
  reachLine(d3.select(root).select("[data-c=line]"), routes);

  const top = (map, k = 8) => [...map].sort((a, b) => b[1] - a[1]).slice(0, k).map(([label, value]) => ({ label, value }));
  const gates = new Map();
  for (const r of reached) if (r.path.length >= 2) {
    const g = r.path[r.path.length - 2]; gates.set(g, (gates.get(g) || 0) + 1);
  }
  hbar(c("gate"), top(gates));
  const stuck = new Map();
  for (const r of routes) if (r.outcome !== "philosophy") {
    const g = r.path[r.path.length - 1]; stuck.set(g, (stuck.get(g) || 0) + 1);
  }
  hbar(c("stuck"), top(stuck));

  const topics = labels.map((label, i) => ({ label, value: routes.filter(r => r.path.some(t => clusterOf.get(t) === i)).length }))
    .filter(x => x.value).sort((a, b) => b.value - a.value);
  hbar(c("topic"), topics);
}
