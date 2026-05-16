/**
 * /api/films?country=XX&page=1&sort=vote_count.desc
 *
 * Returns an enriched list of films for the given country, fetching
 * credits (director + top cast) for each film in parallel.
 *
 * Cached 1 h at CDN level.
 *
 * Response:
 * {
 *   page, totalPages, totalResults,
 *   films: [{ id, tmdbId, title, itTitle, year, country, genre,
 *             director, actors, synopsis, trailer, poster, rating }]
 * }
 */
const { tmdb, mapGenre } = require('./_tmdb');

// Fetch credits for a single film and extract director + top-5 actors.
async function getCredits(filmId) {
  try {
    const data = await tmdb(`/movie/${filmId}/credits`);
    const crew  = data.crew  || [];
    const cast  = data.cast  || [];

    const director = crew.find(p => p.job === 'Director')?.name || null;
    const actors   = cast.slice(0, 5).map(p => p.name);

    return { director, actors };
  } catch {
    return { director: null, actors: [] };
  }
}

// Fetch YouTube trailer key for a film (first official trailer or teaser).
async function getTrailer(filmId) {
  try {
    const data    = await tmdb(`/movie/${filmId}/videos`, { language: 'it-IT' });
    const results = data.results || [];

    // Prefer official trailer → teaser → any YouTube video
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

  const country = (req.query.country || 'FR').toUpperCase().slice(0, 2);
  const page    = Math.max(1, parseInt(req.query.page, 10) || 1);
  const sort    = req.query.sort || 'vote_count.desc';

  // 1-hour CDN cache, 2-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  try {
    // Step 1: discover top films for this country (language=it-IT gives us
    // Italian title in `title`, original title always in `original_title`)
    const discover = await tmdb('/discover/movie', {
      with_origin_country: country,
      language: 'it-IT',
      sort_by: sort,
      'vote_count.gte': 5,
      page
    });

    const raw = discover.results || [];

    // Step 2: fetch credits + trailers in parallel for each film
    const enriched = await Promise.all(
      raw.map(async f => {
        const [credits, trailer] = await Promise.all([
          getCredits(f.id),
          page === 1 ? getTrailer(f.id) : Promise.resolve(null)  // trailers only on first page
        ]);

        const originalTitle = f.original_title || f.title;
        const italianTitle  = f.title;

        return {
          id:        `tmdb_${f.id}`,
          tmdbId:    f.id,
          title:     originalTitle,
          itTitle:   italianTitle !== originalTitle ? italianTitle : null,
          year:      f.release_date ? parseInt(f.release_date.slice(0, 4), 10) : null,
          country,
          genre:     mapGenre(f.genre_ids),
          director:  credits.director,
          actors:    credits.actors,
          synopsis:  f.overview || '',
          trailer,
          poster:    f.poster_path
                       ? `https://image.tmdb.org/t/p/w300${f.poster_path}`
                       : null,
          rating:    f.vote_average,
          votes:     f.vote_count
        };
      })
    );

    res.status(200).json({
      page:         discover.page,
      totalPages:   discover.total_pages,
      totalResults: discover.total_results,
      films:        enriched
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
