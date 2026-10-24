// stats.js — "Today & stats": one route of the day and some charts about everyone's shared routes.

const TARGET = "Philosophy";
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const wikiURL = t => "https://en.wikipedia.org/wiki/" + encodeURIComponent(t.replace(/ /g, "_"));
const pct = (a, b) => b ? Math.round(100 * a / b) + "%" : "–";
const MODE = m => m === "smart" ? "Smart rules" : "Classic rules";

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

function bars(items, fmt = v => v) {
  const top = Math.max(1, ...items.map(i => i.value));
  return items.map(i => `<div class="row"><span>${esc(i.label)}</span><b>${fmt(i.value)}</b>
    <div class="bar"><i style="width:${(100 * i.value / top).toFixed(1)}%"></i></div></div>`).join("");
}

function routeCard(pick, texts, labels, mode, date) {
  const { route, topics, rare, rescued } = pick;
  const steps = route.path.map(t => {
    const s = firstSentence(texts.get(t));
    return `<li><a href="${wikiURL(t)}" target="_blank" rel="noopener">${esc(t)}</a>${s ? `<span class="why">${esc(s)}</span>` : ""}</li>`;
  }).join("");
  const facts = [
    `${plural(route.path.length - 1, "click")} from ${esc(route.start)} to Philosophy`,
    topics.length >= 2 ? `Passes through ${topics.length} topics: ${topics.slice(0, 4).map(c => esc(labels[c] || "…")).join(", ")}` : null,
    rescued && mode === "smart" ? `${plural(rescued, "step")} that only smart rules could follow` : null,
    rare ? "Visits at least one article that very few routes touch" : null,
  ].filter(Boolean);
  return `<section class="card feature">
    <div class="kicker">Route of the day · ${esc(date)}</div>
    <h2 class="big">${esc(route.start)} → Philosophy</h2>
    <ol class="steps">${steps}</ol>
    <ul class="facts">${facts.map(f => `<li>${f}</li>`).join("")}</ul>
  </section>`;
}

/** HTML for the whole page. */
export function statsHTML({ routes, texts, clusterOf, labels, mode, loading, error, date }) {
  if (loading) return `<div class="sub">Loading everyone's routes…</div>`;
  if (error) return `<div class="sub">${esc(error)}</div>`;
  if (!routes.length)
    return `<h1>Today &amp; stats</h1><div class="sub">No shared routes yet for ${MODE(mode).toLowerCase()}. Once people share theirs, the stats appear here.</div>`;

  const n = routes.length;
  const reached = routes.filter(r => r.outcome === "philosophy");
  const count = o => routes.filter(r => r.outcome === o).length;
  const clicks = reached.map(r => r.path.length - 1).sort((a, b) => a - b);
  const pick = pickRouteOfDay(routes, clusterOf, date);

  let html = `<h1>Today &amp; stats</h1><div class="sub">Everyone's tree · ${MODE(mode)} · ${plural(n, "route")}</div>`;
  if (pick) html += `<div class="cards">${routeCard(pick, texts, labels, mode, date)}</div>`;

  html += `<div class="grid">${[
    ["Routes", n], ["Reached Philosophy", pct(reached.length, n)],
    ["Median clicks", clicks.length ? clicks[Math.floor(clicks.length / 2)] : "–"],
    ["Longest route", clicks.length ? clicks[clicks.length - 1] : "–"],
    ["Loops back", pct(count("loop"), n)], ["Dead ends", pct(count("dead_end"), n)],
    ["Missing pages", pct(count("missing"), n)],
  ].map(([a, b]) => `<div class="tile"><b>${b}</b><span>${a}</span></div>`).join("")}</div>`;

  const cards = [];
  if (clicks.length) {
    const lo = clicks[0], hi = clicks[clicks.length - 1];
    const counts = Array.from({ length: hi - lo + 1 }, (_, i) => clicks.filter(c => c === lo + i).length);
    const peak = Math.max(...counts);
    cards.push(`<h2>Clicks to Philosophy</h2><div class="hist">${counts.map((c, i) =>
      `<i title="${lo + i} clicks: ${plural(c, "route")}" style="height:${(100 * c / peak).toFixed(1)}%"></i>`).join("")}</div>
      <div class="hist-axis"><span>${lo}</span><span>${hi}</span></div>`);
  }
  cards.push(`<h2>How routes end</h2>` + bars([
    { label: "Reach Philosophy", value: count("philosophy") }, { label: "Loop back", value: count("loop") },
    { label: "Dead end", value: count("dead_end") }, { label: "Too long", value: count("too_long") },
    { label: "Missing page", value: count("missing") },
  ]));
  const gates = new Map();
  for (const r of reached) if (r.path.length >= 2) {
    const g = r.path[r.path.length - 2]; gates.set(g, (gates.get(g) || 0) + 1);
  }
  cards.push(`<h2>Last stop before Philosophy</h2>` + bars([...gates].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([label, value]) => ({ label, value }))));
  const stuck = new Map();
  for (const r of routes) if (r.outcome !== "philosophy") {
    const g = r.path[r.path.length - 1]; stuck.set(g, (stuck.get(g) || 0) + 1);
  }
  cards.push(`<h2>Where routes get stuck</h2>` + (stuck.size ? bars([...stuck].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([label, value]) => ({ label, value }))) : `<div class="sub">Every route reached Philosophy.</div>`));
  const starts = new Map();
  for (const r of routes) {
    const s = starts.get(r.path[0]) || { total: 0, ok: 0 };
    s.total++; if (r.outcome === "philosophy") s.ok++;
    starts.set(r.path[0], s);
  }
  cards.push(`<h2>Starting points</h2>` + [...starts].sort((a, b) => b[1].total - a[1].total).slice(0, 8)
    .map(([t, s]) => `<div class="row"><span>${esc(t)}</span><b>${pct(s.ok, s.total)} of ${s.total}</b></div>`).join(""));
  const topicCount = labels.map((lab, i) => ({
    label: lab, value: routes.filter(r => r.path.some(t => clusterOf.get(t) === i)).length,
  })).filter(x => x.value);
  if (topicCount.length) cards.push(`<h2>Routes touching each topic</h2>` + bars(topicCount));

  html += `<div class="cards">${cards.map(c => `<section class="card">${c}</section>`).join("")}</div>`;
  return html;
}
