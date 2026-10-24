// ─────────────────────────────────────────────────────────────────────────────
//  Settings for your site. This is the only file you need to edit.
// ─────────────────────────────────────────────────────────────────────────────

// From Supabase: Project Settings → API (or the "Connect" button).
// Leave these empty and the site still works, just without "Everyone's tree".
export const SUPABASE_URL = "";
export const SUPABASE_ANON_KEY = "";

// Sent to Wikipedia with every request so they know who runs the site.
// Put your site's address here once it's published, e.g.
// "PathsToPhilosophy/1.0 (https://yourname.github.io/philosophy-paths)"
export const SITE_CONTACT = "PathsToPhilosophy/1.0 (https://github.com)";

// How many of the most recent shared routes "Everyone's tree" shows.
// Much more than a few thousand gets slow to draw.
export const SHARED_ROUTE_LIMIT = 3000;

// Meaning-based similarity: also compares what each intro means (a small model,
// about 25 MB, downloaded once and cached by the browser). Set to false to go back
// to comparing only the words used. Above MEANING_MAX articles it is skipped,
// because the comparison grows with the square of the number of articles.
export const MEANING = true;
export const MEANING_MAX = 1500;
