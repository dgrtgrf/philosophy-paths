# Paths to Philosophy: setup for GitHub Pages

The site is plain files (no build step). Each visitor's crawl runs in their own browser.
"Everyone's tree" is shared through a free Supabase database.

## 1. Create the shared database (Supabase, free)
1. Go to https://supabase.com, sign up, and click **New project**. Choose any name and region, and set a database password.
2. When the project is ready, open **SQL Editor → New query**, paste the whole of `supabase-setup.sql`, and press **Run**.
3. Go to **Project Settings → API**. Copy the **Project URL** and the **anon public** key.
   (Use the anon key only. Never put the `service_role` key in this site.)

## 2. Put your keys in the site
Open `js/config.js` and fill in:
```js
export const SUPABASE_URL = "https://xxxxxxxx.supabase.co";
export const SUPABASE_ANON_KEY = "eyJ...";
```
Set `SITE_CONTACT` to your GitHub Pages address once you know it, e.g.
`"PathsToPhilosophy/1.0 (https://yourname.github.io/philosophy-paths)"`.
Wikipedia uses this to contact you if a visitor's crawl causes trouble.

## 3. Publish on GitHub Pages
1. Create a new public repository on GitHub, e.g. `philosophy-paths`.
2. Upload the contents of this folder (`index.html`, `js/`, and this file). The files must sit at the top level of the repo.
3. Go to **Settings → Pages**. Under **Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`, and save.
4. After a minute the site is live at `https://<your-username>.github.io/philosophy-paths/`.

## 4. Check it
- Open the site, press **Start** on "My tree" with 10 articles, and watch the routes arrive.
- Open the site in a second window, switch to **Everyone's tree**, and tick **Add my routes to everyone's tree** on the first window. The second window should update live.

## Notes
- Each visitor is rate-limited by Wikipedia separately, so many people can crawl at once.
- Shared routes are stored only when a visitor ticks the share box. The database accepts reads and inserts from anyone, but nobody can edit or delete rows through the site.
- Only the anon key is in the code, which is expected for a public Supabase project. Row Level Security is what protects the data.
- To reset the shared tree, run `delete from public.routes;` in the Supabase SQL Editor. Do this only when you intend to clear everything.
