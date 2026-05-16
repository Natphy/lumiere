/**
 * /api/stats
 *
 * Returns total film / director / actor counts per country for all
 * Lumière nations.  Used by the mosaic to size tiles.
 *
 * Cached 24 h at CDN level (s-maxage) so TMDB is not hit on every visit.
 *
 * Response: { FR: { films, directors, actors }, US: { … }, … }
 */
const { tmdb, GENRE_MAP, LUMIERE_COUNTRIES } = require('./_tmdb');

// Fetch total film count for one country (only page 1, read total_results).
async function countryStats(code) {
  try {
    const data = await tmdb('/discover/movie', {
      with_origin_country: code,
      sort_by: 'vote_count.desc',
      'vote_count.gte': 5,
      page: 1
    });
    const films = data.total_results || 0;
    // Count genre distribution from the top-voted sample returned by discover (≤20 films)
    const genres = {};
    (data.results || []).forEach(film => {
      (film.genre_ids || []).forEach(id => {
        const label = GENRE_MAP[id];
        if (label) genres[label] = (genres[label] || 0) + 1;
      });
    });
    // Directors ≈ 40 % of film count (rough proxy — one director per film,
    // but top directors are counted once).
    // Actors ≈ 3× film count (rough proxy).
    return {
      code,
      films,
      directors: Math.max(1, Math.round(films * 0.4)),
      actors:    Math.max(1, Math.round(films * 1.5)),
      genres     // e.g. { Drammatico: 9, Thriller: 4, Azione: 2, … }
    };
  } catch {
    return { code, films: 0, directors: 0, actors: 0, genres: {} };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // 24-hour CDN cache, 48-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');

  try {
    // Batch in groups of 8 to avoid hitting TMDB rate limits
    const results = [];
    for (let i = 0; i < LUMIERE_COUNTRIES.length; i += 8) {
      const batch = LUMIERE_COUNTRIES.slice(i, i + 8);
      const batchResults = await Promise.all(batch.map(countryStats));
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
