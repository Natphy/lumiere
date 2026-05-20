/**
 * /api/films?country=XX&page=1&sort=desc|asc[&genre=Azione]
 *
 * sort=desc (default) → primary_release_date.desc  (dal più recente al più antico)
 * sort=asc            → primary_release_date.asc   (dal più antico al più recente — dal 1895)
 * genre               → Italian genre label (optional) — maps to TMDB with_genres ID
 *
 * Returns an enriched list of films with director + cast from credits.
 * Cached 1 h at CDN level.
 */
const { tmdb, mapGenre } = require('./_tmdb');

// Italian genre label → TMDB genre ID (for with_genres param)
const GENRE_ID_MAP = {
  'Azione':       28,
  'Avventura':    12,
  'Animazione':   16,
  'Commedia':     35,
  'Crimine':      80,
  'Documentario': 99,
  'Drammatico':   18,
  'Famiglia':     10751,
  'Fantasy':      14,
  'Storico':      36,
  'Horror':       27,
  'Musical':      10402,
  'Mistero':      9648,
  'Romantico':    10749,
  'Fantascienza': 878,
  'Thriller':     53,
  'Guerra':       10752,
  'Western':      37,
};

// Map client sort param → TMDB sort_by value
const SORT_MAP = {
  'desc': 'primary_release_date.desc',
  'asc' : 'primary_release_date.asc',
};

// Fetch director + top-5 actors for a film
async function getCredits(filmId) {
  try {
    const data = await tmdb(`/movie/${filmId}/credits`);
    const director = (data.crew || []).find(p => p.job === 'Director')?.name || null;
    const actors   = (data.cast || []).slice(0, 5).map(p => p.name);
    return { director, actors };
  } catch {
    return { director: null, actors: [] };
  }
}

// Fetch YouTube trailer (official trailer → teaser → any)
async function getTrailer(filmId) {
  try {
    const data    = await tmdb(`/movie/${filmId}/videos`, { language: 'it-IT' });
    const results = data.results || [];
    const pick =
      results.find(v => v.site === 'YouTube' && v.type === 'Trailer' && v.official) ||
      results.find(v => v.site === 'YouTube' && v.type === 'Teaser'  && v.official) ||
      results.find(v => v.site === 'YouTube');
    return pick ? `https://www.youtube.com/watch?v=${pick.key}` : null;
  } catch {
    return null;
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const country    = (req.query.country || 'FR').toUpperCase().slice(0, 2);
  const page       = Math.max(1, parseInt(req.query.page, 10) || 1);
  const sortDir    = req.query.sort === 'asc' ? 'asc' : 'desc';
  const tmdbSort   = SORT_MAP[sortDir];
  const genreLabel = req.query.genre || null;
  const genreId    = genreLabel ? (GENRE_ID_MAP[genreLabel] || null) : null;
  const decade     = req.query.decade ? parseInt(req.query.decade, 10) : null;
  // Optional timeline range filter passed by the client
  const dateFrom   = req.query.dateFrom ? parseInt(req.query.dateFrom, 10) : null;
  const dateTo     = req.query.dateTo   ? parseInt(req.query.dateTo,   10) : null;

  // Today's date as upper bound — ensures we never show future releases
  const today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
  const todayYear = parseInt(today.slice(0, 4), 10);

  // 1-hour CDN cache, 2-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  try {
    // Discover films for this country, ordered by release date
    const discoverParams = {
      with_origin_country: country,
      language:            'it-IT',
      sort_by:             tmdbSort,
      'vote_count.gte':    1,
      page,
    };
    if (genreId) discoverParams.with_genres = genreId; // genre filter (optional)
    if (decade) {
      // Decade filter: intersect [decade, decade+9] with optional date range, capped at today
      const gteYear = dateFrom ? Math.max(decade,     dateFrom) : decade;
      const lteYear = dateTo   ? Math.min(decade + 9, dateTo)   : decade + 9;
      discoverParams['primary_release_date.gte'] = `${gteYear}-01-01`;
      discoverParams['primary_release_date.lte'] =
        lteYear >= todayYear ? today : `${lteYear}-12-31`;
    } else if (dateFrom || dateTo) {
      // Timeline range filter only (no decade chip active)
      discoverParams['primary_release_date.gte'] = `${dateFrom || 1888}-01-01`;
      const toYear = dateTo || todayYear;
      discoverParams['primary_release_date.lte'] =
        toYear >= todayYear ? today : `${toYear}-12-31`;
    } else {
      discoverParams['primary_release_date.lte'] = today;        // no future releases
      discoverParams['primary_release_date.gte'] = '1888-01-01'; // from the dawn of cinema
    }

    const discover = await tmdb('/discover/movie', discoverParams);

    const raw = discover.results || [];

    // Enrich each film with credits (always) and trailer (page 1 only)
    const enriched = await Promise.all(
      raw.map(async f => {
        const [credits, trailer] = await Promise.all([
          getCredits(f.id),
          page === 1 ? getTrailer(f.id) : Promise.resolve(null),
        ]);

        const originalTitle = f.original_title || f.title;
        const italianTitle  = f.title;

        return {
          id:       `tmdb_${f.id}`,
          tmdbId:   f.id,
          title:    originalTitle,
          itTitle:  italianTitle !== originalTitle ? italianTitle : null,
          year:     f.release_date ? parseInt(f.release_date.slice(0, 4), 10) : null,
          country,
          genre:    mapGenre(f.genre_ids),
          director: credits.director,
          actors:   credits.actors,
          synopsis: f.overview || '',
          trailer,
          poster:   f.poster_path ? `https://image.tmdb.org/t/p/w300${f.poster_path}` : null,
          rating:   f.vote_average,
          votes:    f.vote_count,
        };
      })
    );

    res.status(200).json({
      page:         discover.page,
      totalPages:   Math.min(discover.total_pages, 500), // TMDB caps deep pagination at 500
      totalResults: discover.total_results,
      sortDir,
      films:        enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
