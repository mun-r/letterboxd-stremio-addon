const cheerio = require('cheerio');
const cache = require('./cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const WATCHLIST_TTL_MS = 60 * 60 * 1000; // 1 hour (grid pages cost real ScraperAPI credits, so cache longer than the old RSS-based 15 min)
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

// Letterboxd does NOT provide an RSS feed for watchlists (only for the
// diary/activity feed at /username/rss/), and watchlist pages hydrate their
// poster grid client-side. In practice, though, the film title + link for
// each watchlist entry IS present in the server-rendered HTML (only the
// poster *image* is lazy-loaded) — so a plain HTML fetch (no expensive
// render=true needed) is enough to build the list. We resolve poster/year/
// imdb id per-film afterwards, preferring TMDB (free, no scraping needed)
// and falling back to scraping the film's own Letterboxd page.
//
// Because Letterboxd's markup can change over time, we try several
// candidate selectors/attributes rather than hard-coding one.
function parsePosterGridItems(html) {
  const $ = cheerio.load(html);
  const results = [];
  const seen = new Set();

  const candidateSelectors = [
    '[data-target-link^="/film/"]',
    '[data-item-link^="/film/"]',
    'li.poster-container div[data-film-slug]',
    'a[href^="/film/"]'
  ];

  for (const selector of candidateSelectors) {
    $(selector).each((_, el) => {
      const node = $(el);
      let link = node.attr('data-target-link') || node.attr('data-item-link') || node.attr('href');
      if (!link || !link.startsWith('/film/')) return;
      if (seen.has(link)) return;
      seen.add(link);

      const img = node.is('img') ? node : node.find('img').first();
      const title = (img.attr('alt') || node.attr('data-item-name') || node.attr('data-film-name') || '').trim();
      const filmId = node.attr('data-film-id') || null;

      results.push({
        title: title || null,
        link: `https://letterboxd.com${link}`,
        filmId
      });
    });
    if (results.length > 0) break; // stop at the first selector that actually matched something
  }

  return results;
}

/**
 * Pull one page of a user's watchlist (HTML grid page, not RSS).
 * Returns { items, hasNextPage, rawHtmlSnippet } — rawHtmlSnippet is only
 * for diagnostics when items comes back empty unexpectedly.
 */
async function fetchWatchlistPage(username, page, opts) {
  const url =
    page > 1
      ? `https://letterboxd.com/${encodeURIComponent(username)}/watchlist/page/${page}/`
      : `https://letterboxd.com/${encodeURIComponent(username)}/watchlist/`;
  const html = await fetchText(url, opts);
  const items = parsePosterGridItems(html);
  return { items, hasNextPage: items.length > 0, rawHtmlSnippet: html.slice(0, 500) };
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

  // Watchlist grid pages cost real ScraperAPI credits (premium=true is
  // required for Letterboxd), so we cache longer than the old 15-minute RSS
  // TTL to avoid burning through the free tier on every Stremio refresh.
  cache.set(cacheKey, allItems, WATCHLIST_TTL_MS);
  return allItems;
}

/**
 * Resolve film details (imdb id, year, poster) via TMDB's search API.
 * Free, reliable, no scraping — this is the preferred path whenever a TMDB
 * API key is configured, since it avoids extra ScraperAPI-billed requests.
 */
async function resolveDetailsViaTmdb(title, tmdbApiKey) {
  if (!title || !tmdbApiKey) return null;
  const cacheKey = `tmdb-search:${title.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${tmdbApiKey}&query=${encodeURIComponent(title)}`;
    const res = await fetch(searchUrl);
    if (!res.ok) throw new Error(`TMDB search failed: ${res.status}`);
    const data = await res.json();
    const best = data.results && data.results[0];
    if (!best) {
      cache.set(cacheKey, null, FILM_PAGE_TTL_MS);
      return null;
    }

    let imdbId = null;
    try {
      const extRes = await fetch(`https://api.themoviedb.org/3/movie/${best.id}/external_ids?api_key=${tmdbApiKey}`);
      if (extRes.ok) {
        const extData = await extRes.json();
        imdbId = extData.imdb_id || null;
      }
    } catch (err) {
      // Non-fatal — we can still return TMDB's own title/year/poster.
    }

    const details = {
      imdbId,
      title: best.title || title,
      year: best.release_date ? best.release_date.slice(0, 4) : null,
      poster: best.poster_path ? `https://image.tmdb.org/t/p/w500${best.poster_path}` : null
    };
    cache.set(cacheKey, details, FILM_PAGE_TTL_MS);
    return details;
  } catch (err) {
    return null;
  }
}

/**
 * Fallback: scrape the Letterboxd film page directly for imdb id / year /
 * poster (via its <meta> tags). Used when no TMDB API key is configured, or
 * the TMDB search didn't turn up a confident match.
 */
async function resolveDetailsViaScrape(filmUrl, opts) {
  if (!filmUrl) return null;
  const cacheKey = `scrape-details:${filmUrl}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const html = await fetchText(filmUrl, opts);

    const imdbMatch = html.match(/imdb\.com\/title\/(tt\d+)/);
    const imdbId = imdbMatch ? imdbMatch[1] : null;

    const posterMatch = html.match(/<meta property="og:image" content="([^"]+)"/);
    const poster = posterMatch ? posterMatch[1] : null;

    const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
    let title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : null;
    let year = null;
    if (title) {
      const yearMatch = title.match(/\((\d{4})\)\s*$/);
      if (yearMatch) {
        year = yearMatch[1];
        title = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      }
    }
    if (!year) {
      const ldYearMatch = html.match(/"datePublished"\s*:\s*"(\d{4})/);
      if (ldYearMatch) year = ldYearMatch[1];
    }

    const details = { imdbId, poster, title, year };
    cache.set(cacheKey, details, FILM_PAGE_TTL_MS);
    return details;
  } catch (err) {
    return null;
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Build Stremio catalog "meta preview" objects for a user's watchlist.
 * Resolves IMDb ids/posters/years with limited concurrency, preferring TMDB
 * (free) and falling back to scraping each film's Letterboxd page.
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

      let details = null;
      if (tmdbApiKey && item.title) {
        details = await resolveDetailsViaTmdb(item.title, tmdbApiKey);
      }
      if (!details || !details.imdbId) {
        const scraped = await resolveDetailsViaScrape(item.link, opts);
        details = {
          imdbId: (details && details.imdbId) || (scraped && scraped.imdbId) || null,
          title: (details && details.title) || (scraped && scraped.title) || item.title,
          year: (details && details.year) || (scraped && scraped.year) || null,
          poster: (details && details.poster) || (scraped && scraped.poster) || null
        };
      }

      results[i] = {
        id: details.imdbId || `letterboxd:${slugFromLink(item.link)}`,
        type: 'movie',
        name: details.title || item.title || 'Unknown',
        releaseInfo: details.year || undefined,
        poster: details.poster || undefined,
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
  fetchText,
  fetchWatchlistPage,
  parsePosterGridItems
};
