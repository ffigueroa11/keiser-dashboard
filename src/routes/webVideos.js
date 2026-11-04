/**
 * Videos de YouTube para rodar: la app guarda solo el enlace y sus ajustes, y los reproduce con el
 * reproductor oficial de YouTube (no se descarga nada).
 * { id, videoId, nombre, inicioSeg: dónde empieza a rodar }
 */

const KEY = 'keiser.webVideos'

export const YOUTUBE_SEARCH_URL = `https://www.youtube.com/results?search_query=${encodeURIComponent(
  'first person cycling POV no music 4K',
)}`

/** Extrae el ID de 11 caracteres de un enlace de YouTube (o del ID solo). Null si no reconoce. */
export function parseYouTubeId(text) {
  const s = text.trim()
  if (/^[\w-]{11}$/.test(s)) return s
  let url
  try {
    url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`)
  } catch {
    return null
  }
  const host = url.hostname.replace(/^(www|m|music)\./, '')
  let id = null
  if (host === 'youtu.be') id = url.pathname.split('/')[1]
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    id = url.searchParams.get('v') || url.pathname.match(/^\/(?:embed|shorts|live|v)\/([\w-]+)/)?.[1]
  }
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

export function loadWebVideos() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function saveWebVideos(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* sin almacenamiento: la lista dura solo esta visita */
  }
}

export function updateWebVideo(id, patch) {
  saveWebVideos(loadWebVideos().map((v) => (v.id === id ? { ...v, ...patch } : v)))
}

// ---------- Filtros y etiquetas ----------

export const REGIONS = [
  { id: 'any', label: 'Cualquier lugar', q: '' },
  { id: 'europa', label: 'Europa', q: 'Europe' },
  { id: 'alpes', label: 'Europa · Alpes', q: 'Alps', parent: 'europa' },
  { id: 'dolomitas', label: 'Europa · Dolomitas', q: 'Dolomites', parent: 'europa' },
  { id: 'pirineos', label: 'Europa · Pirineos', q: 'Pyrenees', parent: 'europa' },
  { id: 'italia', label: 'Europa · Italia', q: 'Italy', parent: 'europa' },
  { id: 'francia', label: 'Europa · Francia', q: 'France', parent: 'europa' },
  { id: 'espana', label: 'Europa · España', q: 'Spain', parent: 'europa' },
  { id: 'suiza', label: 'Europa · Suiza', q: 'Switzerland', parent: 'europa' },
  { id: 'austria', label: 'Europa · Austria', q: 'Austria', parent: 'europa' },
  { id: 'noruega', label: 'Europa · Noruega', q: 'Norway', parent: 'europa' },
  { id: 'sudamerica', label: 'Sudamérica', q: 'South America' },
  { id: 'chile', label: 'Sudamérica · Chile', q: 'Chile', parent: 'sudamerica' },
  { id: 'patagonia', label: 'Sudamérica · Patagonia', q: 'Patagonia', parent: 'sudamerica' },
  { id: 'norteamerica', label: 'Norteamérica', q: 'USA Canada' },
  { id: 'asia', label: 'Asia', q: 'Asia' },
  { id: 'oceania', label: 'Oceanía', q: 'New Zealand Australia' },
]
export const MOMENTS = [
  { id: 'any', label: 'Día o noche' },
  { id: 'dia', label: 'De día' },
  { id: 'noche', label: 'De noche' },
]
export const TERRAINS = [
  { id: 'any', label: 'Cualquier terreno', q: '' },
  { id: 'carretera', label: 'Carretera', q: 'road' },
  { id: 'cerros', label: 'Cerros', q: 'mountain climb' },
  { id: 'mixto', label: 'Mixto', q: 'gravel' },
]
export const MIN_DURATIONS = [10, 20, 30, 45, 60, 90]

const FILTERS_KEY = 'keiser.videoFilters'
const YT_KEY = 'keiser.youtubeKey'
const SEEN_KEY = 'keiser.videosSeen'
const REJECTED_KEY = 'keiser.videosRejected'
const MAX_SEEN = 500

const readJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback
  } catch {
    return fallback
  }
}
const writeJson = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* sin almacenamiento: dura solo esta visita */
  }
}

export const loadFilters = () => ({ region: 'any', momento: 'any', terreno: 'any', duracionMin: 30, sinMusica: true, ...readJson(FILTERS_KEY, {}) })
export const saveFilters = (f) => writeJson(FILTERS_KEY, f)
export const loadYouTubeKey = () => readJson(YT_KEY, '')
export const saveYouTubeKey = (k) => writeJson(YT_KEY, k)

export const loadSeen = () => readJson(SEEN_KEY, [])
export const markSeen = (videoId) => writeJson(SEEN_KEY, [...loadSeen().filter((v) => v !== videoId), videoId].slice(-MAX_SEEN))
export const clearSeen = () => writeJson(SEEN_KEY, [])
export const loadRejected = () => readJson(REJECTED_KEY, [])
export const addRejected = (videoId) => writeJson(REJECTED_KEY, [...new Set([...loadRejected(), videoId])])

/** Texto de búsqueda para YouTube a partir de los filtros. */
export function queryTerms(f) {
  return [
    'cycling POV first person ride',
    REGIONS.find((r) => r.id === f.region)?.q,
    TERRAINS.find((t) => t.id === f.terreno)?.q,
    f.momento === 'noche' ? 'night' : '',
    f.sinMusica ? 'no music' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** Un video de la lista cumple los filtros según sus etiquetas (exactas, las puso el usuario). */
export function matchesFilters(v, f) {
  const tags = v.etiquetas ?? {}
  if (f.region !== 'any' && tags.region !== f.region) {
    if (REGIONS.find((r) => r.id === tags.region)?.parent !== f.region) return false
  }
  if (f.momento !== 'any' && tags.momento !== f.momento) return false
  if (f.terreno !== 'any' && tags.terreno !== f.terreno) return false
  if (v.duracionSeg && v.duracionSeg < f.duracionMin * 60) return false
  return true
}

export function tagsLabel(v) {
  const t = v.etiquetas ?? {}
  return [
    REGIONS.find((r) => r.id === t.region && r.id !== 'any')?.label,
    MOMENTS.find((m) => m.id === t.momento && m.id !== 'any')?.label,
    TERRAINS.find((x) => x.id === t.terreno && x.id !== 'any')?.label,
    v.duracionSeg ? `${Math.round(v.duracionSeg / 60)} min` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
