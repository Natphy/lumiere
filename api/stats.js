/**
 * /api/stats
 *
 * Returns total film / director / actor counts per country for ALL countries
 * with meaningful cinema presence on TMDB (discovered dynamically).
 *
 * Flow:
 *   1. Call /configuration/countries to get all ~250 ISO country codes from TMDB.
 *   2. For each code (in parallel batches of 25) call /discover/movie to get
 *      film count + genre sample.
 *   3. Keep only countries with total_results >= 20 (minimum meaningful presence).
 *
 * Cached 24 h at CDN level (s-maxage) so TMDB is not hit on every visit.
 *
 * Response: { FR: { films, directors, actors, genres }, US: { … }, … }
 */
const { tmdb, GENRE_MAP } = require('./_tmdb');

/**
 * Fetch all ISO 3166-1 alpha-2 country codes that TMDB knows about.
 * Returns an array of strings like ['AD','AE','AF', …] (~250 entries).
 */
async function getAllCountryCodes() {
  const data = await tmdb('/configuration/countries', {});
  return (data || []).map(c => c.iso_3166_1).filter(Boolean);
}

// Fetch total film count + genre distribution for one country (only page 1).
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
    // Actors ≈ 1.5× film count (rough proxy).
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
    // Step 1: discover all country codes from TMDB (~250)
    const allCodes = await getAllCountryCodes();

    // Step 2: batch in groups of 25 to stay comfortably within TMDB rate limits
    // (TMDB allows ~40 req/s; 25 parallel calls leave headroom for retries and
    //  the initial /configuration/countries call).
    const results = [];
    for (let i = 0; i < allCodes.length; i += 25) {
      const batch = allCodes.slice(i, i + 25);
      const batchResults = await Promise.all(batch.map(countryStats));
      results.push(...batchResults);
    }

    // Step 3: keep only countries with at least 20 films — below this threshold
    // the data is too sparse to be meaningful in the mosaic UI.
    const stats = {};
    results.forEach(({ code, films, directors, actors, genres }) => {
      if (films >= 20) {
        stats[code] = { films, directors, actors, genres };
      }
    });

    res.status(200).json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
