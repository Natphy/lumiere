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
const { tmdb, GENRE_MAP, LUMIERE_COUNTRIES } = require('./_tmdb');

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

    // Stima del numero di registi e attori basata sul campionamento di people.js:
    // people.js analizza fino a 220 film unici (5+3+3 pagine), poi aggrega i crediti.
    // Con sovrapposizione tipica (~55% unici per registi, ~85% per attori)
    // il risultato è capped a MAX_PEOPLE=200.
    const sampleSize = Math.min(220, films);
    return {
      code,
      films,
      directors: Math.min(200, Math.max(1, Math.round(sampleSize * 0.55))),
      actors:    Math.min(200, Math.max(1, Math.round(sampleSize * 0.85))),
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
    // Step 1: discover all country codes from TMDB (~250)
    const allCodes = await getAllCountryCodes();

    // Step 2: batch in groups of 25 to stay within TMDB rate limits
    const results = [];
    for (let i = 0; i < allCodes.length; i += 25) {
      const batch = allCodes.slice(i, i + 25);
      const batchResults = await Promise.all(batch.map(countryStats));
      results.push(...batchResults);
    }

    // Step 3: build initial stats map (threshold: ≥ 20 films)
    const statsMap = new Map();
    results.forEach(r => {
      if (r.films >= 20) statsMap.set(r.code, r);
    });

    // Step 4: safety net — retry any Lumière country that came back as 0 films.
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
