const cheerio = require('cheerio');
const { parseStringPromise } = require('xml2js');
const cache = require('./cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const RSS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const FILM_PAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (imdb id for a film never changes)
const MAX_PAGES = 10; // safety cap: 10 pages * ~100 items = up to ~1000 watchlist entries

// Cloudflare serves its "Just a moment..." JS-challenge interstitial with a
// normal-looking HTTP status (often 200 from proxies that just relay it), so
// checking res.ok alone isn't enough — we also have to look at the body to
// know whether we actually got real content or just the challenge page.
function isCloudflareChallenge(body) {
  return typeof body === 'string' && (body.includes('Just a moment') || body.includes('cf-chl') || body.includes('cdn-cgi/challenge-platform'));
}

async function fetchDirect(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://letterboxd.com/'
    }
  });
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`Direct request to ${url} failed with status ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (isCloudflareChallenge(body)) {
    throw new Error(`Direct request to ${url} was blocked by Cloudflare's JS challenge`);
  }
  return body;
}

// ScraperAPI is a scraping service built specifically to get past bot
// protection like Cloudflare's JS challenge (which is what blocks Letterboxd
// requests from most cloud hosting IPs, Render included). Free tier: 1,000
// requests/month, no credit card. https://www.scraperapi.com/
async function fetchViaScraperApi(url, scraperApiKey) {
  // Letterboxd is one of the domains ScraperAPI classifies as "protected"
  // (sits behind Cloudflare), which requires the premium residential proxy
  // pool. Without premium=true, ScraperAPI rejects the request outright
  // rather than returning a normal failed-scrape response. Note: premium
  // requests consume more of your monthly quota (typically ~10 credits vs
  // 1 for a standard request), so free-tier usage will be limited.
  const proxied = `https://api.scraperapi.com/?api_key=${encodeURIComponent(scraperApiKey)}&url=${encodeURIComponent(url)}&premium=true`;
  const res = await fetch(proxied);
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`ScraperAPI request to ${url} failed with status ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  if (isCloudflareChallenge(body)) {
    throw new Error(`ScraperAPI request to ${url} still returned Cloudflare's JS challenge even with premium=true`);
  }
  return body;
}

// Last-resort fallback if no ScraperAPI key is configured: a free public
// CORS proxy. These are flaky (rate limits, random downtime) but cost nothing.
async function fetchViaPublicProxy(url) {
  const proxied = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
  const res = await fetch(proxied);
  const body = await res.text();
  if (!res.ok) {
    const err = new Error(`Public proxy request to ${url} failed with status ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (isCloudflareChallenge(body)) {
    throw new Error(`Public proxy request to ${url} was blocked by Cloudflare's JS challenge (the free proxy doesn't run JS, so it can't get past this)`);
  }
  return body;
}

async function fetchText(url, { scraperApiKey } = {}) {
  const errors = [];

  try {
    return await fetchDirect(url);
  } catch (err) {
    errors.push(`direct: ${err.message}`);
  }

  if (scraperApiKey) {
    try {
      return await fetchViaScraperApi(url, scraperApiKey);
    } catch (err) {
      errors.push(`scraperapi: ${err.message}`);
    }
  }

  try {
    return await fetchViaPublicProxy(url);
  } catch (err) {
    errors.push(`public proxy: ${err.message}`);
  }

  throw new Error(`All fetch strategies failed for ${url}. ${errors.join(' | ')}`);
}

/**
 * Pull one page of the watchlist RSS feed for a user.
 * Returns { items, hasNextPage }
 */
async function fetchWatchlistPage(username, page, opts) {
  const url = `https://letterboxd.com/${encodeURIComponent(username)}/watchlist/rss/${
    page > 1 ? `page/${page}/` : ''
  }`;
  const xml = await fetchText(url, opts);
  const parsed = await parseStringPromise(xml, { explicitArray: false, trim: true });

  const channel = parsed && parsed.rss && parsed.rss.channel;
  if (!channel) return { items: [], hasNextPage: false };

  let rawItems = channel.item || [];
  if (!Array.isArray(rawItems)) rawItems = [rawItems];

  const items = rawItems.map((item) => {
    // Letterboxd RSS namespaced fields, e.g. <letterboxd:filmTitle>, <letterboxd:filmYear>, <tmdb:movieId>, <tmdb:type>
    const filmTitle = item['letterboxd:filmTitle'] || stripYearFromTitle(item.title);
    const filmYear = item['letterboxd:filmYear'] || extractYearFromTitle(item.title);
    const tmdbId = item['tmdb:movieId'] || null;
    const tmdbType = item['tmdb:type'] || 'movie';
    const link = item.link;
    const poster = extractPosterFromDescription(item.description);

    return { title: filmTitle, year: filmYear, tmdbId, tmdbType, link, poster };
  });

  return { items, hasNextPage: items.length > 0 };
}

function stripYearFromTitle(title) {
  if (!title) return title;
  return title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
}

function extractYearFromTitle(title) {
  if (!title) return null;
  const match = title.match(/\((\d{4})\)\s*$/);
  return match ? match[1] : null;
}

function extractPosterFromDescription(description) {
  if (!description) return null;
  const $ = cheerio.load(description);
  const src = $('img').attr('src');
  return src || null;
}

/**
 * Fetch the full watchlist (all pages) for a username, using the cache.
 */
async function getWatchlist(username, opts = {}) {
  const cacheKey = `watchlist:${username.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const allItems = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { items, hasNextPage } = await fetchWatchlistPage(username, page, opts);
    allItems.push(...items);
    if (!hasNextPage || items.length === 0) break;
  }

  cache.set(cacheKey, allItems, RSS_TTL_MS);
  return allItems;
}

/**
 * Resolve an IMDb id for a film using TMDB's API (fast, reliable) when a TMDB API key is available.
 */
async function resolveImdbIdViaTmdb(tmdbId, tmdbType, tmdbApiKey) {
  const cacheKey = `tmdb-imdb:${tmdbType}:${tmdbId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const type = tmdbType === 'tv' ? 'tv' : 'movie';
  const url = `https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${tmdbApiKey}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`TMDB request failed: ${res.status}`);
    const data = await res.json();
    const imdbId = data.imdb_id || null;
    cache.set(cacheKey, imdbId, FILM_PAGE_TTL_MS);
    return imdbId;
  } catch (err) {
    return null;
  }
}

/**
 * Fallback: scrape the Letterboxd film page directly for its IMDb link.
 * Used when no TMDB API key is configured, or TMDB lookup fails.
 */
async function resolveImdbIdViaScrape(filmUrl, opts) {
  if (!filmUrl) return null;
  const cacheKey = `scrape-imdb:${filmUrl}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const html = await fetchText(filmUrl, opts);
    const match = html.match(/imdb\.com\/title\/(tt\d+)/);
    const imdbId = match ? match[1] : null;
    cache.set(cacheKey, imdbId, FILM_PAGE_TTL_MS);
    return imdbId;
  } catch (err) {
    return null;
  }
}

/**
 * Build Stremio catalog "meta preview" objects for a user's watchlist.
 * Resolves IMDb ids with limited concurrency to be polite to Letterboxd/TMDB.
 */
async function getWatchlistAsMetas(username, { tmdbApiKey, scraperApiKey, concurrency = 5 } = {}) {
  const opts = { scraperApiKey };
  const items = await getWatchlist(username, opts);
  const results = new Array(items.length);

  let index = 0;
  async function worker() {
    while (index < items.length) {
      const i = index++;
      const item = items[i];

      let imdbId = null;
      if (item.tmdbId && tmdbApiKey) {
        imdbId = await resolveImdbIdViaTmdb(item.tmdbId, item.tmdbType, tmdbApiKey);
      }
      if (!imdbId) {
        imdbId = await resolveImdbIdViaScrape(item.link, opts);
      }

      results[i] = {
        id: imdbId || `letterboxd:${slugFromLink(item.link)}`,
        type: 'movie',
        name: item.title,
        releaseInfo: item.year || undefined,
        poster: item.poster || undefined,
        // Stremio ignores unknown fields, this is just handy for debugging
        _letterboxdLink: item.link
      };
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker);
  await Promise.all(workers);

  return results;
}

function slugFromLink(link) {
  if (!link) return 'unknown';
  const match = link.match(/\/film\/([^/]+)\//);
  return match ? match[1] : 'unknown';
}

module.exports = {
  getWatchlist,
  getWatchlistAsMetas,
  fetchText
};
