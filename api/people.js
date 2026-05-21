/**
 * /api/people?country=XX&type=director|actor
 *
 * Aggregates directors (or actors) from the most-voted AND most-recent films
 * of a country, to ensure both classic and contemporary talent is covered.
 *
 * Strategy:
 *  - Pass A: 5 pages sorted by vote_count.desc  (≈100 popular/classic films)
 *  - Pass B: 3 pages sorted by primary_release_date.desc (≈60 recent films)
 *  → deduped by film ID → up to ~160 unique films
 *  - Cast: top 10 billed actors per film (was 5)
 *  - vote_count.gte: 5 (was 20) — includes arthouse / classic films
 *  - Returns top 50 people by film-count; enriches top 30 with bio
 *
 * Cached 1 h at CDN level (s-maxage=3600).
 */
const { tmdb, GENRE_MAP } = require('./_tmdb');

// Fetch biography & birth year for a person.
async function getPersonDetail(personId) {
  try {
    const data = await tmdb(`/person/${personId}`, { language: 'it-IT' });
    return {
      born:       data.birthday ? parseInt(data.birthday.slice(0, 4), 10) : null,
      died:       data.deathday ? parseInt(data.deathday.slice(0, 4), 10) : null,
      bio:        data.biography || '',
      profilePic: data.profile_path
                    ? `https://image.tmdb.org/t/p/w185${data.profile_path}`
                    : null
    };
  } catch {
    return { born: null, died: null, bio: '', profilePic: null };
  }
}

// Fetch one page of discover results, return results array or [].
async function discoverPage(country, sortBy, page) {
  return tmdb('/discover/movie', {
    with_origin_country: country,
    sort_by:             sortBy,
    'vote_count.gte':    5,
    page,
  }).then(d => d.results || []).catch(() => []);
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const country        = (req.query.country || 'FR').toUpperCase().slice(0, 2);
  const type           = req.query.type === 'actor' ? 'actor' : 'director';
  const MAX_PEOPLE     = 50;   // total returned
  const MAX_DETAIL     = 30;   // enriched with full bio / birth year
  const CAST_PER_FILM  = 10;   // top-billed actors considered per film

  // 1-hour CDN cache, 2-hour stale-while-revalidate
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  try {
    // ── Step 1: collect films ────────────────────────────────────────────────
    // Pass A — most voted (covers classics and crowd favourites)
    const passAPages = [1, 2, 3, 4, 5];
    // Pass B — most recent (covers contemporary talent)
    const passBPages = [1, 2, 3];

    const [passA, passB] = await Promise.all([
      Promise.all(passAPages.map(p => discoverPage(country, 'vote_count.desc',           p))),
      Promise.all(passBPages.map(p => discoverPage(country, 'primary_release_date.desc', p))),
    ]);

    // Deduplicate by TMDB film ID
    const filmMap = new Map();
    [...passA.flat(), ...passB.flat()].forEach(f => {
      if (!filmMap.has(f.id)) filmMap.set(f.id, f);
    });
    const films = [...filmMap.values()];   // up to ~160 unique films

    // ── Step 2: fetch credits for all films (batches of 10) ─────────────────
    const allCredits = [];
    for (let i = 0; i < films.length; i += 10) {
      const batch = films.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(f =>
          tmdb(`/movie/${f.id}/credits`)
            .then(d => ({
              filmTitle: f.title,
              filmYear:  f.release_date ? parseInt(f.release_date.slice(0, 4), 10) : null,
              genreIds:  f.genre_ids || [],
              crew:      d.crew || [],
              cast:      d.cast || [],
            }))
            .catch(() => ({ filmTitle: f.title, filmYear: null, genreIds: [], crew: [], cast: [] }))
        )
      );
      allCredits.push(...results);
    }

    // ── Step 3: aggregate people ─────────────────────────────────────────────
    const peopleMap = {};  // tmdbId → aggregated record

    allCredits.forEach(({ filmTitle, genreIds, crew, cast }) => {
      const list = type === 'director'
        ? crew.filter(p => p.job === 'Director')
        : cast.slice(0, CAST_PER_FILM);

      list.forEach(p => {
        if (!p.id || !p.name) return;
        if (!peopleMap[p.id]) {
          peopleMap[p.id] = {
            tmdbId: p.id, name: p.name,
            filmCount: 0, knownFor: [], genreCounts: {},
          };
        }
        peopleMap[p.id].filmCount++;
        if (peopleMap[p.id].knownFor.length < 5) {
          peopleMap[p.id].knownFor.push(filmTitle);
        }
        genreIds.forEach(id => {
          const label = GENRE_MAP[id];
          if (label) {
            peopleMap[p.id].genreCounts[label] =
              (peopleMap[p.id].genreCounts[label] || 0) + 1;
          }
        });
      });
    });

    // Sort by film count desc, take top MAX_PEOPLE
    const sorted = Object.values(peopleMap)
      .map(p => {
        const gc    = p.genreCounts || {};
        const genre = Object.entries(gc).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        return { ...p, genre };
      })
      .sort((a, b) => b.filmCount - a.filmCount)
      .slice(0, MAX_PEOPLE);

    // ── Step 4: enrich top MAX_DETAIL people with bio / birth year ───────────
    const top  = sorted.slice(0, MAX_DETAIL);
    const rest = sorted.slice(MAX_DETAIL);

    const enriched = await Promise.all(
      top.map(async p => {
        const detail = await getPersonDetail(p.tmdbId);
        return { ...p, ...detail };
      })
    );

    const people = [
      ...enriched,
      ...rest.map(p => ({ ...p, born: null, died: null, bio: '', profilePic: null })),
    ];

    res.status(200).json({ type, country, people });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
