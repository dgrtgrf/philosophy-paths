// shared.js — "Everyone's tree": stores finished routes in Supabase and
// streams new ones to every open page.

import { SUPABASE_URL, SUPABASE_ANON_KEY, SHARED_ROUTE_LIMIT } from "./config.js";

let client = null;
export const sharedEnabled = () => !!(window.__FAKE_SHARED__ || (SUPABASE_URL && SUPABASE_ANON_KEY));

async function db() {
  if (window.__FAKE_SHARED__) return window.__FAKE_SHARED__;   // used by tests
  if (!client) {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return client;
}

const clean = r => ({
  mode: r.mode, start: r.start, path: r.path, outcome: r.outcome, rescued: r.rescued || [],
});

/** Most recent shared routes for a mode, oldest first. */
export async function loadRoutes(mode) {
  const c = await db();
  const out = [];
  for (let from = 0; from < SHARED_ROUTE_LIMIT; from += 1000) {
    const to = Math.min(from + 999, SHARED_ROUTE_LIMIT - 1);
    const { data, error } = await c.from("routes")
      .select("id, mode, start, path, outcome, rescued")
      .eq("mode", mode).order("id", { ascending: false }).range(from, to);
    if (error) throw error;
    out.push(...data);
    if (data.length < to - from + 1) break;
  }
  return out.reverse();
}

/** Intro texts for titles (for relevance spacing and topics). */
export async function loadTexts(titles) {
  const c = await db();
  const texts = {};
  for (let i = 0; i < titles.length; i += 80) {
    const { data, error } = await c.from("pages").select("title, text").in("title", titles.slice(i, i + 80));
    if (error) throw error;
    for (const row of data) texts[row.title] = row.text;
  }
  return texts;
}

/** Add one finished route (and any article intros we haven't shared yet). */
const sentTitles = new Set();
export async function addRoute(route, textOf) {
  const c = await db();
  const { error } = await c.from("routes").insert(clean(route));
  if (error) throw error;
  const pages = route.path.filter(t => !sentTitles.has(t))
    .map(t => ({ title: t, text: (textOf(t) || "").slice(0, 1200) }))
    .filter(p => p.text);
  if (pages.length) {
    await c.from("pages").upsert(pages, { onConflict: "title", ignoreDuplicates: true });
    pages.forEach(p => sentTitles.add(p.title));
  }
}

/** Call onRoute(route) whenever anyone adds a route. Returns an unsubscribe function. */
export async function subscribe(onRoute) {
  const c = await db();
  const ch = c.channel("routes-feed")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "routes" }, p => onRoute(p.new))
    .subscribe();
  return () => c.removeChannel(ch);
}
