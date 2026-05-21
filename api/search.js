/**
 * /api/search?country=IT&q=Fantozzi&type=films|directors|actors
 *
 * Full-text TMDB search scoped to a specific origin country.
 * Used as fallback when the client-side search finds no results in the
 * already-loaded pages of a country tooltip.
 *
 * Films   → /search/movie?query=…  filtered by origin_country
 * People  → /search/person?query=… filtered by known_for films of that country
 *
 * Returns up to 10 results enriched with director + top-5 cast (for films)
 * or birth year + known-for titles (for people).
 *
 * Short CDN cache (5 min) so live searches stay fresh.
 */
const { tmdb, mapGenre } = require('./_tmdb');

// Fetch director + top-5 actors for a film
async function getCredits(filmId) {
  try {
    const data     = await tmdb(`/movie/${filmId}/credits`);
    const director = (data.crew || []).find(p => p.job === 'Director')?.name || null;
    const actors   = (data.cast || []).slice(0, 5).map(p => p.name);
    return { director, actors };
  } catch {
    return { director: null, actors: [] };
  }
}

// Fetch birth year + known-for titles for a person
async function getPersonDetail(personId) {
  try {
    const data = await tmdb(`/person/${personId}`, { language: 'it-IT' });
    return {
      born:       data.birthday ? parseInt(data.birthday.slice(0, 4), 10) : null,
      died:       data.deathday ? parseInt(data.deathday.slice(0, 4), 10) : null,
      bio:        (data.biography || '').slice(0, 400),
      profilePic: data.profile_path
                    ? `https://image.tmdb.org/t/p/w185${data.profile_path}`
                    : null,
    };
  } catch {
    return { born: null, died: null, bio: '', profilePic: null };
  }
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const country = (req.query.country || 'IT').toUpperCase().slice(0, 2);
  const q       = (req.query.q || '').trim();
  const type    = req.query.type || 'films';   // 'films' | 'directors' | 'actors'

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query troppo corta (min 2 caratteri)' });
  }

  // Short cache: search results should be reasonably fresh
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    if (type === 'films') {
      // ── Film search ──────────────────────────────────────────────────────
      const data = await tmdb('/search/movie', {
        query:    q,
        language: 'it-IT',
        page:     1,
      });

      // Filter to the requested origin country
      const raw = (data.results || [])
        .filter(f => (f.origin_country || []).includes(country)
                  || f.original_language === _langForCountry(country))
        .slice(0, 10);

      const enriched = await Promise.all(
        raw.map(async f => {
          const credits = await getCredits(f.id);
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
            trailer:  null,
            poster:   f.poster_path ? `https://image.tmdb.org/t/p/w300${f.poster_path}` : null,
            rating:   f.vote_average,
            votes:    f.vote_count,
          };
        })
      );

      return res.status(200).json({ type: 'films', country, query: q, results: enriched });

    } else {
      // ── Person search (directors or actors) ──────────────────────────────
      const data = await tmdb('/search/person', {
        query:    q,
        language: 'it-IT',
        page:     1,
      });

      // Keep people whose known_for films include at least one film from this country,
      // OR whose known_for_department matches
      const dept = type === 'directors' ? 'Directing' : 'Acting';

      const raw = (data.results || [])
        .filter(p => {
          if (p.known_for_department !== dept) return false;
          // Check known_for films for country match
          const kf = p.known_for || [];
          return kf.some(f =>
            (f.origin_country || []).includes(country) ||
            f.original_language === _langForCountry(country)
          );
        })
        .slice(0, 10);

      const enriched = await Promise.all(
        raw.map(async p => {
          const detail = await getPersonDetail(p.id);
          return {
            tmdbId:     p.id,
            name:       p.name,
            filmCount:  (p.known_for || []).length,
            knownFor:   (p.known_for || []).map(f => f.title || f.original_title).filter(Boolean),
            genre:      null,
            profilePic: p.profile_path
                          ? `https://image.tmdb.org/t/p/w185${p.profile_path}`
                          : null,
            ...detail,
          };
        })
      );

      return res.status(200).json({ type, country, query: q, results: enriched });
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Heuristic: map country code to primary TMDB original_language value.
 * Used as a fallback filter when origin_country is missing/empty in TMDB data.
 */
function _langForCountry(code) {
  const MAP = {
    IT:'it', FR:'fr', DE:'de', ES:'es', JP:'ja', KR:'ko',
    RU:'ru', PT:'pt', PL:'pl', SE:'sv', DK:'da', NO:'nb',
    HU:'hu', CZ:'cs', RO:'ro', HK:'zh', TW:'zh', CN:'zh',
    IR:'fa', IN:'hi', AR:'es', BR:'pt', AU:'en', NZ:'en',
    IE:'en', CA:'en', BE:'fr', AT:'de',
  };
  return MAP[code] || null;
}
