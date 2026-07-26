const express = require('express');
const path = require('path');
const { getWatchlistAsMetas } = require('./lib/letterboxd');

const app = express();
const PORT = process.env.PORT || 7000;

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
      tmdbApiKey: config.tmdbApiKey || null
    });
    res.setHeader('Cache-Control', 'max-age=900, stale-while-revalidate=1800');
    res.json({ metas });
  } catch (err) {
    console.error('Failed to build watchlist catalog:', err.message);
    res.status(500).json({ err: 'Could not fetch Letterboxd watchlist. Is the username correct and the profile public?' });
  }
});

// Helper endpoint the configure page calls to build install links
app.get('/api/encode-config', (req, res) => {
  const { username, tmdbApiKey } = req.query;
  if (!username) return res.status(400).json({ err: 'username is required' });
  const encoded = encodeConfig({ username: username.trim(), tmdbApiKey: tmdbApiKey ? tmdbApiKey.trim() : undefined });
  res.json({ config: encoded });
});

app.listen(PORT, () => {
  console.log(`Letterboxd Stremio addon listening on port ${PORT}`);
  console.log(`Open http://localhost:${PORT}/configure to get your install link`);
});
