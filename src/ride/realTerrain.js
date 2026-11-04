import * as THREE from 'three'
import { localToLatLon } from '../routes/routes'

/**
 * Terreno real para rutas GPX: relieve de AWS Terrain Tiles (formato "terrarium", datos abiertos)
 * cubierto con imagen satelital. Dos capas de imagen:
 * - base: toda la zona a baja resolución (una sola textura);
 * - corredor nítido: ~250 m a cada lado del camino a alta resolución, en bloques de 4×4 mosaicos
 *   con su propia textura, cargados por etapas cerca del ciclista (solo con proveedores de alta
 *   resolución).
 * Necesita internet al cargar la ruta.
 */

const DEM_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`

export const IMAGERY = {
  sentinel: {
    name: 'Sentinel-2 (gratis)',
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/${z}/${y}/${x}.jpg`,
    baseZoom: 14,
    detailZoom: null,
    brightness: { color: 1.35, emissive: 0.3 },
    attribution:
      'Imagen: Sentinel-2 cloudless 2020 — s2maps.eu, EOX IT Services GmbH (contiene datos modificados de Copernicus Sentinel 2020), CC BY-NC-SA 4.0',
  },
  maptiler: {
    name: 'MapTiler',
    needsKey: true,
    keyHelp: 'Crea una cuenta gratuita en maptiler.com y copia tu API key (Account → API keys).',
    url: (z, x, y, key) => `https://api.maptiler.com/maps/satellite/256/${z}/${x}/${y}.jpg?key=${encodeURIComponent(key)}`,
    baseZoom: 14,
    detailZoom: 17,
    brightness: { color: 1.1, emissive: 0.2 },
    attribution: 'Imagen: © MapTiler © colaboradores de OpenStreetMap',
  },
  esri: {
    name: 'Esri World Imagery',
    needsKey: true,
    keyHelp: 'Crea una cuenta gratuita de ArcGIS Location Platform y genera una API key con acceso a basemaps.',
    url: (z, x, y, key) =>
      `https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}?token=${encodeURIComponent(key)}`,
    baseZoom: 14,
    detailZoom: 17,
    brightness: { color: 1.1, emissive: 0.2 },
    attribution: 'Imagen: Powered by Esri — Esri, Maxar, Earthstar Geographics y la comunidad de usuarios GIS',
  },
}
const DEM_ATTRIBUTION = 'Relieve: Terrain Tiles, AWS Open Data'

const TILE = 256
const PAD_M = 800 // terreno alrededor de la ruta
const GRID_M = { baja: 30, media: 18, alta: 12 }
const MAX_VERTS = 700_000
const CHUNK = 4 // mosaicos por lado en cada bloque del corredor nítido (1024 px)
const DETAIL_R = 250 // m a cada lado del camino con imagen nítida

// Web Mercator: posición de tile (fraccionaria) para una longitud/latitud.
const lonToX = (lon, z) => ((lon + 180) / 360) * 2 ** z
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z
}

function tileRange(b, z) {
  const x0 = Math.floor(lonToX(b.lonMin, z))
  const x1 = Math.floor(lonToX(b.lonMax, z))
  const y0 = Math.floor(latToY(b.latMax, z))
  const y1 = Math.floor(latToY(b.latMin, z))
  return { z, x0, x1, y0, y1, cols: x1 - x0 + 1, rows: y1 - y0 + 1 }
}

// Zoom más detallado (desde maxZ) que no pase de maxTiles mosaicos.
function pickZoom(b, maxZ, maxTiles) {
  for (let z = maxZ; z > 3; z--) {
    const r = tileRange(b, z)
    if (r.cols * r.rows <= maxTiles) return r
  }
  return tileRange(b, 3)
}

async function loadTile(url) {
  const res = await fetch(url, { mode: 'cors' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const blob = await res.blob()
  // Algunos servicios (Esri) responden 200 con un JSON de error en vez de la imagen.
  if (!blob.type.startsWith('image/')) {
    const text = await blob.slice(0, 300).text()
    throw new Error(/token|key|auth/i.test(text) ? 'HTTP 401' : 'respuesta no es una imagen')
  }
  return createImageBitmap(blob)
}

// Descarga los mosaicos de un rango y los pega en un canvas. Los que fallan quedan vacíos.
async function mosaic(range, urlFor) {
  const canvas = document.createElement('canvas')
  canvas.width = range.cols * TILE
  canvas.height = range.rows * TILE
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const jobs = []
  for (let ty = range.y0; ty <= range.y1; ty++) {
    for (let tx = range.x0; tx <= range.x1; tx++) {
      jobs.push(
        loadTile(urlFor(range.z, tx, ty)).then((img) => {
          ctx.drawImage(img, (tx - range.x0) * TILE, (ty - range.y0) * TILE)
          img.close?.()
        }),
      )
    }
  }
  const results = await Promise.allSettled(jobs)
  const failed = results.filter((r) => r.status === 'rejected')
  if (failed.length === results.length) {
    const reason = String(failed[0]?.reason?.message || '')
    throw new Error(/HTTP 40[13]/.test(reason) ? 'clave rechazada' : 'sin conexión o servicio no disponible')
  }
  return canvas
}

// Píxel (fraccionario) dentro de un mosaico para una latitud/longitud.
const pixelIn = (range, lat, lon) => ({
  px: (lonToX(lon, range.z) - range.x0) * TILE,
  py: (latToY(lat, range.z) - range.y0) * TILE,
})

function demSampler(range, canvas) {
  const { width: W, height: H } = canvas
  const data = canvas.getContext('2d').getImageData(0, 0, W, H).data
  const h = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const a = data[i * 4 + 3]
    // Terrarium: altura = R·256 + G + B/256 − 32768. Mosaicos faltantes → NaN.
    h[i] = a === 0 ? NaN : data[i * 4] * 256 + data[i * 4 + 1] + data[i * 4 + 2] / 256 - 32768
  }
  return (lat, lon) => {
    const { px, py } = pixelIn(range, lat, lon)
    const x = Math.min(W - 1.001, Math.max(0, px - 0.5))
    const y = Math.min(H - 1.001, Math.max(0, py - 0.5))
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const tx = x - ix
    const ty = y - iy
    const k = iy * W + ix
    return (h[k] * (1 - tx) + h[k + 1] * tx) * (1 - ty) + (h[k + W] * (1 - tx) + h[k + W + 1] * tx) * ty
  }
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function imageryMaterial(tex, provider, track, extra = {}) {
  const mat = track(
    new THREE.MeshLambertMaterial({
      map: tex,
      emissiveMap: tex,
      emissive: '#ffffff',
      // La foto satelital ya trae la luz del día en que se tomó y suele ser oscura: se aclara y
      // se le suma brillo propio para que el sombreado no la apague.
      emissiveIntensity: provider.brightness.emissive,
      ...extra,
    }),
  )
  mat.color.setScalar(provider.brightness.color)
  return mat
}

/**
 * Corredor nítido por etapas: bloques de 4×4 mosaicos (1024 px) a `detailZoom` alrededor del
 * camino, que se descargan solo cerca de la posición del ciclista (≈2 km adelante) y se liberan
 * al quedar atrás. Así no hay límite de largo de ruta y solo se baja lo que se recorre.
 * Cada bloque es una malla con las celdas del terreno que caen en él, dibujada sobre la base.
 */
const AHEAD_M = 2000
const BEHIND_M = 300
const KEEP_AHEAD_M = 2600 // margen para no descargar y liberar un bloque una y otra vez
const KEEP_BEHIND_M = 700
const MAX_PARALLEL = 2

function createDetailStreamer({ provider, key, cl, origen, grid, anisotropy }) {
  const zd = provider.detailZoom
  const tileM = (40075016 * Math.cos((origen.lat * Math.PI) / 180)) / 2 ** zd
  const lat0 = (origen.lat * Math.PI) / 180
  const toLocal = (lat, lon) => ({ x: (lon - origen.lon) * Math.cos(lat0) * 111320, z: -(lat - origen.lat) * 110540 })
  const tileLon = (x) => (x / 2 ** zd) * 360 - 180
  const tileLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zd))) * 180) / Math.PI

  // Bloques que toca el corredor, con el tramo de la ruta (dMin–dMax) desde el que se ven.
  const chunks = new Map()
  const k = Math.ceil(DETAIL_R / tileM)
  const stepPts = 4 // cada 20 m de línea central
  for (let i = 0; i < cl.n; i += stepPts) {
    const d = cl.dAt(i)
    const ll = localToLatLon(origen, cl.xs[i], cl.zs[i])
    const tx0 = Math.floor(lonToX(ll.lon, zd))
    const ty0 = Math.floor(latToY(ll.lat, zd))
    for (let dy = -k; dy <= k; dy++) {
      for (let dx = -k; dx <= k; dx++) {
        if (dx * dx + dy * dy > (k + 0.5) ** 2) continue
        const tx = tx0 + dx
        const ty = ty0 + dy
        const cx = Math.floor(tx / CHUNK)
        const cy = Math.floor(ty / CHUNK)
        const ck = `${cx},${cy}`
        let ch = chunks.get(ck)
        if (!ch) {
          ch = { cx, cy, tiles: new Set(), dMin: d, dMax: d, state: 'idle', mesh: null, disposables: [] }
          chunks.set(ck, ch)
        }
        ch.tiles.add(`${tx},${ty}`)
        ch.dMin = Math.min(ch.dMin, d)
        ch.dMax = Math.max(ch.dMax, d)
      }
    }
  }

  const group = new THREE.Group()
  let loading = 0
  let failed = 0
  let disposed = false
  const SIZE = CHUNK * TILE
  const { nx, nz, minX, minZ, cell, pos } = grid

  async function load(ch) {
    ch.state = 'loading'
    loading++
    try {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = SIZE
      const ctx = canvas.getContext('2d')
      const results = await Promise.allSettled(
        [...ch.tiles].map((t) => {
          const [tx, ty] = t.split(',').map(Number)
          return loadTile(provider.url(zd, tx, ty, key)).then((img) => {
            ctx.drawImage(img, (tx - ch.cx * CHUNK) * TILE, (ty - ch.cy * CHUNK) * TILE)
            img.close?.()
          })
        }),
      )
      failed += results.filter((r) => r.status === 'rejected').length
      if (disposed || ch.state !== 'loading') return

      // Celdas del terreno dentro del bloque cuyo centro cae en un mosaico del corredor.
      const nwLL = { lat: tileLat(ch.cy * CHUNK), lon: tileLon(ch.cx * CHUNK) }
      const seLL = { lat: tileLat((ch.cy + 1) * CHUNK), lon: tileLon((ch.cx + 1) * CHUNK) }
      const nwL = toLocal(nwLL.lat, nwLL.lon)
      const seL = toLocal(seLL.lat, seLL.lon)
      const gx0 = Math.max(0, Math.floor((nwL.x - minX) / cell))
      const gx1 = Math.min(nx - 2, Math.ceil((seL.x - minX) / cell))
      const gz0 = Math.max(0, Math.floor((nwL.z - minZ) / cell))
      const gz1 = Math.min(nz - 2, Math.ceil((seL.z - minZ) / cell))
      const remap = new Map()
      const p = []
      const uv = []
      const idx = []
      const vert = (g) => {
        if (remap.has(g)) return remap.get(g)
        const i = remap.size
        remap.set(g, i)
        const x = pos[g * 3]
        const z = pos[g * 3 + 2]
        p.push(x, pos[g * 3 + 1], z)
        const ll = localToLatLon(origen, x, z)
        uv.push(((lonToX(ll.lon, zd) - ch.cx * CHUNK) * TILE) / SIZE, 1 - ((latToY(ll.lat, zd) - ch.cy * CHUNK) * TILE) / SIZE)
        return i
      }
      for (let gz = gz0; gz <= gz1; gz++) {
        for (let gx = gx0; gx <= gx1; gx++) {
          const ll = localToLatLon(origen, minX + (gx + 0.5) * cell, minZ + (gz + 0.5) * cell)
          if (!ch.tiles.has(`${Math.floor(lonToX(ll.lon, zd))},${Math.floor(latToY(ll.lat, zd))}`)) continue
          const c = gz * nx + gx
          const a = vert(c)
          const b = vert(c + 1)
          const a2 = vert(c + nx)
          const b2 = vert(c + nx + 1)
          idx.push(a, a2, b, b, a2, b2)
        }
      }
      if (!idx.length) {
        ch.state = 'empty'
        return
      }
      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3))
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
      geo.setIndex(idx)
      geo.computeVertexNormals()
      const tex = new THREE.CanvasTexture(canvas)
      tex.colorSpace = THREE.SRGBColorSpace
      tex.anisotropy = anisotropy
      // Zonas sin mosaico quedan transparentes y se ve la capa base debajo.
      const local = []
      const mat = imageryMaterial(tex, provider, (o) => (local.push(o), o), {
        alphaTest: 0.5,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
      ch.disposables = [geo, tex, ...local]
      ch.mesh = new THREE.Mesh(geo, mat)
      ch.mesh.receiveShadow = true
      group.add(ch.mesh)
      ch.state = 'ready'
    } finally {
      loading--
    }
  }

  function unload(ch) {
    if (ch.mesh) group.remove(ch.mesh)
    for (const o of ch.disposables) o.dispose?.()
    ch.mesh = null
    ch.disposables = []
    ch.state = 'idle'
  }

  return {
    group,
    get loading() {
      return loading
    },
    get failed() {
      return failed
    },
    /** Llamar periódicamente con la distancia recorrida: carga lo que viene y libera lo pasado. */
    update(d) {
      if (disposed) return
      const wanted = []
      for (const ch of chunks.values()) {
        const near = ch.dMin <= d + AHEAD_M && ch.dMax >= d - BEHIND_M
        const keep = ch.dMin <= d + KEEP_AHEAD_M && ch.dMax >= d - KEEP_BEHIND_M
        if (ch.state === 'ready' && !keep) unload(ch)
        else if (ch.state === 'loading' && !keep) ch.state = 'idle' // se descarta al terminar
        else if (ch.state === 'idle' && near) wanted.push(ch)
      }
      // Primero lo más cercano a la posición actual.
      wanted.sort((a, b) => Math.abs(a.dMin - d) - Math.abs(b.dMin - d))
      for (const ch of wanted) {
        if (loading >= MAX_PARALLEL) break
        load(ch)
      }
    },
    dispose() {
      disposed = true
      for (const ch of chunks.values()) unload(ch)
    },
  }
}

/**
 * @param cl línea central (xs, ys, zs, n, dAt(i) → distancia en la ruta) en metros locales,
 *   ys ya escalado por `vert`
 * @param origen { lat, lon } del punto (0, 0)
 * @param vert exageración vertical usada en el mundo
 * @param quality 'baja' | 'media' | 'alta'
 * @param imagery 'sentinel' | 'maptiler' | 'esri'
 * @param apiKey clave del proveedor (si la necesita)
 * @param anisotropy anisotropía máxima del renderer (nitidez de la textura en ángulo)
 * @param track registra objetos para liberar al desmontar
 * @returns {{ group, detail, attribution, warning }} — `detail` (o null) se actualiza con la
 *   distancia recorrida y se libera con dispose()
 */
export async function buildRealTerrain({ cl, origen, vert, quality, imagery = 'sentinel', apiKey = '', anisotropy, track }) {
  let provider = IMAGERY[imagery] ?? IMAGERY.sentinel
  let warning = ''
  if (provider.needsKey && !apiKey) {
    warning = `Falta la clave de ${provider.name}: se usa Sentinel-2.`
    provider = IMAGERY.sentinel
  }

  // Caja de la ruta, con margen.
  let minX = Infinity
  let maxX = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < cl.n; i++) {
    minX = Math.min(minX, cl.xs[i])
    maxX = Math.max(maxX, cl.xs[i])
    minZ = Math.min(minZ, cl.zs[i])
    maxZ = Math.max(maxZ, cl.zs[i])
  }
  minX -= PAD_M
  maxX += PAD_M
  minZ -= PAD_M
  maxZ += PAD_M
  const nw = localToLatLon(origen, minX, minZ)
  const se = localToLatLon(origen, maxX, maxZ)
  const bounds = { latMax: nw.lat, latMin: se.lat, lonMin: nw.lon, lonMax: se.lon }

  const demRange = pickZoom(bounds, 13, 36)
  const imgRange = pickZoom(bounds, provider.baseZoom, 64)
  const demCanvas = await mosaic(demRange, DEM_URL)
  let imgCanvas
  try {
    imgCanvas = await mosaic(imgRange, (z, x, y) => provider.url(z, x, y, apiKey))
  } catch (err) {
    if (provider === IMAGERY.sentinel) throw err
    warning = `${provider.name}: ${err.message}. Se usa Sentinel-2.`
    provider = IMAGERY.sentinel
    imgCanvas = await mosaic(pickZoom(bounds, provider.baseZoom, 64), (z, x, y) => provider.url(z, x, y))
  }
  const baseRange = provider === IMAGERY.sentinel ? pickZoom(bounds, provider.baseZoom, 64) : imgRange
  const demAt = demSampler(demRange, demCanvas)

  // El GPX y el modelo de elevación no coinciden exactamente: se corrige la diferencia media
  // para que el relieve real calce con la altura del camino.
  let sum = 0
  let cnt = 0
  for (let i = 0; i < cl.n; i += 10) {
    const ll = localToLatLon(origen, cl.xs[i], cl.zs[i])
    const e = demAt(ll.lat, ll.lon)
    if (!Number.isNaN(e)) {
      sum += e * vert - cl.ys[i]
      cnt++
    }
  }
  const offset = cnt ? sum / cnt : 0

  // Malla regular.
  let cell = GRID_M[quality] ?? GRID_M.media
  while (((maxX - minX) / cell + 1) * ((maxZ - minZ) / cell + 1) > MAX_VERTS) cell *= 1.2
  const nx = Math.ceil((maxX - minX) / cell) + 1
  const nz = Math.ceil((maxZ - minZ) / cell) + 1
  const N = nx * nz

  // Distancia al camino (solo hace falta cerca: ahí el terreno se acomoda a la altura del GPX).
  const NEAR = 45
  const dist2 = new Float32Array(N).fill(Infinity)
  const refY = new Float32Array(N)
  for (let i = 0; i < cl.n; i++) {
    const x = cl.xs[i]
    const z = cl.zs[i]
    const gx0 = Math.max(0, Math.floor((x - NEAR - minX) / cell))
    const gx1 = Math.min(nx - 1, Math.ceil((x + NEAR - minX) / cell))
    const gz0 = Math.max(0, Math.floor((z - NEAR - minZ) / cell))
    const gz1 = Math.min(nz - 1, Math.ceil((z + NEAR - minZ) / cell))
    for (let gz = gz0; gz <= gz1; gz++) {
      const dz = minZ + gz * cell - z
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = minX + gx * cell - x
        const d2 = dx * dx + dz * dz
        const k = gz * nx + gx
        if (d2 < dist2[k]) {
          dist2[k] = d2
          refY[k] = cl.ys[i]
        }
      }
    }
  }

  const pos = new Float32Array(N * 3)
  const uv = new Float32Array(N * 2)
  const W = imgCanvas.width
  const H = imgCanvas.height
  let fallbackY = cl.ys[0]
  for (let gz = 0; gz < nz; gz++) {
    for (let gx = 0; gx < nx; gx++) {
      const k = gz * nx + gx
      const x = minX + gx * cell
      const z = minZ + gz * cell
      const ll = localToLatLon(origen, x, z)
      let y = demAt(ll.lat, ll.lon) * vert - offset
      if (Number.isNaN(y)) y = fallbackY
      fallbackY = y
      const d = Math.sqrt(dist2[k])
      if (d < NEAR) y = refY[k] - 0.3 + (y - (refY[k] - 0.3)) * smoothstep(10, NEAR, d)
      pos[k * 3] = x
      pos[k * 3 + 1] = y
      pos[k * 3 + 2] = z
      const { px, py } = pixelIn(baseRange, ll.lat, ll.lon)
      uv[k * 2] = px / W
      uv[k * 2 + 1] = 1 - py / H
    }
  }
  const idx = new Uint32Array((nx - 1) * (nz - 1) * 6)
  let o = 0
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx
      idx[o++] = a
      idx[o++] = a + nx
      idx[o++] = a + 1
      idx[o++] = a + 1
      idx[o++] = a + nx
      idx[o++] = a + nx + 1
    }
  }
  const geo = track(new THREE.BufferGeometry())
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  geo.setIndex(new THREE.BufferAttribute(idx, 1))
  geo.computeVertexNormals()

  const tex = track(new THREE.CanvasTexture(imgCanvas))
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = anisotropy
  const base = new THREE.Mesh(geo, imageryMaterial(tex, provider, track))
  base.receiveShadow = true

  const group = new THREE.Group()
  group.add(base)
  let detail = null
  if (provider.detailZoom) {
    detail = createDetailStreamer({ provider, key: apiKey, cl, origen, grid: { nx, nz, minX, minZ, cell, pos }, anisotropy })
    group.add(detail.group)
  }
  return { group, detail, attribution: `${provider.attribution} · ${DEM_ATTRIBUTION}`, warning }
}
