// app.js — wires the crawler, the shared tree and the drawing together.

import { Crawler } from "./crawler.js";
import { initViz, setData, resetSlot, esc, plural } from "./viz.js";
import * as shared from "./shared.js";

const $ = id => document.getElementById(id);
const MODE_NAMES = { classic: "Classic rules", smart: "Smart rules" };

const state = {
  tab: "mine",
  mode: "classic",
  mine: { routes: [], mode: "classic", running: false, total: 0, status: "", statusKind: "" },
  everyone: { classic: null, smart: null, loading: false, error: null },
  analysis: {},          // slot → result from the similarity worker
};
const texts = new Map(); // title → intro text, from our own crawling and from the shared table

const crawler = new Crawler({
  onWait: secs => setMineStatus(`Wikipedia asked us to slow down — waiting ${secs}s`, "warn"),
});

// ─────────────────────────────────────────────── similarity, off the main thread ──
const worker = new Worker(new URL("./textsim-worker.js", import.meta.url), { type: "module" });
const jobs = { busy: false, pending: new Set(), id: 0 };
worker.onmessage = e => {
  const { slot } = jobs.current;
  state.analysis[slot] = e.data.result;
  jobs.busy = false;
  if (slot === currentSlot()) render();
  if (jobs.pending.size) { const next = jobs.pending.values().next().value; jobs.pending.delete(next); analyse(next); }
};
function analyse(slot) {
  if (jobs.busy) { jobs.pending.add(slot); return; }
  const routes = routesFor(slot);
  if (!routes.length) return;
  const visits = new Map(), edges = new Set();
  for (const r of routes) {
    for (const t of new Set(r.path)) visits.set(t, (visits.get(t) || 0) + 1);
    for (let i = 0; i < r.path.length - 1; i++) edges.add(r.path[i] + "\t" + r.path[i + 1]);
  }
  const titles = [...visits.keys()].sort((a, b) => visits.get(b) - visits.get(a));
  const payload = {};
  for (const t of titles) payload[t] = texts.get(t) || crawler.textOf(t) || "";
  jobs.busy = true; jobs.current = { slot };
  worker.postMessage({ id: ++jobs.id, titles, texts: payload, edges: [...edges].map(e => e.split("\t")) });
}
// re-run similarity at most every couple of seconds while routes stream in
const analyseSoon = (() => {
  const timers = {};
  return slot => { clearTimeout(timers[slot]); timers[slot] = setTimeout(() => analyse(slot), 1500); };
})();

// ─────────────────────────────────────────────── what's on screen ──
const currentSlot = () => state.tab === "mine" ? "mine" : `everyone-${state.mode}`;
function routesFor(slot) {
  if (slot === "mine") return state.mine.routes;
  return state.everyone[slot.split("-")[1]] || [];
}

function render() {
  const slot = currentSlot();
  const mode = state.tab === "mine" ? state.mine.mode : state.mode;
  const subtitle = state.tab === "mine" ? `My tree · ${MODE_NAMES[mode]}` : `Everyone's tree · ${MODE_NAMES[mode]}`;
  setData(slot, { routes: routesFor(slot), mode, analysis: state.analysis[slot], subtitle });
  renderChrome();
}

function renderChrome() {
  document.querySelectorAll("#tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === state.tab));
  const modeShown = state.tab === "mine" && state.mine.running ? state.mine.mode : state.mode;
  document.querySelectorAll("#modes button").forEach(b => {
    b.classList.toggle("on", b.dataset.mode === modeShown);
    b.disabled = state.tab === "mine" && state.mine.running;
  });
  $("runBox").style.display = state.tab === "mine" ? "" : "none";
  $("go").textContent = state.mine.running ? "Stop" : "Start";
  $("go").classList.toggle("stop", state.mine.running);
  $("shareBox").style.display = shared.sharedEnabled() ? "" : "none";
  $("tabs").style.display = shared.sharedEnabled() ? "" : "none";

  // status line
  const st = $("status");
  let text = "", kind = "";
  if (state.tab === "mine") { text = state.mine.status; kind = state.mine.statusKind; }
  else if (state.everyone.error) { text = state.everyone.error; kind = "err"; }
  else if (state.everyone.loading) { text = "Loading everyone's routes…"; kind = ""; }
  else { const n = routesFor(currentSlot()).length; text = `Live · updates as people crawl`; kind = n ? "live" : ""; }
  st.className = text ? "on " + kind : "";
  $("statusText").textContent = text;

  // empty state
  const empty = $("empty");
  if (routesFor(currentSlot()).length) empty.innerHTML = "";
  else if (state.tab === "mine")
    empty.innerHTML = state.mine.running
      ? `<div><b>Following first links…</b>Your first route appears here as soon as it's done.</div>`
      : `<div><b>Does every article lead to Philosophy?</b>Press <em>Start</em> to send random Wikipedia articles on a walk: click the first link, then the first link on that page, and so on. Watch the routes grow into a tree.</div>`;
  else if (!state.everyone.loading && !state.everyone.error)
    empty.innerHTML = `<div><b>No shared routes yet</b>Routes people crawl with ${MODE_NAMES[state.mode].toLowerCase()} show up here live.</div>`;
  else empty.innerHTML = "";
}

function setMineStatus(text, kind = "") {
  state.mine.status = text; state.mine.statusKind = kind;
  if (state.tab === "mine") renderChrome();
}

// ─────────────────────────────────────────────── crawling ──
async function start() {
  const mode = state.mode;
  const startFrom = $("startFrom").value.split(",").map(s => s.trim()).filter(Boolean);
  const n = startFrom.length || +$("count").value;
  const share = shared.sharedEnabled() && $("share").checked;

  // every run starts a fresh tree
  state.mine = { routes: [], mode, running: true, total: n, status: "", statusKind: "live" };
  delete state.analysis.mine;
  resetSlot("mine");
  render();
  setMineStatus(startFrom.length ? "Starting…" : "Picking random articles…", "live");

  let shareFailed = false;
  try {
    const how = await crawler.run({
      mode, n, starts: startFrom,
      onStarts: list => { state.mine.total = list.length; setMineStatus(`Crawling · route 1 of ${list.length}`, "live"); },
      onRoute: async route => {
        state.mine.routes.push(route);
        for (const t of route.path) if (!texts.has(t) && crawler.textOf(t)) texts.set(t, crawler.textOf(t));
        const done = state.mine.routes.length;
        setMineStatus(done < state.mine.total ? `Crawling · route ${done + 1} of ${state.mine.total}` : "Finishing…", "live");
        if (state.tab === "mine") render();
        analyseSoon("mine");
        if (share) shared.addRoute(route, t => crawler.textOf(t)).catch(err => {
          if (!shareFailed) { shareFailed = true; console.warn("Couldn't share route:", err); }
        });
      },
    });
    const done = state.mine.routes.length;
    const reached = state.mine.routes.filter(r => r.outcome === "philosophy").length;
    setMineStatus(how === "stopped"
      ? `Stopped · ${plural(done, "route")}`
      : `Finished · ${reached} of ${done} reached Philosophy${shareFailed ? " · sharing failed" : ""}`);
  } catch (err) {
    setMineStatus(err.message || "Something went wrong.", "err");
  } finally {
    state.mine.running = false;
    analyse("mine");
    renderChrome();
  }
}

$("go").addEventListener("click", () => state.mine.running ? crawler.stop() : start());
$("startFrom").addEventListener("keydown", e => { if (e.key === "Enter" && !state.mine.running) start(); });
window.addEventListener("beforeunload", e => { if (state.mine.running) { e.preventDefault(); e.returnValue = ""; } });

// ─────────────────────────────────────────────── everyone's tree ──
let subscribed = false;
const pendingTitles = new Set();
const fetchTextsSoon = (() => {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const titles = [...pendingTitles].filter(x => !texts.has(x));
      pendingTitles.clear();
      if (!titles.length) return;
      try {
        const got = await shared.loadTexts(titles);
        for (const [k, v] of Object.entries(got)) texts.set(k, v);
        analyseSoon(`everyone-${state.mode}`);
      } catch (e) { console.warn(e); }
    }, 2000);
  };
})();

async function openEveryone() {
  const mode = state.mode;
  if (!subscribed) {
    subscribed = true;
    shared.subscribe(route => {
      const list = state.everyone[route.mode];
      if (!list) return;                         // not loaded yet; we'll get it on load
      list.push(route);
      route.path.forEach(t => pendingTitles.add(t));
      fetchTextsSoon();
      analyseSoon(`everyone-${route.mode}`);
      if (currentSlot() === `everyone-${route.mode}`) render();
    }).catch(e => console.warn("Live updates unavailable:", e));
  }
  if (state.everyone[mode]) { render(); return; }
  state.everyone.loading = true; state.everyone.error = null;
  render();
  try {
    const routes = await shared.loadRoutes(mode);
    state.everyone[mode] = routes;
    const titles = [...new Set(routes.flatMap(r => r.path))].filter(t => !texts.has(t));
    const got = await shared.loadTexts(titles);
    for (const [k, v] of Object.entries(got)) texts.set(k, v);
  } catch (e) {
    console.warn(e);
    state.everyone.error = "Couldn't load everyone's tree.";
  } finally {
    state.everyone.loading = false;
  }
  analyse(`everyone-${mode}`);
  if (state.tab === "everyone") render();
}

// ─────────────────────────────────────────────── tabs and rules ──
document.querySelectorAll("#tabs button").forEach(b => b.onclick = () => {
  if (state.tab === b.dataset.tab) return;
  state.tab = b.dataset.tab;
  if (state.tab === "everyone") openEveryone(); else render();
});
document.querySelectorAll("#modes button").forEach(b => b.onclick = () => {
  if (b.disabled || state.mode === b.dataset.mode) return;
  state.mode = b.dataset.mode;
  if (state.tab === "everyone") openEveryone();
  else {
    // the rules apply to your next run; an existing tree keeps its own rules
    if (!state.mine.routes.length) state.mine.mode = state.mode;
    render();
  }
});

// ─────────────────────────────────────────────── go ──
initViz();
render();
