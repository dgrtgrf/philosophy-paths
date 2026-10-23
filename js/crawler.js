// crawler.js — follows first links on Wikipedia, right in the visitor's browser.
// Same rules as the Python version (classic + smart).

import { SITE_CONTACT } from "./config.js";

const API = "https://en.wikipedia.org/w/api.php";
export const TARGET = "Philosophy";

// Links into these namespaces are not articles, so they never count.
const NON_ARTICLE = /^(file|image|media|help|wikipedia|wp|template|category|portal|special|talk|user|draft|module|mediawiki|timedtext|book|wiktionary|wikt|gadget|education program)( talk)?:/i;

// Parts of the page that are not "the article text".
const SKIP_SELECTORS = [
  "table", "figure", "style", "script",
  ".infobox", ".sidebar", ".navbox", ".vertical-navbox", ".hatnote",
  ".thumb", ".metadata", ".ambox", ".mbox-small", ".noprint",
  ".shortdescription", ".mw-editsection", ".reference", ".mw-ref",
  ".IPA", ".rt-commentedText", "#coordinates", ".coordinates",
  ".mw-empty-elt", ".reflist", ".refbegin", "ol.references", ".mw-references-wrap",
].join(",");

// Smart rules: brackets that usually hold pronunciation, word origins, dates or other names…
const ASIDE_WORDS = /\b(from|latin|greek|french|german|italian|spanish|old english|middle english|arabic|hebrew|sanskrit|persian|japanese|chinese|russian|lit|literally|pronounced|pronunciation|born|died|née|nee|also|known|called|formerly|abbreviated|abbr|plural|singular|meaning|derived|circa|c|b|d|fl|r)\b\.?/i;
// …and italic links that are titles of works rather than scientific names.
const CREATIVE_WORK = /\((film|novel|book|album|song|single|band|tv series|television series|series|magazine|newspaper|journal|play|opera|musical|video game|game|painting|poem|short story|comics|comic|manga|anime|ep|soundtrack|franchise|miniseries)\b/i;
const SCIENTIFIC_NAME = /^(?:[A-Z][a-z]+|[A-Z]\.)(?: [a-z]+){0,2}$/;

const STOPWORDS = new Set(`a an and are as at be been but by for from has have he her his in into is it its of on or that the
their them they this to was were which who will with not also other such than these those there after before between during
over under while one two first most more many some can may known used often called including`.split(/\s+/));

class Stopped extends Error {}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Stopped());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Stopped()); }, { once: true });
  });
}

// ─────────────────────────────────────────────────────────── page parsing ──

function isItalic(el) {
  const tag = el.tagName.toLowerCase();
  if (tag === "i" || tag === "em") return true;
  return (el.getAttribute("style") || "").replace(/\s/g, "").toLowerCase().includes("font-style:italic");
}

function linkTarget(a) {
  const cls = a.classList;
  if (cls.contains("new") || cls.contains("mw-selflink") || cls.contains("external")) return null;
  const href = a.getAttribute("href") || "";
  let raw;
  if (href.startsWith("/wiki/")) raw = href.slice(6);
  else if (href.startsWith("./")) raw = href.slice(2);
  else return null;
  raw = raw.split("#")[0].split("?")[0];
  if (!raw) return null;
  let title;
  try { title = decodeURIComponent(raw); } catch { title = raw; }
  title = title.replace(/_/g, " ").trim();
  if (!title || NON_ARTICLE.test(title)) return null;
  return title[0].toUpperCase() + title.slice(1);
}

function flatten(node, italic, out) {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) out.push({ kind: "text", val: child.nodeValue, italic });
    else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === "a") out.push({ kind: "link", val: child, italic });
      else {
        flatten(child, italic || isItalic(child), out);
        if (tag === "b" || tag === "strong") out.push({ kind: "bold_end", italic });
      }
    }
  }
}

function isAside(group) {
  if (group.lead) return true;
  const t = group.text;
  return ASIDE_WORDS.test(t) || /\d{3,4}/.test(t) || t.includes(";") || t.includes(":");
}

function candidates(block, state) {
  const items = [];
  flatten(block, false, items);
  const stack = [], out = [];
  let sinceBold = null;   // characters since the bold article name ended
  for (const it of items) {
    if (it.kind === "bold_end") { sinceBold = 0; continue; }
    if (it.kind === "text") {
      for (const ch of it.val) {
        if (ch === "(") {
          // "lead" = bracket straight after the bold name in the opening sentence
          stack.push({ text: "", lead: !state.sentenceDone && sinceBold === 0 });
        } else if (ch === ")") {
          stack.pop();
        } else {
          for (const g of stack) g.text += ch;
          if (ch === "." && !stack.length) state.sentenceDone = true;
        }
        if (sinceBold !== null && !/\s/.test(ch) && ch !== "(") sinceBold++;
      }
      continue;
    }
    const anchor = it.val.textContent;
    for (const g of stack) g.text += anchor;
    if (sinceBold !== null) sinceBold += anchor.trim().length;
    const title = linkTarget(it.val);
    if (title) out.push({ title, italic: it.italic, anchor: anchor.trim(), groups: [...stack] });
  }
  // judge only after the whole block is read, so each bracket's full text is known
  for (const c of out) {
    c.classicOk = !c.italic && !c.groups.length;
    const bracketsOk = c.groups.every(g => !isAside(g));
    const italicOk = !c.italic || (SCIENTIFIC_NAME.test(c.anchor) && !CREATIVE_WORK.test(c.title));
    c.smartOk = bracketsOk && italicOk;
  }
  return out;
}

/** → { classic, smart: [[title, rescued?], …], text } */
export function analysePage(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const root = doc.querySelector(".mw-parser-output") || doc.body;
  root.querySelectorAll(SKIP_SELECTORS).forEach(el => el.remove());

  let classic = null;
  const rescued = [];
  const state = { sentenceDone: false };
  for (const block of root.querySelectorAll("p, ul, ol")) {
    for (const c of candidates(block, state)) {
      if (c.classicOk) { classic = c.title; break; }
      if (c.smartOk && rescued.length < 3 && !rescued.includes(c.title)) rescued.push(c.title);
    }
    if (classic) break;
    if (block.textContent.trim()) state.sentenceDone = true;
  }
  const smart = [...rescued.map(t => [t, true]), ...(classic ? [[classic, false]] : [])];
  const text = [...root.querySelectorAll("p")].map(p => p.textContent.trim()).filter(Boolean)
    .join(" ").replace(/\s+/g, " ").slice(0, 1200);
  return { classic, smart, text };
}

// ─────────────────────────────────────────────────────────── relevance ──

function bag(text) {
  const counts = new Map();
  for (const w of (text.toLowerCase().match(/[a-z]{3,}/g) || [])) {
    if (!STOPWORDS.has(w)) counts.set(w, (counts.get(w) || 0) + 1);
  }
  const out = new Map();
  for (const [w, n] of counts) out.set(w, 1 + Math.log(n));
  return out;
}
function cosine(a, b) {
  if (!a.size || !b.size) return 0;
  let dot = 0, na = 0, nb = 0;
  for (const [w, v] of a) { dot += v * (b.get(w) || 0); na += v * v; }
  for (const v of b.values()) nb += v * v;
  return dot / Math.sqrt(na * nb);
}

// ─────────────────────────────────────────────────────────── crawler ──

export class Crawler {
  constructor({ delay = 100, onWait } = {}) {
    this.delay = delay;
    this.onWait = onWait;            // called with seconds when Wikipedia asks us to slow down
    this.pages = new Map();          // canonical title → { next, text, smart? }
    this.aliases = new Map();        // requested title → canonical title
    this.controller = null;
  }

  stop() { this.controller?.abort(); }
  get signal() { return this.controller?.signal; }

  async api(params) {
    const q = new URLSearchParams({ ...params, format: "json", formatversion: "2", origin: "*", maxlag: "5" });
    for (let attempt = 0; attempt < 8; attempt++) {
      let wait = Math.min(5 * 2 ** attempt, 120);
      try {
        const r = await fetch(`${API}?${q}`, { headers: { "Api-User-Agent": SITE_CONTACT }, signal: this.signal });
        if (r.status === 429 || r.status >= 500) {
          const ra = parseInt(r.headers.get("Retry-After") || "", 10);
          if (ra > 0) wait = Math.max(ra, 5);
          throw new Error(`HTTP ${r.status}`);
        }
        const data = await r.json();
        if (data.error?.code === "maxlag") throw new Error("Wikipedia busy");
        return data;
      } catch (e) {
        if (this.signal?.aborted) throw new Stopped();
        this.onWait?.(wait);
        await sleep(wait * 1000, this.signal);
      }
    }
    throw new Error("Wikipedia kept refusing requests. Try again in a few minutes.");
  }

  async randomTitles(n) {
    const titles = [];
    while (titles.length < n) {
      const data = await this.api({ action: "query", list: "random", rnnamespace: 0, rnlimit: Math.min(50, n - titles.length) });
      titles.push(...data.query.random.map(p => p.title));
    }
    return titles.slice(0, n);
  }

  async intros(titles) {
    const data = await this.api({
      action: "query", prop: "extracts", exintro: 1, explaintext: 1, exlimit: "max",
      redirects: 1, titles: titles.join("|"),
    });
    const q = data.query || {};
    const back = new Map(titles.map(t => [t, t]));
    for (const m of [...(q.normalized || []), ...(q.redirects || [])])
      for (const [orig, cur] of back) if (cur === m.from) back.set(orig, m.to);
    const found = new Map((q.pages || []).map(p => [p.title, p.extract || ""]));
    return new Map([...back].map(([orig, cur]) => [orig, found.get(cur) || ""]));
  }

  /** Earliest candidate that is nearly as relevant to this article as the best one. */
  async chooseSmart(pageText, cands) {
    if (!cands.length) return [null, false];
    if (cands.length === 1) return cands[0];
    const texts = await this.intros(cands.map(c => c[0]));
    await sleep(this.delay, this.signal);
    const here = bag(pageText);
    const scores = cands.map(([t]) => cosine(here, bag(t + ". " + (texts.get(t) || ""))));
    const best = Math.max(...scores);
    if (best <= 0) return cands.find(c => !c[1]) || cands[0];
    for (let i = 0; i < cands.length; i++) if (scores[i] >= 0.75 * best) return cands[i];
    return cands[cands.length - 1];
  }

  async resolve(title, mode) {
    const key = this.aliases.get(title) || title;
    let entry = this.pages.get(key);
    if (entry && (mode === "classic" || entry.smart)) return [key, entry];

    const data = await this.api({ action: "parse", page: title, prop: "text", redirects: 1, disableeditsection: 1, disabletoc: 1 });
    await sleep(this.delay, this.signal);
    if (data.error) return [null, null];

    const canon = data.parse.title;
    entry = this.pages.get(canon);
    if (!entry || (mode === "smart" && !entry.smart)) {
      const { classic, smart, text } = analysePage(data.parse.text);
      entry = { next: classic, text };
      if (mode === "smart") {
        const [next, rescued] = await this.chooseSmart(text, smart);
        entry.smart = { next, rescued };
      }
      this.pages.set(canon, entry);
    }
    if (canon !== title) this.aliases.set(title, canon);
    return [canon, entry];
  }

  /** → { start, path, outcome, rescued, mode } */
  async follow(start, mode, maxSteps = 80) {
    const path = [], seen = new Set(), rescued = [];
    let title = start;
    const done = outcome => ({ start, path, outcome, rescued, mode });
    while (true) {
      const [canon, entry] = await this.resolve(title, mode);
      if (!canon) return done("missing");
      if (seen.has(canon)) { path.push(canon); return done("loop"); }
      path.push(canon); seen.add(canon);
      if (canon === TARGET) return done("philosophy");
      const next = mode === "smart" ? entry.smart.next : entry.next;
      const wasRescued = mode === "smart" && entry.smart.rescued;
      if (!next) return done("dead_end");
      if (path.length >= maxSteps) return done("too_long");
      if (wasRescued) rescued.push(path.length - 1);
      title = next;
    }
  }

  /**
   * Crawl n random articles (or the given starts), calling onRoute(route) after each.
   * Resolves when finished or stopped; stop() ends it early.
   */
  async run({ mode, n, starts, onRoute, onStarts }) {
    this.controller = new AbortController();
    try {
      const list = starts?.length ? starts : await this.randomTitles(n);
      onStarts?.(list);
      for (const s of list) {
        const route = await this.follow(s, mode);
        if (route.path.length) await onRoute(route);
      }
      return "finished";
    } catch (e) {
      if (e instanceof Stopped || this.signal?.aborted) return "stopped";
      throw e;
    } finally {
      this.controller = null;
    }
  }

  textOf(title) { return this.pages.get(title)?.text || ""; }
}
