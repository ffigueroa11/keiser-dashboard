/**
 * Rutas virtuales: una ruta es { id, nombre, paso, ele: [], planta? } — elevación en metros
 * muestreada cada `paso` metros de distancia. Las rutas incluidas se generan a partir de una
 * función de pendiente; las importadas vienen de un GPX, traen además su trazado real en planta
 * (`planta: { x: [], z: [] }`, metros, mismo muestreo), los segundos de grabación de cada punto si
 * el GPX los trae (`tiempos: []`, para sincronizar un video) y se guardan en localStorage.
 */

const ROUTES_KEY = 'keiser.routes'
const RESULTS_KEY = 'keiser.routeResults'
const GPX_STEP_M = 20
const MAX_GRADE = 20 // % — límite al leer la pendiente (GPX ruidosos)

// ---------- Rutas incluidas ----------

function fromGrade(id, nombre, lengthM, gradePctAt, startEle = 100, paso = 10) {
  const ele = [startEle]
  for (let d = paso; d <= lengthM; d += paso) {
    ele.push(ele[ele.length - 1] + (gradePctAt(d) / 100) * paso)
  }
  return { id, nombre, paso, ele: ele.map((e) => Math.round(e * 10) / 10), incluida: true }
}

const wave = (d, period) => Math.sin((2 * Math.PI * d) / period)

export const BUILTIN_ROUTES = [
  fromGrade('costanera', 'Costanera', 10000, (d) => 0.6 * wave(d, 3000) + 0.3 * wave(d, 900), 8),
  fromGrade('lomas', 'Lomas del Sur', 15000, (d) => 4.5 * wave(d, 2500) + 1.5 * wave(d, 700), 120),
  fromGrade(
    'mirador',
    'Cuesta del Mirador',
    8000,
    (d) => {
      if (d < 1000) return 0.5 // aproximación
      if (d < 7000) return 6 + 2 * wave(d - 1000, 1500) + wave(d - 1000, 430) // subida ~6 %
      return 0.5 // cima
    },
    300,
  ),
]

// ---------- Consultas sobre una ruta ----------

export const routeLength = (r) => (r.ele.length - 1) * r.paso

export function elevationAt(r, d) {
  const x = Math.min(Math.max(d, 0), routeLength(r)) / r.paso
  const i = Math.floor(x)
  if (i >= r.ele.length - 1) return r.ele[r.ele.length - 1]
  return r.ele[i] + (r.ele[i + 1] - r.ele[i]) * (x - i)
}

/** Pendiente media (%) entre d0 y d1. */
export function avgGrade(r, d0, d1) {
  const len = routeLength(r)
  const a = Math.min(Math.max(d0, 0), len)
  const b = Math.min(Math.max(d1, 0), len)
  if (b - a < 1) return 0
  const g = ((elevationAt(r, b) - elevationAt(r, a)) / (b - a)) * 100
  return Math.min(MAX_GRADE, Math.max(-MAX_GRADE, g))
}

/** Pendiente en un punto, suavizada sobre ±25 m. */
export const gradeAt = (r, d) => avgGrade(r, d - 25, d + 25)

export function ascent(r) {
  let up = 0
  for (let i = 1; i < r.ele.length; i++) up += Math.max(0, r.ele[i] - r.ele[i - 1])
  return Math.round(up)
}

/**
 * Próximo cambio relevante de pendiente: primer punto (hasta 1 km adelante) donde la media de
 * los 200 m siguientes difiere en 2 puntos o más de la actual.
 */
export function nextChange(r, d) {
  const len = routeLength(r)
  const current = avgGrade(r, d, d + 200)
  for (let ahead = 100; ahead <= 1000 && d + ahead < len; ahead += 50) {
    const g = avgGrade(r, d + ahead, d + ahead + 200)
    if (Math.abs(g - current) >= 2) return { inM: ahead, grade: g }
  }
  return null
}

// ---------- Importar GPX ----------

function haversine(a, b) {
  const R = 6371000
  const toRad = (x) => (x * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** Convierte el texto de un GPX en una ruta. Lanza Error con un mensaje para mostrar. */
export function parseGpx(text, fileName = 'Ruta') {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('El archivo no es un GPX válido.')

  const pts = [...doc.querySelectorAll('trkpt, rtept')].map((p) => ({
    lat: parseFloat(p.getAttribute('lat')),
    lon: parseFloat(p.getAttribute('lon')),
    ele: parseFloat(p.querySelector('ele')?.textContent ?? 'NaN'),
    time: Date.parse(p.querySelector('time')?.textContent ?? ''),
  }))
  if (pts.length < 2) throw new Error('El GPX no tiene puntos de recorrido.')
  if (pts.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon))) {
    throw new Error('El GPX tiene puntos con coordenadas inválidas.')
  }
  if (pts.some((p) => Number.isNaN(p.ele))) {
    throw new Error('El GPX no trae elevación en sus puntos; expórtalo con altitud (por ejemplo, desde Strava).')
  }

  // Distancia acumulada y remuestreo cada GPX_STEP_M metros.
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]))
  const total = cum[cum.length - 1]
  if (total < 200) throw new Error('El recorrido es demasiado corto (menos de 200 m).')

  // Proyección plana local (metros) alrededor del primer punto: x = este, z = sur.
  const lat0 = (pts[0].lat * Math.PI) / 180
  const toX = (p) => (p.lon - pts[0].lon) * Math.cos(lat0) * 111320
  const toZ = (p) => -(p.lat - pts[0].lat) * 110540

  const raw = []
  const px = []
  const pz = []
  const hasTimes = pts.every((p) => Number.isFinite(p.time))
  const secs = (p) => (p.time - pts[0].time) / 1000
  const tt = []
  let j = 0
  const lerpAt = (a, b, t) => a + (b - a) * t
  for (let d = 0; d <= total; d += GPX_STEP_M) {
    while (j < cum.length - 2 && cum[j + 1] < d) j++
    const span = cum[j + 1] - cum[j] || 1
    const t = Math.min(1, Math.max(0, (d - cum[j]) / span))
    raw.push(lerpAt(pts[j].ele, pts[j + 1].ele, t))
    px.push(lerpAt(toX(pts[j]), toX(pts[j + 1]), t))
    pz.push(lerpAt(toZ(pts[j]), toZ(pts[j + 1]), t))
    if (hasTimes) tt.push(lerpAt(secs(pts[j]), secs(pts[j + 1]), t))
  }
  // Último tramo incompleto: se agrega un punto más para no acortar la ruta.
  if (total - (raw.length - 1) * GPX_STEP_M > GPX_STEP_M / 2) {
    const lastPt = pts[pts.length - 1]
    raw.push(lastPt.ele)
    px.push(toX(lastPt))
    pz.push(toZ(lastPt))
    if (hasTimes) tt.push(secs(lastPt))
  }

  // Media móvil de 100 m: la altitud del GPS es ruidosa y daría pendientes irreales.
  // La ventana se achica de forma simétrica en los extremos para no aplanar el inicio ni el final.
  const ele = raw.map((_, i) => {
    const k = Math.min(2, i, raw.length - 1 - i)
    const w = raw.slice(i - k, i + k + 1)
    return Math.round((w.reduce((s, x) => s + x, 0) / w.length) * 10) / 10
  })

  const nombre =
    doc.querySelector('trk > name, rte > name, metadata > name')?.textContent?.trim() ||
    fileName.replace(/\.gpx$/i, '')
  // Trazado en planta, con un suavizado leve (±20 m) para quitar el zigzag del GPS sin
  // recortar las curvas cerradas.
  const smooth1 = (arr) =>
    arr.map((_, i) => {
      const k = Math.min(1, i, arr.length - 1 - i)
      const w = arr.slice(i - k, i + k + 1)
      return Math.round((w.reduce((s, x) => s + x, 0) / w.length) * 10) / 10
    })

  return {
    id: `gpx-${Date.now()}`,
    nombre,
    paso: GPX_STEP_M,
    ele,
    planta: { x: smooth1(px), z: smooth1(pz) },
    // Punto (0, 0) de la planta, para ubicar la ruta en el mapa (relieve y satélite reales).
    origen: { lat: pts[0].lat, lon: pts[0].lon },
    ...(hasTimes && tt[tt.length - 1] > 0 ? { tiempos: tt.map((t) => Math.round(t * 10) / 10) } : {}),
  }
}

/**
 * Segundo del video que corresponde a la distancia d. Con `useTimes` usa los tiempos del GPX
 * (el video avanza como se filmó); si no, reparte el video parejo a lo largo de la ruta.
 */
export function videoTimeAt(r, d, duration, useTimes = true) {
  const len = routeLength(r)
  const x = Math.min(Math.max(d, 0), len)
  if (!useTimes || !r.tiempos) return (x / len) * duration
  const t = x / r.paso
  const i = Math.min(r.tiempos.length - 2, Math.floor(t))
  return r.tiempos[i] + (r.tiempos[i + 1] - r.tiempos[i]) * (t - i)
}

/** Segundos de video por metro de ruta alrededor de d (velocidad a la que se filmó, invertida). */
export function videoSecondsPerMeter(r, d, duration, useTimes = true) {
  const len = routeLength(r)
  const a = Math.max(0, d - 15)
  const b = Math.min(len, d + 15)
  if (b - a < 1) return 0
  return (videoTimeAt(r, b, duration, useTimes) - videoTimeAt(r, a, duration, useTimes)) / (b - a)
}

/** Conversión entre la planta local (metros: x = este, z = sur) y latitud/longitud. */
export function localToLatLon(origen, x, z) {
  const lat0 = (origen.lat * Math.PI) / 180
  return { lat: origen.lat - z / 110540, lon: origen.lon + x / (Math.cos(lat0) * 111320) }
}

// ---------- Persistencia ----------

function read(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null')
    return v ?? fallback
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export const loadImportedRoutes = () => {
  const list = read(ROUTES_KEY, [])
  return Array.isArray(list) ? list : []
}
export const saveImportedRoutes = (list) => write(ROUTES_KEY, list)

/** { [routeId]: [{ fecha, tiempoSeg, velMediaKmh }] } */
export const loadRouteResults = () => read(RESULTS_KEY, {})
export const saveRouteResults = (results) => write(RESULTS_KEY, results)
