// trees.js — "Trees": top-down diagrams of the shared node map, built by tools/build-map-trees.mjs.
// Philosophy: every article that reaches Philosophy. Knowledge: the articles that never reach it and go round
// in the Knowledge loop. Below it: the other never-arrive loops and dead ends. Click a dot to open or close a
// branch, pan or pinch to move around. Hover (or touch) a dot to see its article name; click the name to read it.
/* global d3 */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const wikiURL = t => "https://en.wikipedia.org/wiki/" + encodeURIComponent(t.replace(/ /g, "_"));
const DX = 16, DY = 38;            // uniform spacing: between neighbours, and between levels
const OPEN_LEVELS = 3;             // "first levels" opens this many; the rest start closed
const nfmt = n => n.toLocaleString("en-GB");
const plural = (n, w) => `${nfmt(n)} ${w}${n === 1 ? "" : "s"}`;
let current = "philosophy";

function eachNode(root, f, depth = 0) { f(root, depth); for (const c of root.children) eachNode(c, f, depth + 1); }
/** Open the first levels (or everything), close the rest. */
function setLevels(root, open) {
  eachNode(root, (n, d) => { if (n.children.length) n.collapsed = open === "all" ? false : d >= OPEN_LEVELS; });
}

export function renderTrees(container, data) {
  const tabs = data.trees;
  const active = tabs.find(t => t.key === current) || tabs[0];
  current = active.key;
  const redraw = () => drawTree(container.querySelector("#treeSvg"), active.root, { redraw });
  // the page shell is built once; switching tree only redraws the drawing
  if (!container.querySelector(".tree-svg")) {
    container.innerHTML = `
      <h1>Trees</h1>
      <div class="sub" id="treeSub"></div>
      <div class="seg tree-tabs" id="treeTabs">${tabs.map(t => `<button data-tree="${esc(t.key)}">${esc(t.title)}</button>`).join("")}</div>
      <div class="tree-stats" id="treeStats"></div>
      <div class="tree-tools"><button id="treeOpenAll">Open all</button><button id="treeLevels">First ${OPEN_LEVELS} levels</button></div>
      <svg class="tree-svg" id="treeSvg" role="img" aria-label="Top-down tree of the node map"></svg>
      <p class="tree-note" id="treeNote"></p>
      <div id="treeOther"></div>`;
    container.querySelectorAll("#treeTabs button").forEach(b => b.onclick = () => {
      if (current === b.dataset.tree) return;
      current = b.dataset.tree;
      container.querySelector("#treeSvg").__view = null;     // a new tree gets a fresh fit
      renderTrees(container, data);
    });
  }
  container.querySelector("#treeOpenAll").onclick = () => { setLevels(active.root, "all"); redraw(); };
  container.querySelector("#treeLevels").onclick = () => { setLevels(active.root, "some"); redraw(); };
  container.querySelectorAll("#treeTabs button").forEach(b => b.classList.toggle("on", b.dataset.tree === active.key));

  const isPhilosophy = active.key === "philosophy";
  container.querySelector("#treeSub").textContent = isPhilosophy
    ? `Every article in the node map that reaches ${active.title}, as a top-down tree.`
    : `Articles that never reach Philosophy and go round in the ${active.title} loop, as a top-down tree.`;
  container.querySelector("#treeStats").innerHTML =
    `<span>${plural(active.size, "article")}</span><span>${esc(data.mode)} routes · ${nfmt(data.routes)} in the map</span>` +
    `<span>built ${esc(data.generated)}</span>`;
  container.querySelector("#treeNote").textContent = isPhilosophy
    ? "An article's parent is the article it most often goes to next, among those one step closer to Philosophy."
    : "An article's parent is the article it most often goes to next. Every loop and dead end is shown; the other never-arrive trees are listed below.";

  if (!active.opened) { setLevels(active.root, "some"); active.opened = true; }
  redraw();

  // the other never-arrive trees: each its own small diagram, under the main one
  const other = container.querySelector("#treeOther");
  if (isPhilosophy || !(data.otherLoops || []).length) { other.innerHTML = ""; return; }
  other.innerHTML = `<h2 class="tree-h2">Other never-arrive trees (${data.otherLoops.length})</h2>` + data.otherLoops.map((t, i) =>
    `<div class="tree-small"><div class="tree-small-title">${esc(t.title)} <span>${t.kind === "loop" ? "loop" : "dead end"} · ${plural(t.size, "article")}</span></div>
     <svg class="tree-svg tree-svg-small" id="treeOther${i}" aria-label="${esc(t.title)} tree"></svg></div>`).join("");
  for (const [i, t] of data.otherLoops.entries()) {
    const s = other.querySelector(`#treeOther${i}`);
    setLevels(t.root, "some");
    drawTree(s, t.root, { small: true });
  }
}

function drawTree(svgEl, root, { small = false, redraw } = {}) {
  const st = svgEl.__view || (svgEl.__view = { zoom: null, placed: false, g: null });
  const W = Math.max(320, svgEl.getBoundingClientRect().width || 320);
  const H = small ? 260 : Math.max(380, Math.min(760, window.innerHeight * 0.7));
  svgEl.setAttribute("height", H);
  const svg = d3.select(svgEl);
  if (!st.zoom) {
    svg.selectAll("*").remove();
    st.g = svg.append("g");
    st.zoom = d3.zoom().scaleExtent([0.02, 6])
      .filter(e => e.type === "wheel" || !e.button)
      .on("zoom", e => st.g.attr("transform", e.transform));
    svg.call(st.zoom);
  }
  svg.attr("viewBox", `0 0 ${W} ${H}`);

  const h = d3.hierarchy(root, d => d.collapsed ? null : d.children);
  d3.tree().nodeSize([DX, DY])(h);      // x: across (uniform), y: level (uniform)
  let minX = Infinity, maxX = -Infinity, maxY = 0;
  h.each(d => { minX = Math.min(minX, d.x); maxX = Math.max(maxX, d.x); maxY = Math.max(maxY, d.y); });

  const g = st.g;
  g.selectAll("*").remove();
  g.append("g").attr("fill", "none").attr("stroke", "var(--ink)").attr("stroke-opacity", 0.2).attr("stroke-width", 1)
    .selectAll("path").data(h.links()).join("path")
    .attr("d", d3.linkVertical().x(d => d.x).y(d => d.y));

  // names show only for the dot under the pointer (or finger)
  const node = g.append("g").selectAll("g").data(h.descendants()).join("g")
    .attr("class", "tree-node")
    .attr("transform", d => `translate(${d.x},${d.y})`)
    .on("pointerenter", function () { this.classList.add("hot"); })
    .on("pointerleave", function () { this.classList.remove("hot"); });

  node.append("circle")
    .attr("r", d => d.depth === 0 ? 7 : (small ? 3 : 4))
    .attr("fill", d => d.depth === 0 ? "var(--accent)" : (d.data.children.length ? "var(--ink)" : "var(--muted)"))
    .attr("stroke", d => d.data.collapsed ? "var(--accent)" : "var(--bg)")
    .attr("stroke-width", d => d.data.collapsed ? 2 : 1)
    .style("cursor", d => d.data.children.length ? "pointer" : "default")
    .on("click", (e, d) => {
      if (!d.data.children.length) return;
      d.data.collapsed = !d.data.collapsed;
      if (redraw) redraw(); else drawTree(svgEl, root, { small });
    })
    .append("title").text(d => d.data.children.length
      ? `${d.data.title} — ${d.data.collapsed ? "open" : "close"} this branch (${plural(d.data.children.length, "article")})`
      : d.data.title);

  node.append("text")
    .attr("class", "tree-label")
    .attr("dy", "0.32em").attr("x", 7)
    .attr("transform", "rotate(38)")
    .attr("font-size", d => d.depth === 0 ? 13 : 11)
    .attr("font-weight", d => d.depth === 0 ? 650 : 500)
    .attr("fill", d => d.depth === 0 ? "var(--accent)" : "var(--ink)")
    .attr("paint-order", "stroke").attr("stroke", "var(--bg)").attr("stroke-width", 3).attr("stroke-linejoin", "round")
    .style("cursor", "pointer")
    .text(d => d.data.title + (d.data.collapsed && d.data.children.length ? `  +${nfmt(d.data.children.length)}` : ""))
    .on("click", (e, d) => { e.stopPropagation(); window.open(wikiURL(d.data.title), "_blank", "noopener"); });

  // on first draw, fit the whole tree; after that, keep the reader's zoom and position
  if (!st.placed) {
    const spanX = maxX - minX + DX, spanY = maxY + 30;
    const k = Math.min(1, (W - 40) / spanX, (H - 60) / spanY);
    svg.call(st.zoom.transform, d3.zoomIdentity.translate(W / 2 - ((minX + maxX) / 2) * k, 30).scale(k));
    st.placed = true;
  }
}
