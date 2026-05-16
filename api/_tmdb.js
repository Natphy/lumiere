/**
 * _tmdb.js — Shared TMDB utility (prefixed _ → not a Vercel route)
 *
 * Requires env variable: TMDB_API_KEY  (v3 read-access token)
 * Set it via: Vercel Dashboard → Project → Settings → Environment Variables
 */

const BASE = 'https://api.themoviedb.org/3';

/**
 * Fetch a TMDB endpoint and return parsed JSON.
 * @param {string} path   e.g. '/discover/movie'
 * @param {object} params query-string params (api_key added automatically)
 */
async function tmdb(path, params = {}) {
  const key = process.env.TMDB_API_KEY;
  if (!key) throw new Error('TMDB_API_KEY environment variable is not set');

  const url = new URL(BASE + path);
  url.searchParams.set('api_key', key);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`TMDB ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

/**
 * TMDB genre ID → Italian genre key matching GENRE_DEFS in index.html
 */
const GENRE_MAP = {
  28:    'Azione',
  12:    'Avventura',
  16:    'Animazione',
  35:    'Commedia',
  80:    'Thriller',      // Crime
  99:    'Documentario',
  18:    'Drammatico',
  10751: 'Commedia',      // Family
  14:    'Fantasy',
  36:    'Storico',
  27:    'Horror',
  10402: 'Musical',
  9648:  'Thriller',      // Mystery
  10749: 'Romantico',
  878:   'Fantascienza',
  10770: 'Drammatico',    // TV Movie
  53:    'Thriller',
  10752: 'Guerra',
  37:    'Western'
};

/**
 * Map an array of TMDB genre_ids to our genre key (first match wins).
 */
function mapGenre(genreIds = []) {
  for (const id of genreIds) {
    if (GENRE_MAP[id]) return GENRE_MAP[id];
  }
  return 'Drammatico';
}

/**
 * All country codes used by Lumière (must match COUNTRIES in index.html)
 */
const LUMIERE_COUNTRIES = [
  'FR','US','IT','GB','DE','JP','SE','RU','IN','KR',
  'ES','PL','DK','AT','BR','MX','CN','AR','AU','BE',
  'IR','NO','HU','NZ','IE','TW','CZ','CA','PT','RO','HK'
];

module.exports = { tmdb, GENRE_MAP, mapGenre, LUMIERE_COUNTRIES };
