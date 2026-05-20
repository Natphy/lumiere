/**
 * /api/stats-range
 *
 * Returns film / director / actor counts per country for a given date range.
 * Called by the client whenever the timeline handles are released on a non-full range.
 *
 * Query params:
 *   from  — start year (e.g. 1960)
 *   to    — end year   (e.g. 1980)
 *   codes — comma-separated ISO codes of the countries to query
 *           (client passes only the codes already known from /api/stats)
 *
 * TMDB filter used:
 *   primary_release_date.gte = from-01-01
 *   primary_release_date.lte = to-12-31
 *   vote_count.gte = 1  (include all films with at least one vote)
 *
 * Response: { FR: { films, directors, actors, genres }, US: { … }, … }
 * Directors and actors are derived from the film count (same ratio as /api/stats).
 * A country with 0 films in the range returns { films:0, directors:0, actors:0 }.
 *
 * Cache: 1 h CDN (s-maxage) — range queries are dynamic but data changes rarely.
 */
const { tmdb, GENRE_MAP } = require('./_tmdb');

async function countryStatsRange(code, from, to) {
  try {
    const data = await tmdb('/discover/movie', {
      with_origin_country:        code,
      sort_by:                    'vote_count.desc',
      'vote_count.gte':           1,
      'primary_release_date.gte': `${from}-01-01`,
      'primary_release_date.lte': `${to}-12-31`,
      page:                       1,
    });

    const films = data.total_results || 0;

    const genres = {};
    (data.results || []).forEach(film => {
      (film.genre_ids || []).forEach(id => {
        const label = GENRE_MAP[id];
        if (label) genres[label] = (genres[label] || 0) + 1;
      });
    });

    return {
      code,
      films,
      directors: films > 0 ? Math.max(1, Math.round(films * 0.4)) : 0,
      actors:    films > 0 ? Math.max(1, Math.round(films * 1.5)) : 0,
      genres,
    };
  } catch {
    return { code, films: 0, directors: 0, actors: 0, genres: {} };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // 1-hour CDN cache (range results don't change frequently)
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  const { from, to, codes } = req.query;
  const fromYear = parseInt(from, 10);
  const toYear   = parseInt(to,   10);

  if (!fromYear || !toYear || fromYear > toYear) {
    return res.status(400).json({ error: 'Invalid or missing from/to parameters' });
  }

  const codeList = (codes || '').split(',').map(c => c.trim()).filter(Boolean);
  if (!codeList.length) {
    return res.status(400).json({ error: 'No country codes provided' });
  }

  try {
    const results = [];
    // Batch in groups of 15 to respect TMDB rate limits
    for (let i = 0; i < codeList.length; i += 15) {
      const batch = codeList.slice(i, i + 15);
      const batchResults = await Promise.all(batch.map(c => countryStatsRange(c, fromYear, toYear)));
      results.push(...batchResults);
    }

    const stats = {};
    results.forEach(({ code, films, directors, actors, genres }) => {
      stats[code] = { films, directors, actors, genres };
    });

    res.status(200).json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
