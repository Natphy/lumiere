/**
 * /api/search?country=IT&q=Fantozzi&type=films|directors|actors
 *
 * Full-text TMDB search scoped to a specific origin country.
 * Used as fallback when the client-side search finds no results in the
 * already-loaded pages of a country tooltip.
 *
 * ── Films ───────────────────────────────────────────────────────────────────
 * Two parallel strategies, results merged and deduplicated:
 *
 *   A) Title search  — /search/movie?query=… (pages 1–3)
 *      filtered post-fetch by origin_country / original_language.
 *      Finds films whose title matches the query.
 *
 *   B) Person→Film   — /search/person?query=…
 *      Takes the first matching director/actor, then:
 *        director → /discover/movie?with_origin_country=XX&with_crew=<id>
 *        actor    → /discover/movie?with_origin_country=XX&with_cast=<id>
 *      Finds every film from that country made by / starring that person.
 *      Typing "Monicelli" in the Italy films tab returns his full filmography.
 *
 * ── People (directors / actors) ─────────────────────────────────────────────
 *   /search/person?query=… filtered by known_for_department.
 *   known_for=[] is accepted (older/less-prominent artists on TMDB).
 *
 * CDN cache: 5 min (search results should stay reasonably fresh).
 */
const { tmdb, mapGenres } = require('./_tmdb');

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      birthPlace: data.place_of_birth || null,
    };
  } catch {
    return { born: null, died: null, bio: '', profilePic: null, birthPlace: null };
  }
}

// Enrich a raw TMDB movie result → Lumière film object
async function enrichFilm(f, country) {
  const credits       = await getCredits(f.id);
  const originalTitle = f.original_title || f.title;
  const italianTitle  = f.title;
  return {
    id:       `tmdb_${f.id}`,
    tmdbId:   f.id,
    title:    originalTitle,
    itTitle:  italianTitle !== originalTitle ? italianTitle : null,
    year:     f.release_date ? parseInt(f.release_date.slice(0, 4), 10) : null,
    country,
    genres:   mapGenres(f.genre_ids),
    genre:    mapGenres(f.genre_ids)[0] || 'Drammatico',
    director: credits.director,
    actors:   credits.actors,
    synopsis: f.overview || '',
    trailer:  null,
    poster:   f.poster_path ? `https://image.tmdb.org/t/p/w300${f.poster_path}` : null,
    rating:   f.vote_average,
    votes:    f.vote_count,
  };
}

// Heuristic: country code → primary TMDB original_language value
function _langForCountry(code) {
  const MAP = {
    IT:'it', FR:'fr', DE:'de', ES:'es', JP:'ja', KR:'ko',
    RU:'ru', PT:'pt', PL:'pl', SE:'sv', DK:'da', NO:'nb',
    HU:'hu', CZ:'cs', RO:'ro', HK:'zh', TW:'zh', CN:'zh',
    IR:'fa', IN:'hi', AR:'es', BR:'pt',
    // English-speaking countries (US and GB were previously missing — root cause
    // of "2001: A Space Odyssey" not appearing in US search: TMDB stores it as
    // origin_country=GB, original_language=en; without US→'en' the film was
    // silently dropped by _matchesCountry)
    US:'en', GB:'en', AU:'en', NZ:'en', IE:'en', CA:'en',
    BE:'fr', AT:'de',
  };
  return MAP[code] || null;
}

// Countries that share the same primary language and commonly co-produce films
// (e.g. US/GB/AU/CA all use 'en'). Used to catch cross-country productions
// like US-British films that TMDB may register under only one origin_country.
const LANG_PEERS = {
  en: new Set(['US','GB','AU','CA','IE','NZ']),
  es: new Set(['ES','MX','AR']),
  zh: new Set(['CN','HK','TW']),
  pt: new Set(['PT','BR']),
  fr: new Set(['FR','BE','CA']),
  de: new Set(['DE','AT','CH']),
};

function _matchesCountry(f, country, lang) {
  const origins = f.origin_country || [];
  // Direct country match
  if (origins.includes(country)) return true;
  // Language match (same language → likely same linguistic cinema space)
  if (lang && f.original_language === lang) return true;
  // Peer-country match: catches co-productions stored under a sibling country
  // (e.g. "2001: A Space Odyssey" origin_country=GB, searched from US)
  if (lang && LANG_PEERS[lang]) {
    if (origins.some(c => LANG_PEERS[lang].has(c))) return true;
  }
  return false;
}

// ── Main handler ──────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const country = (req.query.country || 'IT').toUpperCase().slice(0, 2);
  const q       = (req.query.q || '').trim();
  const type    = req.query.type || 'films';

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'Query troppo corta (min 2 caratteri)' });
  }

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const lang = _langForCountry(country);

  try {

    // ════════════════════════════════════════════════════════════
    // FILMS
    // ════════════════════════════════════════════════════════════
    if (type === 'films') {

      // ── Strategy A: title search (3 pages) ──────────────────
      const titlePagesPromise = Promise.all([1, 2, 3].map(page =>
        tmdb('/search/movie', { query: q, language: 'it-IT', page })
          .then(d => d.results || [])
          .catch(() => [])
      ));

      // ── Strategy B: person → filmography ────────────────────
      // Search for a person matching the query; if found use their
      // TMDB ID to discover every film from this country they
      // directed (with_crew) or starred in (with_cast).
      const personFilmsPromise = tmdb('/search/person', {
        query:    q,
        language: 'it-IT',
        page:     1,
      }).then(async personData => {
        const persons = (personData.results || []).slice(0, 3); // top 3 matches
        if (!persons.length) return [];

        const filmLists = await Promise.all(persons.map(async p => {
          const dept  = p.known_for_department || '';
          const param = dept === 'Directing' ? 'with_crew' : 'with_cast';
          try {
            // Fetch up to 2 pages of their country-scoped filmography
            const pages = await Promise.all([1, 2].map(page =>
              tmdb('/discover/movie', {
                with_origin_country: country,
                [param]:             p.id,
                sort_by:             'vote_count.desc',
                language:            'it-IT',
                page,
              }).then(d => d.results || []).catch(() => [])
            ));
            return pages.flat();
          } catch {
            return [];
          }
        }));

        return filmLists.flat();
      }).catch(() => []);

      // Run both strategies in parallel
      const [titlePages, personFilms] = await Promise.all([
        titlePagesPromise,
        personFilmsPromise,
      ]);

      // Merge: title-search results filtered by country + person-filmography results
      const titleMatches = titlePages.flat()
        .filter(f => _matchesCountry(f, country, lang));

      // Deduplicate by TMDB film ID, title matches first (more relevant)
      const seen    = new Set();
      const merged  = [];
      for (const f of [...titleMatches, ...personFilms]) {
        if (!seen.has(f.id)) { seen.add(f.id); merged.push(f); }
        if (merged.length >= 15) break;
      }

      // Enrich with credits (director + actors)
      const enriched = await Promise.all(merged.map(f => enrichFilm(f, country)));

      return res.status(200).json({ type: 'films', country, query: q, results: enriched });
    }

    // ════════════════════════════════════════════════════════════
    // DIRECTORS / ACTORS
    // ════════════════════════════════════════════════════════════
    const dept = type === 'directors' ? 'Directing' : 'Acting';

    // Fetch 2 pages of person search results for broader coverage
    const [page1, page2] = await Promise.all([
      tmdb('/search/person', { query: q, language: 'it-IT', page: 1 })
        .then(d => d.results || []).catch(() => []),
      tmdb('/search/person', { query: q, language: 'it-IT', page: 2 })
        .then(d => d.results || []).catch(() => []),
    ]);

    const raw = [...page1, ...page2]
      .filter(p => {
        if (p.known_for_department !== dept) return false;
        const kf = p.known_for || [];
        // Accept people with empty known_for (older/less-prominent on TMDB)
        if (kf.length === 0) return true;
        return kf.some(f => _matchesCountry(f, country, lang));
      })
      // Deduplicate by id
      .filter((p, i, arr) => arr.findIndex(x => x.id === p.id) === i)
      .slice(0, 10);

    const enriched = await Promise.all(
      raw.map(async p => {
        const detail = await getPersonDetail(p.id);
        return {
          tmdbId:     p.id,
          name:       p.name,
          filmCount:  (p.known_for || []).length,
          knownFor:   (p.known_for || [])
                        .map(f => f.title || f.original_title)
                        .filter(Boolean),
          genre:      null,
          profilePic: p.profile_path
                        ? `https://image.tmdb.org/t/p/w185${p.profile_path}`
                        : null,
          ...detail,
        };
      })
    );

    return res.status(200).json({ type, country, query: q, results: enriched });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
