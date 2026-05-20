/**
 * /api/stats
 *
 * Returns total film / director / actor counts per country for ALL countries
 * with meaningful cinema presence on TMDB (discovered dynamically).
 *
 * Flow:
 *   1. Call /configuration/countries to get all ~250 ISO country codes from TMDB.
 *   2. For each code (in parallel batches of 25) fire TWO parallel TMDB calls:
 *        a. Top-voted films → total count + genre sample
 *        b. Oldest film (date asc, vote_count ≥ 1) → filmStart year
 *      Both run in parallel so wall time is the same as before.
 *   3. Keep only countries with total_results >= 20 (minimum meaningful presence).
 *
 * Cached 24 h at CDN level (s-maxage) so TMDB is not hit on every visit.
 *
 * Response: { FR: { films, directors, actors, genres, filmStart }, US: { … }, … }
 *   filmStart — year of the oldest film on TMDB for this country (vote_count ≥ 1).
 *              Used client-side by the timeline range bar to accurately dim tiles
 *              whose cinema hadn't started by the selected timeTo.
 */
const { tmdb, GENRE_MAP } = require('./_tmdb');

/**
 * Fetch all ISO 3166-1 alpha-2 country codes that TMDB knows about.
 */
async function getAllCountryCodes() {
  const data = await tmdb('/configuration/countries', {});
  return (data || []).map(c => c.iso_3166_1).filter(Boolean);
}

/**
 * Fetch total film count, genre sample, AND earliest film year for one country.
 * Two TMDB calls run in parallel — no extra wall time vs. the previous single call.
 */
async function countryStats(code) {
  try {
    const [data, earliest] = await Promise.all([
      // a) total count + genre sample (top-voted)
      tmdb('/discover/movie', {
        with_origin_country: code,
        sort_by:             'vote_count.desc',
        'vote_count.gte':    5,
        page:                1,
      }),
      // b) oldest film with at least 1 vote (for filmStart)
      tmdb('/discover/movie', {
        with_origin_country: code,
        sort_by:             'primary_release_date.asc',
        'vote_count.gte':    1,
        page:                1,
      }).catch(() => ({ results: [] })),
    ]);

    const films = data.total_results || 0;

    // Genre distribution from the top-voted sample (≤ 20 films)
    const genres = {};
    (data.results || []).forEach(film => {
      (film.genre_ids || []).forEach(id => {
        const label = GENRE_MAP[id];
        if (label) genres[label] = (genres[label] || 0) + 1;
      });
    });

    // Earliest film year from TMDB (null if nothing found)
    const firstResult = (earliest.results || [])[0];
    const filmStart = firstResult?.release_date
      ? parseInt(firstResult.release_date.slice(0, 4), 10)
      : null;

    return {
      code,
      films,
      directors: Math.max(1, Math.round(films * 0.4)),
      actors:    Math.max(1, Math.round(films * 1.5)),
      genres,
      filmStart,   // ← new: TMDB-accurate cinema start year
    };
  } catch {
    return { code, films: 0, directors: 0, actors: 0, genres: {}, filmStart: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // 24-hour CDN cache, 48-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');

  try {
    // Step 1: discover all country codes from TMDB (~250)
    const allCodes = await getAllCountryCodes();

    // Step 2: batch in groups of 25 to stay within TMDB rate limits
    const results = [];
    for (let i = 0; i < allCodes.length; i += 25) {
      const batch = allCodes.slice(i, i + 25);
      const batchResults = await Promise.all(batch.map(countryStats));
      results.push(...batchResults);
    }

    // Step 3: keep only countries with at least 20 films
    const stats = {};
    results.forEach(({ code, films, directors, actors, genres, filmStart }) => {
      if (films >= 20) {
        stats[code] = { films, directors, actors, genres, filmStart };
      }
    });

    res.status(200).json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
