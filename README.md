# Letterboxd Watchlist — Stremio Addon

Shows your **public Letterboxd watchlist** as a catalog inside Stremio.

## How it works (no "login" needed)

Stremio addons don't support OAuth-style logins to third-party services.
Instead, this addon reads your **public** Letterboxd watchlist RSS feed
(`letterboxd.com/<you>/watchlist/rss/`) and turns it into a Stremio catalog.
Your username (and an optional TMDB API key) gets encoded into the addon's
install URL — that's the "link my account" step.

For each film it tries to resolve an **IMDb id**, so that other addons you
already have installed (Torrentio, etc.) can offer streams for it. It does
this two ways:
1. **Fast path**: if you provide a free [TMDB API key](https://www.themoviedb.org/settings/api),
   it uses TMDB's `external_ids` endpoint (Letterboxd's RSS already includes the TMDB id).
2. **Fallback**: if no key is given, it scrapes the film's Letterboxd page for its IMDb link.
   Slower, but works with zero setup. Results are cached for 7 days.

## Requirements

- Your Letterboxd **watchlist privacy must be Public** (Settings → Privacy on letterboxd.com). This is the default.
- Node.js 18+ to run the addon yourself.

## Run locally

```bash
npm install
npm start
```

Then open **http://localhost:7000/configure**, enter your username, and click
"Install in Stremio". If you're running this on your own machine and opening
Stremio on the same machine, the `stremio://` button will just work.

## Deploy it so Stremio (including mobile) can reach it

Stremio needs to reach your addon over the internet (or at least your LAN), so `localhost`
only works if Stremio runs on the same machine. Easiest free options:

### Option A — Render.com (free tier)
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Once deployed, visit `https://your-app.onrender.com/configure`.

### Option B — Railway / Fly.io / a VPS
Same idea: `npm install && npm start`, expose port `7000` (or set `PORT` env var).

### Option C — Beamup (Stremio's own community hosting CLI)
```bash
npm install -g beamup-cli
beamup
```
Follow the prompts; it publishes the addon and gives you a URL.

## Installing in Stremio

1. Visit `/configure` on wherever you deployed it.
2. Enter your Letterboxd username (and optionally a TMDB key).
3. Click "Install in Stremio" — or copy the manifest URL and paste it into
   Stremio → Addons (puzzle piece icon) → search bar at the top, which accepts
   addon URLs directly.
4. Your watchlist will appear as a "Letterboxd Watchlist" catalog on the Movies
   tab (or in Discover).

## Notes & limitations

- Only **movies** are handled by default (Letterboxd is mostly film-focused).
  TV items in a watchlist are skipped for now — say the word and I can add TV support.
- Up to ~1,000 watchlist items are fetched (10 RSS pages); let me know if yours is bigger.
- The catalog is cached for 15 minutes so re-opening Stremio won't hammer Letterboxd.
- If an IMDb id can't be resolved for a film, it still shows up (poster + title) but
  won't have streams from IMDb-keyed addons like Torrentio — this is rare.

## Project structure

```
server.js              Express app: manifest, catalog, and config endpoints
lib/letterboxd.js       RSS fetching, parsing, IMDb id resolution
lib/cache.js             Tiny in-memory TTL cache
public/configure.html    The setup page users see
```
