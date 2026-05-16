/**
 * /api/people?country=XX&type=director|actor&page=1
 *
 * Aggregates directors (or actors) from the top-rated films of a country.
 * Fetches up to 3 pages of top films (≈ 60 films), collects unique people
 * from their credits, then returns the top N sorted by film count.
 *
 * Cached 1 h at CDN level.
 *
 * Response:
 * {
 *   type: 'director'|'actor',
 *   country: 'XX',
 *   people: [{ tmdbId, name, born, died, bio, knownFor, profilePic }]
 * }
 */
const { tmdb } = require('./_tmdb');

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

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const country = (req.query.country || 'FR').toUpperCase().slice(0, 2);
  const type    = req.query.type === 'actor' ? 'actor' : 'director';
  const maxPeoplDetail = 20;  // enrich only the top N people with full bio

  // 1-hour CDN cache
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');

  try {
    // Step 1: collect top films for this country (3 pages = up to 60 films)
    const pages = await Promise.all(
      [1, 2, 3].map(p =>
        tmdb('/discover/movie', {
          with_origin_country: country,
          sort_by: 'vote_count.desc',
          'vote_count.gte': 20,
          page: p
        }).then(d => d.results || []).catch(() => [])
      )
    );
    const films = pages.flat();

    // Step 2: fetch credits for each film in parallel (batches of 10)
    const allCredits = [];
    for (let i = 0; i < films.length; i += 10) {
      const batch = films.slice(i, i + 10);
      const results = await Promise.all(
        batch.map(f =>
          tmdb(`/movie/${f.id}/credits`)
            .then(d => ({ filmTitle: f.title, crew: d.crew || [], cast: d.cast || [] }))
            .catch(() => ({ filmTitle: f.title, crew: [], cast: [] }))
        )
      );
      allCredits.push(...results);
    }

    // Step 3: aggregate people
    const peopleMap = {};  // tmdbId → { name, filmCount, knownFor[] }

    allCredits.forEach(({ filmTitle, crew, cast }) => {
      const list = type === 'director'
        ? crew.filter(p => p.job === 'Director')
        : cast.slice(0, 5);   // top-billed actors only

      list.forEach(p => {
        if (!p.id || !p.name) return;
        if (!peopleMap[p.id]) {
          peopleMap[p.id] = { tmdbId: p.id, name: p.name, filmCount: 0, knownFor: [] };
        }
        peopleMap[p.id].filmCount++;
        if (peopleMap[p.id].knownFor.length < 5) {
          peopleMap[p.id].knownFor.push(filmTitle);
        }
      });
    });

    // Sort by film count desc, take top 40
    const sorted = Object.values(peopleMap)
      .sort((a, b) => b.filmCount - a.filmCount)
      .slice(0, 40);

    // Step 4: enrich top N people with bio / birth year
    const top = sorted.slice(0, maxPeoplDetail);
    const rest = sorted.slice(maxPeoplDetail);

    const enriched = await Promise.all(
      top.map(async p => {
        const detail = await getPersonDetail(p.tmdbId);
        return { ...p, ...detail };
      })
    );

    // Rest without detail (born=null, bio='')
    const people = [
      ...enriched,
      ...rest.map(p => ({ ...p, born: null, died: null, bio: '', profilePic: null }))
    ];

    res.status(200).json({ type, country, people });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
