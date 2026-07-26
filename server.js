const express = require('express');
const path = require('path');
const { getWatchlistAsMetas, parsePosterGridItems } = require('./lib/letterboxd');

const app = express();
const PORT = process.env.PORT || 7000;

// Stremio's app fetches addon manifests/catalogs cross-origin, so these
// endpoints must send CORS headers or the request gets rejected client-side.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ---- config helpers -------------------------------------------------------
// Per-user config (Letterboxd username + optional TMDB API key) is packed
// into a base64url string that lives in the addon URL, e.g.
//   https://your-host/eyJ1c2VybmFtZSI6ImpvaG4ifQ/manifest.json
// This is the standard pattern community Stremio addons use since Stremio
// itself has no concept of "logging in" to a third-party service.

function encodeConfig(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeConfig(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch (err) {
    return null;
  }
}

function baseManifest() {
  return {
    id: 'org.stremio.letterboxd.watchlist',
    version: '1.0.0',
    name: 'Letterboxd Watchlist',
    description: 'Shows your public Letterboxd watchlist as a Stremio catalog.',
    logo: 'https://a.ltrbxd.com/logos/letterboxd-decal-dots-pos-rgb.png',
    resources: ['catalog'],
    types: ['movie'],
    catalogs: [
      {
        type: 'movie',
        id: 'letterboxd-watchlist',
        name: 'Letterboxd Watchlist'
      }
    ],
    behaviorHints: {
      configurable: true,
      configurationRequired: true
    }
  };
}

// ---- routes -----------------------------------------------------------

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Stremio shows a "Configure" button for installed addons that links here
app.get('/:config/configure', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configure.html'));
});

// Unconfigured manifest — lets Stremio discover the addon needs configuring
app.get('/manifest.json', (req, res) => {
  res.json(baseManifest());
});

app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  const manifest = baseManifest();
  if (config && config.username) {
    manifest.behaviorHints.configurationRequired = false;
    manifest.name = `Letterboxd Watchlist (${config.username})`;
  }
  res.json(manifest);
});

app.get('/:config/catalog/movie/letterboxd-watchlist.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) {
    return res.status(400).json({ err: 'Missing Letterboxd username in addon config' });
  }

  try {
    const metas = await getWatchlistAsMetas(config.username, {
      tmdbApiKey: config.tmdbApiKey || null,
      scraperApiKey: config.scraperApiKey || null
    });
    res.setHeader('Cache-Control', 'max-age=900, stale-while-revalidate=1800');
    res.json({ metas });
  } catch (err) {
    console.error('Failed to build watchlist catalog:', err.message);
    res.status(500).json({
      err: 'Could not fetch Letterboxd watchlist. Is the username correct and the profile public?',
      debug: err.message
    });
  }
});

// TEMPORARY debug helper: hit /debug/<username> to see the raw fetch result
// from Letterboxd's watchlist HTML page (direct, via ScraperAPI, and via a
// public proxy), plus how many films the real poster-grid parser found in
// each, so we can diagnose blocking/bot-detection or markup-drift issues.
app.get('/debug/:username', async (req, res) => {
  const watchlistUrl = `https://letterboxd.com/${encodeURIComponent(req.params.username)}/watchlist/`;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  };

  const result = {};

  // A 200/OK status doesn't mean we got real data — Cloudflare's "Just a
  // moment..." JS-challenge interstitial is itself served with a normal
  // status by some proxies that just relay whatever they received. But we
  // only match on the actual interstitial title, not on the presence of
  // Cloudflare's routine bot-management beacon script, which is embedded on
  // normal successful page loads too and would otherwise false-positive.
  const looksLikeCloudflareChallenge = (body) => typeof body === 'string' && /<title>\s*Just a moment/i.test(body);

  const summarize = async (res) => {
    const body = await res.text();
    const blocked = looksLikeCloudflareChallenge(body);
    let parsedItems = [];
    try {
      parsedItems = parsePosterGridItems(body);
    } catch (err) {
      // parsing failure shouldn't crash the debug endpoint
    }
    return {
      status: res.status,
      ok: res.ok && !blocked,
      blockedByCloudflareChallenge: blocked,
      filmsFoundByParser: parsedItems.length,
      firstFewParsedItems: parsedItems.slice(0, 3),
      bodySnippet: body.slice(0, 300)
    };
  };

  try {
    const directRes = await fetch(watchlistUrl, { headers });
    result.direct = await summarize(directRes);
  } catch (err) {
    result.direct = { error: err.message };
  }

  const scraperApiKey = req.query.scraperApiKey;
  if (scraperApiKey) {
    try {
      const scraperUrl = `https://api.scraperapi.com/?api_key=${encodeURIComponent(scraperApiKey)}&url=${encodeURIComponent(watchlistUrl)}&premium=true`;
      const scraperRes = await fetch(scraperUrl);
      result.scraperapi = await summarize(scraperRes);
    } catch (err) {
      result.scraperapi = { error: err.message };
    }
  } else {
    result.scraperapi = { skipped: 'no scraperApiKey query param provided' };
  }

  try {
    const proxyRes = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(watchlistUrl)}`);
    result.publicProxy = await summarize(proxyRes);
  } catch (err) {
    result.publicProxy = { error: err.message };
  }

  res.json(result);
});

// Helper endpoint the configure page calls to build install links
app.get('/api/encode-config', (req, res) => {
  const { username, tmdbApiKey, scraperApiKey } = req.query;
  if (!username) return res.status(400).json({ err: 'username is required' });
  const encoded = encodeConfig({
    username: username.trim(),
    tmdbApiKey: tmdbApiKey ? tmdbApiKey.trim() : undefined,
    scraperApiKey: scraperApiKey ? scraperApiKey.trim() : undefined
  });
  res.json({ config: encoded });
});

// When run directly (npm start / node server.js) start a normal server.
// When imported (e.g. by Vercel's serverless entrypoint in api/index.js)
// just export the app instead — the host takes care of listening.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Letterboxd Stremio addon listening on port ${PORT}`);
    console.log(`Open http://localhost:${PORT}/configure to get your install link`);
  });
}

module.exports = app;
