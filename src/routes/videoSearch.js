import {
  loadRejected,
  loadSeen,
  loadWebVideos,
  matchesFilters,
  queryTerms,
  clearSeen,
} from './webVideos'

/**
 * Video aleatorio según filtros: mezcla la lista propia (etiquetas exactas) con una búsqueda en
 * YouTube Data API (requiere clave). YouTube no sabe de "cerros" ni "noche": esos filtros buscan
 * por texto, así que son aproximados. La duración y si se puede reproducir aquí sí son exactas.
 */

const API = 'https://www.googleapis.com/youtube/v3'
const POOL_KEY = 'keiser.videoPool'
const POOL_TTL_MS = 24 * 3600 * 1000 // evita gastar cuota repitiendo la misma búsqueda
const MAX_PAGES = 3

// Títulos que casi nunca son una rodada en primera persona.
const NOT_A_RIDE =
  /\b(review|reseña|unboxing|compilation|compilaci[oó]n|drone|top \d+|vlog|how to|tutorial|crash|highlights|zwift|rouvy|game|gameplay|trailer|shorts)\b/i
const LOOKS_LIKE_A_RIDE = /cycl|bike|bicy|ride|pov|cicl|bici|velo|rad(fahr|tour)|fahrrad/i
const NIGHT = /night|noche|nacht|nuit/i

export function parseIsoDuration(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '')
  if (!m) return 0
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0)
}

const API_ERRORS = {
  keyInvalid: 'La clave de YouTube no es válida. Revísala en "Clave de búsqueda".',
  badRequest: 'La clave de YouTube no es válida. Revísala en "Clave de búsqueda".',
  quotaExceeded: 'Se acabó la cuota diaria de búsquedas de YouTube. Se renueva mañana; mientras tanto, usa tu lista.',
  dailyLimitExceeded: 'Se acabó la cuota diaria de búsquedas de YouTube. Se renueva mañana; mientras tanto, usa tu lista.',
  rateLimitExceeded: 'Se acabó la cuota diaria de búsquedas de YouTube. Se renueva mañana; mientras tanto, usa tu lista.',
  ipRefererBlocked: `La clave de YouTube no permite este sitio. Agrega ${location.origin}/* en sus restricciones.`,
  refererNotAllowedMapsApi: `La clave de YouTube no permite este sitio. Agrega ${location.origin}/* en sus restricciones.`,
  accessNotConfigured: 'Falta activar "YouTube Data API v3" en el proyecto de tu clave.',
  forbidden: 'YouTube rechazó la clave. Revisa que tenga activada "YouTube Data API v3".',
}

async function apiGet(path, params) {
  let res
  try {
    res = await fetch(`${API}/${path}?${new URLSearchParams(params)}`)
  } catch {
    throw new Error('No se pudo conectar con YouTube. Revisa tu conexión a internet.')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const reason = data?.error?.errors?.[0]?.reason || data?.error?.details?.[0]?.reason
    const invalidKey = /api key/i.test(data?.error?.message || '')
    throw new Error(
      invalidKey ? API_ERRORS.keyInvalid : API_ERRORS[reason] || `YouTube respondió con un error (${res.status}).`,
    )
  }
  return data
}

function readPools() {
  try {
    return JSON.parse(localStorage.getItem(POOL_KEY) || '{}')
  } catch {
    return {}
  }
}

function writePool(query, pool) {
  const now = Date.now()
  const fresh = Object.fromEntries(Object.entries(readPools()).filter(([, p]) => now - p.ts < POOL_TTL_MS))
  try {
    localStorage.setItem(POOL_KEY, JSON.stringify({ ...fresh, [query]: pool }))
  } catch {
    /* sin almacenamiento: se vuelve a buscar la próxima vez */
  }
}

/** Una página de búsqueda, ya filtrada por duración, reproducción y título. */
async function fetchPage(query, filters, key, pageToken) {
  const minSec = filters.duracionMin * 60
  const found = await apiGet('search', {
    part: 'id',
    type: 'video',
    q: query,
    maxResults: '50',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    ...(filters.duracionMin >= 20 ? { videoDuration: 'long' } : {}),
    ...(pageToken ? { pageToken } : {}),
    key,
  })
  const ids = (found.items || []).map((i) => i.id?.videoId).filter(Boolean)
  if (!ids.length) return { items: [], nextPageToken: found.nextPageToken ?? null }

  const details = await apiGet('videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: '50', key })
  const items = (details.items || [])
    .filter((v) => v.status?.embeddable && v.status?.privacyStatus === 'public')
    .map((v) => ({
      videoId: v.id,
      nombre: v.snippet?.title ?? 'Video de YouTube',
      descripcion: (v.snippet?.description ?? '').slice(0, 300),
      duracionSeg: parseIsoDuration(v.contentDetails?.duration),
    }))
    .filter((v) => v.duracionSeg >= minSec && !NOT_A_RIDE.test(v.nombre) && LOOKS_LIKE_A_RIDE.test(v.nombre))
    .filter((v) => {
      const isNight = NIGHT.test(`${v.nombre} ${v.descripcion}`)
      if (filters.momento === 'noche') return isNight
      if (filters.momento === 'dia') return !NIGHT.test(v.nombre)
      return true
    })
    .map(({ descripcion, ...rest }) => rest)
  return { items, nextPageToken: found.nextPageToken ?? null }
}

const pick = (list) => list[Math.floor(Math.random() * list.length)]

/**
 * Elige un video al azar. Devuelve un objeto de video, o null si nada cumple los filtros.
 * Lanza Error (con mensaje para mostrar) si la búsqueda falla y la lista propia no alcanza.
 */
export async function pickRandomVideo(filters, key) {
  const seen = new Set(loadSeen())
  const rejected = new Set(loadRejected())
  const saved = loadWebVideos().filter((v) => matchesFilters(v, filters))
  const savedIds = new Set(loadWebVideos().map((v) => v.videoId))
  const fromList = saved.filter((v) => !seen.has(v.videoId))

  let searchError = null
  let fromSearch = []
  let everythingSeen = false
  if (key) {
    const query = queryTerms(filters)
    const cacheId = `${query}|${filters.duracionMin}|${filters.momento}`
    let pool = readPools()[cacheId]
    if (!pool || Date.now() - pool.ts > POOL_TTL_MS) pool = { ts: Date.now(), items: [], nextPageToken: null, started: false }
    const usable = () => pool.items.filter((v) => !seen.has(v.videoId) && !rejected.has(v.videoId) && !savedIds.has(v.videoId))
    try {
      for (let i = 0; i < MAX_PAGES && !usable().length && (!pool.started || pool.nextPageToken); i++) {
        const page = await fetchPage(query, filters, key, pool.nextPageToken)
        const known = new Set(pool.items.map((v) => v.videoId))
        pool = {
          ts: pool.ts,
          started: true,
          nextPageToken: page.nextPageToken,
          items: [...pool.items, ...page.items.filter((v) => !known.has(v.videoId))],
        }
        writePool(cacheId, pool)
      }
    } catch (err) {
      searchError = err
    }
    fromSearch = usable()
    everythingSeen = !fromSearch.length && pool.items.some((v) => !rejected.has(v.videoId) && !savedIds.has(v.videoId))
    if (everythingSeen) fromSearch = pool.items.filter((v) => !rejected.has(v.videoId) && !savedIds.has(v.videoId))
  }

  const candidates = [
    ...fromSearch.map((v) => ({
      id: `yt-${v.videoId}`,
      videoId: v.videoId,
      nombre: v.nombre,
      duracionSeg: v.duracionSeg,
      inicioSeg: 0,
    })),
    ...fromList,
  ]
  if (candidates.length) {
    if (everythingSeen) clearSeen()
    return pick(candidates)
  }
  // Ya se vio todo lo de la lista: vuelve a empezar antes de decir que no hay nada.
  if (saved.length) {
    clearSeen()
    return pick(saved)
  }
  if (searchError) throw searchError
  return null
}
