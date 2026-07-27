const cheerio = require('cheerio');
const cache = require('./cache');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const WATCHLIST_TTL_MS = 60 * 60 * 1000; // 1 hour (grid pages cost real ScraperAPI credits, so cache longer than the old RSS-based 15 min)
const FILM_PAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (imdb id for a film never changes)
const MAX_PAGES = 10; // safety cap: 10 pages * ~100 items = up to ~1000 watchlist entries

// Cloudflare serves its "Just a moment..." JS-challenge interstitial with a
// normal-looking HTTP status (often 200 from proxies that just relay it), so
// checking res.ok alone isn't enough. But we have to be careful here: normal,
// successfully-loaded Cloudflare-protected pages ALSO embed a bot-management
// beacon script (referencing cdn-cgi/challenge-platform) even when nothing
// was blocked — so matching on that alone gives false positives. The
// specific "Just a moment" interstitial title is a much more reliable
// signal that we actually got the block page instead of real content.
function isCloudflareChallenge(body) {
  return typeof body === 'string' && /<title>\s*Just a moment/i.test(body);
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
//
// BUGFIX: the old version ran these candidate selectors against the whole
// document. Letterboxd re-uses the exact same poster component (and the
// same data-target-link / data-item-link / href="/film/..." attributes) for
// "Recommended for you", "Popular this week", and similar widgets elsewhere
// on the watchlist page — so an unscoped selector picks those up too (e.g.
// 'Angry Birds' from a Recommended widget, not the actual watchlist). We fix
// this with two independent layers of defense, since we can't script-fetch
// letterboxd.com from here to pin down the exact current class names:
//   1. Strip out any element that looks like a non-watchlist widget/sidebar
//      *before* running any selector, so those links can never match.
//   2. Additionally try to scope the search to the actual watchlist grid
//      container, if we can find one, instead of the whole (cleaned) body.
function parsePosterGridItems(html) {
  const $ = cheerio.load(html);

  // Layer 1: remove anything that looks like a recommendation/trending/
  // "you might also like" widget, or a page sidebar in general. Widgets like
  // this are what leaked 'Angry Birds' into the watchlist result.
  const widgetSelectors = [
    'aside',
    '.sidebar',
    '.side-panel',
    '[class*="recommend" i]',
    '[id*="recommend" i]',
    '[class*="trending" i]',
    '[id*="trending" i]',
    '[class*="popular" i]',
    '[class*="similar" i]',
    '[class*="related" i]',
    '.watchlist-recommendations',
    '.js-related-films-widget'
  ];
  $(widgetSelectors.join(', ')).remove();

  // Layer 2: prefer a selector scoped to the actual watchlist grid container
  // if one of these matches; otherwise fall back to the (already-cleaned)
  // whole document so we don't silently return zero results if Letterboxd's
  // container markup has changed.
  const containerSelectors = [
    '.s-watchlist-content',
    '#watchlist-films',
    '.watchlist-list',
    'ul.poster-list',
    '#content'
  ];
  let $scope = $('body');
  for (const containerSelector of containerSelectors) {
    const container = $(containerSelector).first();
    if (container.length) {
      $scope = container;
      break;
    }
  }

  const results = [];
  const seen = new Set();

  const candidateSelectors = [
    '[data-target-link^="/film/"]',
    '[data-item-link^="/film/"]',
    'li.poster-container div[data-film-slug]',
    'a[href^="/film/"]'
  ];

  for (const selector of candidateSelectors) {
    $scope.find(selector).each((_, el) => {
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

// Letterboxd's pagination control (bottom of the grid) only renders a "Next"
// link/button when another page actually exists. Checking for that is a
// better signal than "did this page have any items", because a single
// glitched/rate-limited fetch that comes back with 0 parsed items (but isn't
// actually the last page) would otherwise make getWatchlist() stop early and
// silently under-report someone's watchlist — a bigger problem the larger
// the list is (i.e. exactly the 60+ movie case you're worried about).
function hasNextPageLink(html) {
  if (typeof html !== 'string') return false;
  return (
    /class="[^"]*\bnext\b[^"]*"[^>]*href="[^"]*\/watchlist\/page\//i.test(html) ||
    /rel="next"/i.test(html)
  );
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
  // Trust an explicit "next page" link over a bare item count. Fall back to
  // "this page had items" only if we can't find a pagination control at all
  // (e.g. watchlists small enough to fit on one page have no pager markup).
  const nextLinkFound = hasNextPageLink(html);
  return {
    items,
    hasNextPage: nextLinkFound || (items.length > 0 && !/paginate-nextprev|pagination/i.test(html)),
    rawHtmlSnippet: html.slice(0, 500)
  };
}

/**
 * Fetch the full watchlist (all pages) for a username, using the cache.
 * Retries a single failed/empty page once before giving up on it, so a
 * transient blip mid-pagination doesn't truncate the list — this matters
 * most for larger (60+) watchlists that span several pages.
 */
async function getWatchlist(username, opts = {}) {
  const cacheKey = `watchlist:${username.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const allItems = [];
  const pageDebug = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    let { items, hasNextPage } = await fetchWatchlistPage(username, page, opts);

    // Guard against a transient glitch (rate limit, blip through the proxy)
    // masquerading as "watchlist ended here". If a page unexpectedly comes
    // back empty after a prior page had a full page's worth of items, retry
    // it once before trusting the empty result.
    if (items.length === 0 && page > 1 && allItems.length > 0) {
      const retry = await fetchWatchlistPage(username, page, opts);
      items = retry.items;
      hasNextPage = retry.hasNextPage;
    }

    pageDebug.push({ page, itemCount: items.length, hasNextPage });
    allItems.push(...items);
    if (!hasNextPage || items.length === 0) break;
  }

  // Watchlist grid pages cost real ScraperAPI credits (premium=true is
  // required for Letterboxd), so we cache longer than the old 15-minute RSS
  // TTL to avoid burning through the free tier on every Stremio refresh.
  cache.set(cacheKey, allItems, WATCHLIST_TTL_MS);
  allItems._pageDebug = pageDebug; // non-enumerable-ish extra, ignored by JSON consumers that don't look for it
  return allItems;
}

/**
 * Resolve film details (imdb id, year, poster) via TMDB's search API.
 * Free, reliable, no scraping — this is the preferred path whenever a TMDB
 * API key is configured, since it avoids extra ScraperAPI-billed requests.
 */
function normalizeTitleForMatch(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents (e.g. Anaïs -> anais)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Picks the TMDB search result that actually matches the title we searched
// for, instead of blindly trusting whatever TMDB ranks first.
//
// BUGFIX: TMDB's /search/movie ranks by text relevance *and* popularity, not
// exact title match — so a low-profile film can get outranked by an
// unrelated but far more popular one that shares a word (e.g. searching
// "The Birds" (1963) was returning "The Angry Birds Movie" as the top hit,
// and "Twin Peaks: The Return" — a TV series with no real movie match —
// was returning some unrelated low-relevance movie as data.results[0]).
// We only accept a TMDB match if a result's title equals the query
// (normalized), so we never swap in a completely different film.
// `kind` is 'movie' (uses .title/.original_title) or 'tv' (uses .name/.original_name).
function pickMatchingTmdbResult(results, queriedTitle, kind = 'movie') {
  if (!results || results.length === 0) return null;
  const target = normalizeTitleForMatch(queriedTitle);
  const nameField = kind === 'tv' ? 'name' : 'title';
  const originalField = kind === 'tv' ? 'original_name' : 'original_title';
  const exact = results.find((r) => normalizeTitleForMatch(r[nameField]) === target);
  if (exact) return exact;
  const exactOriginal = results.find((r) => normalizeTitleForMatch(r[originalField]) === target);
  if (exactOriginal) return exactOriginal;
  // No confident match — better to return nothing here and let the caller
  // fall back to scraping the actual Letterboxd film page (which is tied to
  // the real /film/<slug>/ link we already have, so it can't be wrong in
  // this way) than to guess and risk substituting an unrelated film.
  return null;
}

async function searchTmdb(kind, title, tmdbApiKey) {
  const endpoint = kind === 'tv' ? 'search/tv' : 'search/movie';
  const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${tmdbApiKey}&query=${encodeURIComponent(title)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TMDB ${kind} search failed: ${res.status}`);
  const data = await res.json();
  return data.results || [];
}

// Authoritative movie-vs-series check, by ID rather than by title text.
//
// BUGFIX: resolveDetailsViaTmdb() decides movie vs. series by *title
// matching* (movie search first, then tv search, keeping whichever one
// exact-matches). That's fragile — if Letterboxd's title for an entry
// doesn't come back as an exact normalized match on the movie search (or
// on the tv search), we fall through to the plain Letterboxd-page scrape,
// which has no way to know the content type at all and silently defaults
// to 'movie' even when the imdb id it finds actually belongs to a TV
// series. This is why "no stream found" happened for real TV shows: the
// addon told Stremio type=movie for an id that every stream addon has
// indexed as a series.
//
// TMDB's /find endpoint looks up a title by external id (the imdb id we
// already have, from either the search-with-external_ids path or the
// scrape-fallback path) and tells us definitively which bucket it's in
// (movie_results vs tv_results) — no fuzzy text matching involved. We use
// this to confirm/correct the type for ANY item where we ended up with an
// imdb id and a TMDB key, regardless of which path resolved that id.
async function confirmTypeViaImdbId(imdbId, tmdbApiKey) {
  if (!imdbId || !tmdbApiKey) return null;
  const cacheKey = `tmdb-find:${imdbId}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    let type = null;
    if (data.tv_results && data.tv_results.length > 0) type = 'series';
    else if (data.movie_results && data.movie_results.length > 0) type = 'movie';
    cache.set(cacheKey, type, FILM_PAGE_TTL_MS);
    return type;
  } catch (err) {
    return null;
  }
}

// Resolves a Letterboxd watchlist title to real film/series details via
// TMDB. Returns { type: 'movie'|'series', imdbId, title, year, poster } or
// null if nothing matched confidently.
//
// Letterboxd itself only has one content type ("films"), but people log
// certain TV works there too — usually prestige limited series like "Twin
// Peaks: The Return" — as if they were films. TMDB correctly categorizes
// those as TV, so a movie-only search finds no confident match for them. We
// try TV as a second pass before giving up, so these come back as a Stremio
// series instead of silently falling through to the movie-only scrape path.
async function resolveDetailsViaTmdb(title, tmdbApiKey) {
  if (!title || !tmdbApiKey) return null;
  const cacheKey = `tmdb-search:${title.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const movieResults = await searchTmdb('movie', title, tmdbApiKey);
    let best = pickMatchingTmdbResult(movieResults, title, 'movie');
    let kind = 'movie';

    if (!best) {
      const tvResults = await searchTmdb('tv', title, tmdbApiKey);
      best = pickMatchingTmdbResult(tvResults, title, 'tv');
      kind = 'tv';
    }

    if (!best) {
      cache.set(cacheKey, null, FILM_PAGE_TTL_MS);
      return null;
    }

    let imdbId = null;
    try {
      const extRes = await fetch(`https://api.themoviedb.org/3/${kind}/${best.id}/external_ids?api_key=${tmdbApiKey}`);
      if (extRes.ok) {
        const extData = await extRes.json();
        imdbId = extData.imdb_id || null;
      }
    } catch (err) {
      // Non-fatal — we can still return TMDB's own title/year/poster.
    }

    const dateField = kind === 'tv' ? best.first_air_date : best.release_date;
    const details = {
      type: kind === 'tv' ? 'series' : 'movie',
      imdbId,
      title: (kind === 'tv' ? best.name : best.title) || title,
      year: dateField ? dateField.slice(0, 4) : null,
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
      // Title-match result is only a first guess now — see confirmTypeViaImdbId
      // below, which overrides this with an authoritative ID-based check
      // whenever possible. Default to 'movie' only if we never get any
      // confirmation either way.
      let type = (details && details.type) || 'movie';
      if (!details || !details.imdbId) {
        const scraped = await resolveDetailsViaScrape(item.link, opts);
        details = {
          imdbId: (details && details.imdbId) || (scraped && scraped.imdbId) || null,
          title: (details && details.title) || (scraped && scraped.title) || item.title,
          year: (details && details.year) || (scraped && scraped.year) || null,
          poster: (details && details.poster) || (scraped && scraped.poster) || null
        };
      }

      // Confirm/correct the type by ID rather than trusting the earlier
      // title-based guess — this is what actually fixes "TV shows get
      // treated as movies". Runs whenever we have both an imdb id and a
      // TMDB key, even if resolveDetailsViaTmdb() already set a type, since
      // that guess could itself be wrong in edge cases (e.g. a movie and a
      // series sharing an exact title).
      if (details.imdbId && tmdbApiKey) {
        const confirmedType = await confirmTypeViaImdbId(details.imdbId, tmdbApiKey);
        if (confirmedType) type = confirmedType;
      }

      results[i] = {
        id: details.imdbId || `letterboxd:${slugFromLink(item.link)}`,
        type,
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
  parsePosterGridItems,
  pickMatchingTmdbResult,
  normalizeTitleForMatch
};
