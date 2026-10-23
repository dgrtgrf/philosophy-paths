// ─────────────────────────────────────────────────────────────────────────────
//  Settings for your site. This is the only file you need to edit.
// ─────────────────────────────────────────────────────────────────────────────

// From Supabase: Project Settings → API (or the "Connect" button).
// Leave these empty and the site still works, just without "Everyone's tree".
export const SUPABASE_URL = "https://ljluwupwbymdukvlfqos.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxqbHV3dXB3YnltZHVrdmxmcW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3ODA5NDIsImV4cCI6MjEwODM1Njk0Mn0.H_orDsTXwVfm4BsglbkeUjFwUBO81XNfDs6r4bWlQwE";

// Sent to Wikipedia with every request so they know who runs the site.
// Put your site's address here once it's published, e.g.
// "PathsToPhilosophy/1.0 (https://yourname.github.io/philosophy-paths)"
export const SITE_CONTACT = "PathsToPhilosophy/1.0 (https://dgrtgrf.github.io/philosophy-paths)";

// How many of the most recent shared routes "Everyone's tree" shows.
// Much more than a few thousand gets slow to draw.
export const SHARED_ROUTE_LIMIT = 3000;
