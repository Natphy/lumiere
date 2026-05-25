/**
 * /api/stats
 *
 * Returns total film / director / actor counts per country for the Lumière
 * country list (LUMIERE_COUNTRIES — 31 entries).
 *
 * Flow:
 *   1. Use LUMIERE_COUNTRIES directly — no need to fetch all ~250 TMDB codes.
 *   2. For each code (all in parallel) fire TWO parallel TMDB calls:
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
const { tmdb, GENRE_MAP, LUMIERE_COUNTRIES } = require('./_tmdb');

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch total film count, genre sample, AND earliest film year for one country.
 * Two TMDB calls run in parallel — no extra wall time vs. the previous single call.
 * On transient TMDB errors, retries once after 600 ms before giving up.
 */
async function countryStats(code, attempt = 0) {
  try {
    const [data, earliest] = await Promise.all([
      // a) total count + genre sample (all films with at least 1 vote)
      tmdb('/discover/movie', {
        with_origin_country: code,
        sort_by:             'vote_count.desc',
        'vote_count.gte':    1,
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

    // Director/actor estimates using a power-law formula — no artificial cap.
    // Calibrated against people.js output (which samples ~400 films per country):
    //   films^0.4 × 3   for directors  →  US≈290  IT≈200  KR≈135  small(100)≈19
    //   films^0.4 × 7.5 for actors     →  US≈720  IT≈500  KR≈335  small(100)≈47
    // The client replaces these with the exact navigable count on first tooltip open.
    const pow = Math.pow(films, 0.4);
    return {
      code,
      films,
      directors: Math.max(1, Math.round(pow * 3)),
      actors:    Math.max(1, Math.round(pow * 7.5)),
      genres,
      filmStart,
    };
  } catch {
    // Retry once after a short back-off (handles transient TMDB rate-limits)
    if (attempt === 0) {
      await sleep(600);
      return countryStats(code, 1);
    }
    return { code, films: 0, directors: 0, actors: 0, genres: {}, filmStart: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // 24-hour CDN cache, 48-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');

  try {
    // Step 1: fetch stats for all 31 Lumière countries in one parallel batch.
    // No need to discover country codes — we know exactly which ones we need.
    const results = await Promise.all(LUMIERE_COUNTRIES.map(countryStats));

    // Step 2: build stats map (threshold: ≥ 20 films)
    const statsMap = new Map();
    results.forEach(r => {
      if (r.films >= 20) statsMap.set(r.code, r);
    });

    // Step 3: safety net — retry any Lumière country that came back as 0 films.
    // These are major cinema nations; a 0 result is almost certainly a TMDB error.
    const missingLumiere = LUMIERE_COUNTRIES.filter(c => !statsMap.has(c));
    if (missingLumiere.length > 0) {
      // Sequential retries with 400 ms gap to avoid hammering TMDB
      for (const code of missingLumiere) {
        await sleep(400);
        const r = await countryStats(code, 0); // fresh attempt (retries internally)
        if (r.films >= 20) statsMap.set(r.code, r);
      }
    }

    const stats = {};
    statsMap.forEach((r, code) => {
      stats[code] = { films: r.films, directors: r.directors, actors: r.actors,
                      genres: r.genres, filmStart: r.filmStart };
    });

    res.status(200).json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
