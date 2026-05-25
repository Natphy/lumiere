/**
 * /api/people?country=XX&type=director|actor
 *
 * Aggregates directors (or actors) from top-voted, highest-rated AND most-recent
 * films of a country, to cover popular, arthouse and contemporary talent.
 *
 * Strategy:
 *  - Pass A: 5 pages sorted by vote_count.desc   (≈100 popular/classic films)
 *  - Pass B: 3 pages sorted by vote_average.desc  (≈60 highest-rated films — arthouse)
 *  - Pass C: 3 pages sorted by primary_release_date.desc (≈60 recent films)
 *  → deduped by film ID → up to ~220 unique films per country
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
                    : null,
      birthPlace: data.place_of_birth || null,
    };
  } catch {
    return { born: null, died: null, bio: '', profilePic: null, birthPlace: null };
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
  const page           = Math.max(1, parseInt(req.query.page, 10) || 1);
  const PER_PAGE       = 20;    // people per page (mirrors film pagination)
  const MAX_PEOPLE     = 1000;  // soft cap — large countries easily surface 500+ people
  const CAST_PER_FILM  = 10;    // top-billed actors considered per film

  // 6-hour CDN cache, 12-hour stale-while-revalidate
  // People data (bios, filmographies) changes far less often than new film releases.
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');

  try {
    // ── Step 1: collect films ────────────────────────────────────────────────
    // Pass A — most voted  (10 pages ≈ 200 films: popular, blockbusters, crowd favourites)
    // Pass B — highest rated with ≥50 votes (5 pages ≈ 100 films: arthouse, classics)
    // Pass C — most recent (5 pages ≈ 100 films: contemporary talent)
    // Total unique: up to ~400 films → surfaces 300–600 unique people for large countries
    const [passA, passB, passC] = await Promise.all([
      Promise.all([1,2,3,4,5,6,7,8,9,10].map(p => discoverPage(country, 'vote_count.desc', p))),
      Promise.all([1,2,3,4,5].map(p =>
        tmdb('/discover/movie', {
          with_origin_country: country,
          sort_by:             'vote_average.desc',
          'vote_count.gte':    50,
          page:                p,
        }).then(d => d.results || []).catch(() => [])
      )),
      Promise.all([1,2,3,4,5].map(p => discoverPage(country, 'primary_release_date.desc', p))),
    ]);

    // Deduplicate by TMDB film ID
    const filmMap = new Map();
    [...passA.flat(), ...passB.flat(), ...passC.flat()].forEach(f => {
      if (!filmMap.has(f.id)) filmMap.set(f.id, f);
    });
    const films = [...filmMap.values()];   // up to ~220 unique films

    // ── Step 2: fetch credits for all films (batches of 20) ─────────────────
    const allCredits = [];
    for (let i = 0; i < films.length; i += 20) {
      const batch = films.slice(i, i + 20);
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

    // Sort by film count desc, cap at MAX_PEOPLE before pagination
    const sorted = Object.values(peopleMap)
      .map(p => {
        const gc    = p.genreCounts || {};
        const genre = Object.entries(gc).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
        return { ...p, genre };
      })
      .sort((a, b) => b.filmCount - a.filmCount)
      .slice(0, MAX_PEOPLE);

    // ── Step 4: paginate + enrich only this page's people ───────────────────
    const totalPeople = sorted.length;
    const totalPages  = Math.ceil(totalPeople / PER_PAGE) || 1;
    const pageSlice   = sorted.slice((page - 1) * PER_PAGE, page * PER_PAGE);

    // Enrich in batches of 10 to avoid overwhelming the TMDB API
    const people = [];
    for (let i = 0; i < pageSlice.length; i += 10) {
      const batch = pageSlice.slice(i, i + 10);
      const enriched = await Promise.all(
        batch.map(async p => {
          const detail = await getPersonDetail(p.tmdbId);
          return { ...p, ...detail };
        })
      );
      people.push(...enriched);
    }

    res.status(200).json({ type, country, page, totalPeople, totalPages, perPage: PER_PAGE, people });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
