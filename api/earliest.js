/**
 * /api/earliest
 *
 * Returns the earliest relevant year for each Lumière mode:
 *   films     → release year of the oldest film on TMDB with vote_count ≥ 5
 *   directors → birth year of the oldest director found in the credits of
 *               the 4 oldest films
 *   actors    → birth year of the oldest actor found in those same credits
 *
 * Response: { films: YYYY, directors: YYYY, actors: YYYY }
 * Cached 24 h at CDN level; expensive TMDB calls happen at most once per day.
 */
const { tmdb } = require('./_tmdb');

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  res.setHeader('Cache-Control', 's-maxage=86400, stale-while-revalidate=172800');

  // Fallback values in case TMDB calls fail
  const FALLBACK = { films: 1895, directors: 1874, actors: 1875 };

  try {
    // ── Step 1: find globally oldest films (by release date, vote_count ≥ 5) ──
    const discoverData = await tmdb('/discover/movie', {
      sort_by:          'primary_release_date.asc',
      'vote_count.gte': 5,
      page:             1,
    });

    const results = discoverData.results || [];
    if (!results.length) return res.status(200).json(FALLBACK);

    // Earliest film year
    const filmsYear = results[0].release_date
      ? parseInt(results[0].release_date.slice(0, 4), 10)
      : FALLBACK.films;

    // ── Step 2: fetch credits for the 4 oldest films ──
    const filmIds = results.slice(0, 4).map(f => f.id);
    const creditsArr = await Promise.all(
      filmIds.map(id =>
        tmdb(`/movie/${id}/credits`)
          .then(d => ({ crew: d.crew || [], cast: d.cast || [] }))
          .catch(() => ({ crew: [], cast: [] }))
      )
    );

    // Collect unique person IDs for directors and actors
    const directorIds = new Set();
    const actorIds    = new Set();
    creditsArr.forEach(({ crew, cast }) => {
      crew.filter(p => p.job === 'Director').forEach(p => { if (p.id) directorIds.add(p.id); });
      cast.slice(0, 6).forEach(p => { if (p.id) actorIds.add(p.id); });
    });

    // ── Step 3: fetch birth years for each unique person ──
    const fetchBirth = id =>
      tmdb(`/person/${id}`)
        .then(d => d.birthday ? parseInt(d.birthday.slice(0, 4), 10) : null)
        .catch(() => null);

    const [dirBirths, actBirths] = await Promise.all([
      Promise.all([...directorIds].map(fetchBirth)),
      Promise.all([...actorIds].map(fetchBirth)),
    ]);

    const validYear = y => Number.isFinite(y) && y > 1800 && y < 2000;

    const dirYears  = dirBirths.filter(validYear);
    const actYears  = actBirths.filter(validYear);

    const directorsYear = dirYears.length ? Math.min(...dirYears) : FALLBACK.directors;
    const actorsYear    = actYears.length ? Math.min(...actYears) : FALLBACK.actors;

    res.status(200).json({
      films:     filmsYear,
      directors: directorsYear,
      actors:    actorsYear,
    });
  } catch (err) {
    res.status(200).json(FALLBACK);
  }
};
