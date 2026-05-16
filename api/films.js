/**
 * /api/films?country=XX&page=1&sort=desc|asc
 *
 * sort=desc (default) → primary_release_date.desc  (dal più recente al più antico)
 * sort=asc            → primary_release_date.asc   (dal più antico al più recente — dal 1895)
 *
 * Returns an enriched list of films with director + cast from credits.
 * Cached 1 h at CDN level.
 */
const { tmdb, mapGenre } = require('./_tmdb');

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

  const country  = (req.query.country || 'FR').toUpperCase().slice(0, 2);
  const page     = Math.max(1, parseInt(req.query.page, 10) || 1);
  const sortDir  = req.query.sort === 'asc' ? 'asc' : 'desc';
  const tmdbSort = SORT_MAP[sortDir];

  // Today's date as upper bound — ensures we never show future releases
  const today = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD

  // 1-hour CDN cache, 2-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  try {
    // Discover films for this country, ordered by release date
    const discover = await tmdb('/discover/movie', {
      with_origin_country:         country,
      language:                    'it-IT',
      sort_by:                     tmdbSort,
      'vote_count.gte':            2,           // low threshold: include classic/art-house films
      'primary_release_date.lte':  today,       // no future releases
      'primary_release_date.gte':  '1888-01-01',// from the very dawn of cinema
      page,
    });

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
