<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import * as THREE from 'three'
import { Sky } from 'three/addons/objects/Sky.js'
import { elevationAt, gradeAt, routeLength } from '../routes/routes'
import { BARS, BB, FRONT, HEAD_TUBE, REAR, SEAT, WHEEL_RADIUS_CM, computePose } from '../ride/pose'
import { buildRealTerrain } from '../ride/realTerrain'

/**
 * Vista 3D de una ruta. No simula nada: lee en cada cuadro el estado de la simulación de
 * RideScene (`sim`: distM, crank, wheel, e) y dibuja el mundo, el ciclista y la cámara.
 */
const props = defineProps({
  route: { type: Object, required: true },
  sim: { type: Object, required: true },
  pedaling: { type: Boolean, default: false },
  // 'baja' | 'media' | 'alta' — se fija al montar (cambiarla vuelve a crear la vista)
  quality: { type: String, default: 'media' },
  // 'generado' | 'sentinel' | 'maptiler' | 'esri' — relieve y satélite reales solo en rutas GPX
  // con origen. También se fija al montar.
  landscape: { type: String, default: 'generado' },
  apiKey: { type: String, default: '' },
})

const container = ref(null)
const error = ref('')
const loading = ref(false)
const notice = ref('')
const attribution = ref('')
const detailLoading = ref(false)
let disposed = false
let detail = null // carga por etapas de la imagen nítida (paisaje real con MapTiler/Esri)
let detailClock = 0

const STEP = 5 // m entre muestras de la línea central
const PAD = 300 // m de mundo antes de la salida y después de la meta
const ROAD_HALF = 3
// Una subida real de 5 % casi no se nota en pantalla: el relieve del mundo generado se exagera
// un poco (con relieve real queda en 1). Se fija al montar.
let VERT = 1.4
// Sol de media tarde.
const SUN_ELEVATION = 28
const SUN_AZIMUTH = 215

const QUALITY = {
  baja: { shadows: 0, pixelRatio: 1, antialias: false, trees: 0.4, sky: false, fogFar: 450 },
  media: { shadows: 1024, pixelRatio: 1.5, antialias: true, trees: 0.7, sky: true, fogFar: 750 },
  alta: { shadows: 2048, pixelRatio: 2, antialias: true, trees: 1, sky: true, fogFar: 1000 },
}

const COLORS = {
  haze: '#c9d5df',
  road: '#4a4a50',
  line: '#ececef',
  jersey: '#fb923c',
  sleeve: '#fdba74',
  helmet: '#38bdf8',
  frame: '#38bdf8',
  shorts: '#334155',
  skin: '#e8b98f',
  shoe: '#f4f4f5',
  metal: '#a1a1aa',
}

let renderer, scene, camera, sun, raf, observer
let rider // piezas animadas del ciclista
let last = null
let camReady = false
const disposables = []
const sunDir = new THREE.Vector3().setFromSphericalCoords(
  1,
  THREE.MathUtils.degToRad(90 - SUN_ELEVATION),
  THREE.MathUtils.degToRad(SUN_AZIMUTH),
)

// ---------- Utilidades ----------
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const hashString = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7)
const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const track = (o) => (disposables.push(o), o)

// ---------- Línea central de la carretera ----------
// Rutas GPX: trazado real en planta. Rutas incluidas: la ruta solo trae distancia y altura,
// así que se inventan curvas suaves (deterministas por ruta).
function buildCenterline(route, seed) {
  const len = routeLength(route)
  const n = Math.floor((len + 2 * PAD) / STEP) + 1
  const xs = new Float32Array(n)
  const ys = new Float32Array(n)
  const zs = new Float32Array(n)
  const hs = new Float32Array(n)

  if (route.planta) {
    const { x: px, z: pz } = route.planta
    const last = px.length - 1
    const at = (arr, d) => {
      const t = Math.min(last, Math.max(0, d / route.paso))
      const i = Math.min(last - 1, Math.floor(t))
      return arr[i] + (arr[i + 1] - arr[i]) * (t - i)
    }
    // Fuera de la ruta se sigue en línea recta con la dirección de los extremos.
    const dir = (i0, i1) => {
      const dx = px[i1] - px[i0]
      const dz = pz[i1] - pz[i0]
      const l = Math.hypot(dx, dz) || 1
      return { x: dx / l, z: dz / l }
    }
    const k = Math.min(3, last)
    const startDir = dir(0, k)
    const endDir = dir(last - k, last)
    for (let i = 0; i < n; i++) {
      const d = i * STEP - PAD
      if (d < 0) {
        xs[i] = px[0] + startDir.x * d
        zs[i] = pz[0] + startDir.z * d
      } else if (d > len) {
        xs[i] = px[last] + endDir.x * (d - len)
        zs[i] = pz[last] + endDir.z * (d - len)
      } else {
        xs[i] = at(px, d)
        zs[i] = at(pz, d)
      }
      ys[i] = elevationAt(route, d) * VERT
    }
    // Rumbo de cada punto, "desenrollado" para que no salte de +π a -π al interpolar.
    let prev = 0
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 2)
      const b = Math.min(n - 1, i + 2)
      let h = Math.atan2(zs[b] - zs[a], xs[b] - xs[a])
      if (i > 0) {
        while (h - prev > Math.PI) h -= 2 * Math.PI
        while (h - prev < -Math.PI) h += 2 * Math.PI
      }
      hs[i] = h
      prev = h
    }
  } else {
    let x = 0
    let z = 0
    for (let i = 0; i < n; i++) {
      const d = i * STEP - PAD
      const h = 0.5 * Math.sin(d / 700 + seed) + 0.25 * Math.sin(d / 260 + seed * 2)
      if (i > 0) {
        x += Math.cos(h) * STEP
        z += Math.sin(h) * STEP
      }
      xs[i] = x
      zs[i] = z
      ys[i] = elevationAt(route, d) * VERT
      hs[i] = h
    }
  }
  return { xs, ys, zs, hs, n, len, dAt: (i) => i * STEP - PAD }
}

function posAt(cl, d) {
  const t = Math.min(cl.n - 1.001, Math.max(0, (d + PAD) / STEP))
  const i = Math.floor(t)
  const f = t - i
  return {
    x: cl.xs[i] + (cl.xs[i + 1] - cl.xs[i]) * f,
    y: cl.ys[i] + (cl.ys[i + 1] - cl.ys[i]) * f,
    z: cl.zs[i] + (cl.zs[i + 1] - cl.zs[i]) * f,
    h: cl.hs[i] + (cl.hs[i + 1] - cl.hs[i]) * f,
  }
}
// Punto a `lat` metros del centro (positivo = izquierda en el sentido de avance).
function sidePoint(p, lat) {
  return { x: p.x - Math.sin(p.h) * lat, z: p.z + Math.cos(p.h) * lat }
}

/**
 * Terreno como malla regular sobre la zona que rodea la ruta. Cada vértice toma la altura del
 * tramo de camino más cercano (de cualquier parte de la ruta) y sube en lomas al alejarse.
 * Así funcionan curvas cerradas, zigzags y cruces: el cerro de un tramo nunca tapa a otro.
 */
const TERRAIN_R = 250 // m de terreno a cada lado del camino

function buildTerrain(cl, seed) {
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
  minX -= TERRAIN_R
  minZ -= TERRAIN_R
  maxX += TERRAIN_R
  maxZ += TERRAIN_R
  // Celdas de 12 m; en rutas muy extensas se agrandan para no pasar de ~3 millones de vértices.
  let cell = 12
  while (((maxX - minX) / cell + 1) * ((maxZ - minZ) / cell + 1) > 3e6) cell *= 1.25
  const nx = Math.ceil((maxX - minX) / cell) + 1
  const nz = Math.ceil((maxZ - minZ) / cell) + 1
  const N = nx * nz
  const dist2 = new Float32Array(N).fill(Infinity)
  const refY = new Float32Array(N)

  // Distancia al camino "salpicando" desde cada punto de la línea central: fino cerca del
  // camino, y cada 20 m para la zona lejana.
  const splat = (i, R) => {
    const x = cl.xs[i]
    const z = cl.zs[i]
    const gx0 = Math.max(0, Math.floor((x - R - minX) / cell))
    const gx1 = Math.min(nx - 1, Math.ceil((x + R - minX) / cell))
    const gz0 = Math.max(0, Math.floor((z - R - minZ) / cell))
    const gz1 = Math.min(nz - 1, Math.ceil((z + R - minZ) / cell))
    const R2 = R * R
    for (let gz = gz0; gz <= gz1; gz++) {
      const dz = minZ + gz * cell - z
      for (let gx = gx0; gx <= gx1; gx++) {
        const dx = minX + gx * cell - x
        const d2 = dx * dx + dz * dz
        const k = gz * nx + gx
        if (d2 < R2 && d2 < dist2[k]) {
          dist2[k] = d2
          refY[k] = cl.ys[i]
        }
      }
    }
  }
  for (let i = 0; i < cl.n; i++) splat(i, 40)
  for (let i = 0; i < cl.n; i += 4) splat(i, TERRAIN_R)

  const heights = new Float32Array(N)
  const index = new Int32Array(N).fill(-1)
  const pos = []
  const col = []
  const c = new THREE.Color()
  const dirt = new THREE.Color('#7a6a55')
  const grassA = new THREE.Color('#4f7a3c')
  const grassB = new THREE.Color('#8aa85a')
  const rock = new THREE.Color('#8b857a')
  let count = 0
  for (let gz = 0; gz < nz; gz++) {
    for (let gx = 0; gx < nx; gx++) {
      const k = gz * nx + gx
      if (dist2[k] === Infinity) continue
      const x = minX + gx * cell
      const z = minZ + gz * cell
      const d = Math.sqrt(dist2[k])
      const n =
        0.5 +
        0.25 * Math.sin(x / 190 + seed) * Math.cos(z / 230) +
        0.15 * Math.sin((x + z) / 95 + seed * 3) +
        0.1 * Math.sin(x / 41 - z / 37)
      const rise = smoothstep(6, 90, d) * n * 45
      const y = refY[k] - 0.15 + rise
      heights[k] = y
      index[k] = count++
      pos.push(x, y, z)
      c.copy(grassA).lerp(grassB, Math.min(1, Math.max(0, n)))
      if (d < 7) c.copy(dirt)
      else if (rise > 28) c.lerp(rock, 0.65)
      col.push(c.r, c.g, c.b)
    }
  }
  const idx = []
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = index[gz * nx + gx]
      const b = index[gz * nx + gx + 1]
      const a2 = index[(gz + 1) * nx + gx]
      const b2 = index[(gz + 1) * nx + gx + 1]
      if (a < 0 || b < 0 || a2 < 0 || b2 < 0) continue
      idx.push(a, a2, b, b, a2, b2)
    }
  }
  const geo = track(new THREE.BufferGeometry())
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, track(new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true })))
  mesh.receiveShadow = true

  // Altura (bilineal) y distancia al camino en cualquier punto del terreno.
  const sample = (x, z) => {
    const fx = (x - minX) / cell
    const fz = (z - minZ) / cell
    const gx = Math.floor(fx)
    const gz = Math.floor(fz)
    if (gx < 0 || gz < 0 || gx >= nx - 1 || gz >= nz - 1) return null
    const k = gz * nx + gx
    const ks = [k, k + 1, k + nx, k + nx + 1]
    if (ks.some((q) => index[q] < 0)) return null
    const tx = fx - gx
    const tz = fz - gz
    const y =
      (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + nx] * (1 - tx) + heights[k + nx + 1] * tx) * tz
    return { y, dist: Math.sqrt(Math.min(...ks.map((q) => dist2[q]))) }
  }
  return { mesh, sample }
}

// ---------- Mundo ----------
function ribbon(cl, latA, latB, yOffset, color, filter = () => true) {
  const pos = []
  for (let i = 0; i < cl.n - 1; i++) {
    const d = i * STEP - PAD
    if (!filter(d)) continue
    const p0 = { x: cl.xs[i], y: cl.ys[i], z: cl.zs[i], h: cl.hs[i] }
    const p1 = { x: cl.xs[i + 1], y: cl.ys[i + 1], z: cl.zs[i + 1], h: cl.hs[i + 1] }
    const a0 = sidePoint(p0, latA)
    const b0 = sidePoint(p0, latB)
    const a1 = sidePoint(p1, latA)
    const b1 = sidePoint(p1, latB)
    const y0 = p0.y + yOffset
    const y1 = p1.y + yOffset
    pos.push(a0.x, y0, a0.z, b0.x, y0, b0.z, a1.x, y1, a1.z)
    pos.push(b0.x, y0, b0.z, b1.x, y1, b1.z, a1.x, y1, a1.z)
  }
  const geo = track(new THREE.BufferGeometry())
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geo.computeVertexNormals()
  // polygonOffset: el asfalto siempre se dibuja sobre el terreno que pasa justo por debajo.
  const mat = track(
    new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
  )
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  return mesh
}

function trees(cl, terrain, seed, density) {
  const rand = mulberry32(seed)
  const target = Math.min(3500, Math.round(((cl.len + 2 * PAD) / 1000) * 160 * density))
  const foliageGeo = track(new THREE.ConeGeometry(1.6, 5, 6))
  foliageGeo.translate(0, 3.5, 0)
  const trunkGeo = track(new THREE.CylinderGeometry(0.2, 0.25, 1.2, 5))
  trunkGeo.translate(0, 0.6, 0)
  const foliage = new THREE.InstancedMesh(foliageGeo, track(new THREE.MeshLambertMaterial({ flatShading: true })), target)
  const trunks = new THREE.InstancedMesh(trunkGeo, track(new THREE.MeshLambertMaterial({ color: '#5b4636' })), target)
  const m = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  const s = new THREE.Vector3()
  const c = new THREE.Color()
  let count = 0
  for (let tries = 0; count < target && tries < target * 2; tries++) {
    const d = -PAD + rand() * (cl.len + 2 * PAD)
    const lat = (rand() < 0.5 ? -1 : 1) * (9 + rand() ** 1.5 * 190)
    const sp = sidePoint(posAt(cl, d), lat)
    const g = terrain.sample(sp.x, sp.z)
    if (!g || g.dist < 9) continue // nunca sobre otro tramo de camino
    const k = 0.7 + rand() * 0.9
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rand() * Math.PI)
    s.set(k, k * (0.8 + rand() * 0.5), k)
    m.compose(new THREE.Vector3(sp.x, g.y, sp.z), q, s)
    foliage.setMatrixAt(count, m)
    trunks.setMatrixAt(count, m)
    foliage.setColorAt(count, c.setHSL(0.26 + rand() * 0.08, 0.42, 0.24 + rand() * 0.12))
    count++
  }
  foliage.count = count
  trunks.count = count
  foliage.castShadow = true
  trunks.castShadow = true
  return [foliage, trunks]
}

function textSprite(text, w = 256, h = 96, bg = 'rgba(24,24,27,0.9)', fg = '#f4f4f5') {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = fg
  ctx.font = `bold ${Math.round(h * 0.55)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, w / 2, h / 2)
  const tex = track(new THREE.CanvasTexture(canvas))
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function placeAt(obj, cl, d, lat = 0, yUp = 0) {
  const p = posAt(cl, d)
  const sp = sidePoint(p, lat)
  obj.position.set(sp.x, p.y + yUp, sp.z)
  obj.rotation.y = -p.h
  return obj
}

function finishArch(cl) {
  const g = new THREE.Group()
  const poleGeo = track(new THREE.CylinderGeometry(0.12, 0.12, 5, 8))
  const poleMat = track(new THREE.MeshLambertMaterial({ color: '#d4d4d8' }))
  for (const lat of [-4.2, 4.2]) {
    const pole = new THREE.Mesh(poleGeo, poleMat)
    pole.position.set(0, 2.5, lat)
    pole.castShadow = true
    g.add(pole)
  }
  const banner = new THREE.Mesh(
    track(new THREE.BoxGeometry(0.15, 1.2, 8.6)),
    track(new THREE.MeshBasicMaterial({ map: textSprite('META', 512, 72, '#fb923c', '#18181b') })),
  )
  banner.position.set(0, 4.6, 0)
  banner.castShadow = true
  g.add(banner)
  return placeAt(g, cl, cl.len)
}

function kmMarkers(cl) {
  const g = new THREE.Group()
  const postGeo = track(new THREE.CylinderGeometry(0.06, 0.06, 1.4, 6))
  const postMat = track(new THREE.MeshLambertMaterial({ color: '#d4d4d8' }))
  for (let km = 1; km * 1000 < cl.len && km <= 80; km++) {
    const m = new THREE.Group()
    const post = new THREE.Mesh(postGeo, postMat)
    post.position.y = 0.7
    const sign = new THREE.Mesh(
      track(new THREE.PlaneGeometry(1.1, 0.42)),
      track(new THREE.MeshBasicMaterial({ map: textSprite(`${km} km`), side: THREE.DoubleSide })),
    )
    sign.position.set(0, 1.55, 0)
    sign.rotation.y = Math.PI / 2
    m.add(post, sign)
    g.add(placeAt(m, cl, km * 1000, -4.5))
  }
  return g
}

function addSky(q) {
  if (!q.sky) {
    scene.background = new THREE.Color('#9fb7cc')
    scene.fog = new THREE.Fog('#b4c5d3', 70, q.fogFar)
    return
  }
  const sky = new Sky()
  sky.scale.setScalar(9000)
  const u = sky.material.uniforms
  u.turbidity.value = 6
  u.rayleigh.value = 1.4
  u.mieCoefficient.value = 0.005
  u.mieDirectionalG.value = 0.8
  u.sunPosition.value.copy(sunDir)
  track(sky.geometry)
  track(sky.material)
  scene.add(sky)
  scene.fog = new THREE.Fog(COLORS.haze, 90, q.fogFar)
}

// ---------- Ciclista ----------
const cm = (p, z = 0) => new THREE.Vector3(p.x / 100, -p.y / 100, z)
const UP = new THREE.Vector3(0, 1, 0)

function limb(radius, color) {
  const mesh = new THREE.Mesh(
    track(new THREE.CylinderGeometry(radius, radius, 1, 8)),
    track(new THREE.MeshLambertMaterial({ color })),
  )
  mesh.castShadow = true
  return mesh
}
function setLimb(mesh, a, b) {
  const dir = new THREE.Vector3().subVectors(b, a)
  const len = dir.length()
  mesh.position.copy(a).addScaledVector(dir, 0.5)
  mesh.scale.set(1, Math.max(len, 1e-3), 1)
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize())
}

function buildRider() {
  const root = new THREE.Group()
  root.rotation.order = 'YZX'
  const body = new THREE.Group() // se balancea al pedalear de pie
  root.add(body)

  // Bicicleta (estática salvo ruedas y biela).
  for (const [a, b] of [
    [REAR, BB],
    [BB, SEAT],
    [SEAT, REAR],
    [SEAT, HEAD_TUBE],
    [HEAD_TUBE, BB],
  ]) {
    const t = limb(0.018, COLORS.frame)
    setLimb(t, cm(a), cm(b))
    body.add(t)
  }
  for (const [a, b] of [
    [HEAD_TUBE, FRONT],
    [HEAD_TUBE, BARS],
  ]) {
    const t = limb(0.014, COLORS.metal)
    setLimb(t, cm(a), cm(b))
    body.add(t)
  }
  const bar = limb(0.014, COLORS.metal)
  setLimb(bar, cm(BARS, -0.21), cm(BARS, 0.21))
  body.add(bar)
  const saddle = new THREE.Mesh(track(new THREE.BoxGeometry(0.2, 0.03, 0.09)), track(new THREE.MeshLambertMaterial({ color: '#27272a' })))
  saddle.position.copy(cm({ x: SEAT.x - 1, y: SEAT.y - 3 }))
  saddle.castShadow = true
  body.add(saddle)

  const wheels = [REAR, FRONT].map((c) => {
    const w = new THREE.Group()
    w.position.copy(cm(c))
    const tire = new THREE.Mesh(
      track(new THREE.TorusGeometry(WHEEL_RADIUS_CM / 100, 0.022, 6, 28)),
      track(new THREE.MeshLambertMaterial({ color: '#18181b' })),
    )
    tire.castShadow = true
    w.add(tire)
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(track(new THREE.BoxGeometry(0.64, 0.006, 0.006)), track(new THREE.MeshLambertMaterial({ color: COLORS.metal })))
      spoke.rotation.z = (i * Math.PI) / 4
      w.add(spoke)
    }
    body.add(w)
    return w
  })

  const crank = limb(0.012, COLORS.metal)
  body.add(crank)

  // Ciclista: derecha = +z, izquierda = -z.
  const parts = {
    thighR: limb(0.06, COLORS.shorts),
    thighL: limb(0.06, COLORS.shorts),
    shinR: limb(0.042, COLORS.skin),
    shinL: limb(0.042, COLORS.skin),
    armUpR: limb(0.038, COLORS.sleeve),
    armUpL: limb(0.038, COLORS.sleeve),
    armLowR: limb(0.032, COLORS.skin),
    armLowL: limb(0.032, COLORS.skin),
    torso: limb(0.12, COLORS.jersey),
  }
  parts.torso.scale.z = 0.8
  Object.values(parts).forEach((p) => body.add(p))

  const shoeGeo = track(new THREE.BoxGeometry(0.16, 0.05, 0.07))
  const shoeMat = track(new THREE.MeshLambertMaterial({ color: COLORS.shoe }))
  const shoeR = new THREE.Mesh(shoeGeo, shoeMat)
  const shoeL = new THREE.Mesh(shoeGeo, shoeMat)
  body.add(shoeR, shoeL)

  const head = new THREE.Group()
  const face = new THREE.Mesh(track(new THREE.SphereGeometry(0.095, 12, 10)), track(new THREE.MeshLambertMaterial({ color: COLORS.skin })))
  const helmet = new THREE.Mesh(
    track(new THREE.SphereGeometry(0.11, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)),
    track(new THREE.MeshLambertMaterial({ color: COLORS.helmet })),
  )
  helmet.rotation.z = -0.35
  helmet.position.set(-0.01, 0.01, 0)
  face.castShadow = helmet.castShadow = true
  head.add(face, helmet)
  body.add(head)

  return { root, body, wheels, crank, parts, shoeR, shoeL, head }
}

function poseRider(r, sim) {
  const p = computePose(sim.crank, sim.e, props.pedaling)
  const zl = 0.09
  const hipR = cm(p.hip, zl)
  const hipL = cm(p.hip, -zl)
  setLimb(r.parts.thighR, hipR, cm(p.kneeR, zl))
  setLimb(r.parts.shinR, cm(p.kneeR, zl), cm(p.pedalR, zl))
  setLimb(r.parts.thighL, hipL, cm(p.kneeL, -zl))
  setLimb(r.parts.shinL, cm(p.kneeL, -zl), cm(p.pedalL, -zl))
  r.shoeR.position.copy(cm(p.pedalR, zl + 0.02))
  r.shoeL.position.copy(cm(p.pedalL, -zl - 0.02))
  setLimb(r.crank, cm(p.pedalL, -zl), cm(p.pedalR, zl))

  const zs = 0.17
  for (const [side, z] of [
    ['R', zs],
    ['L', -zs],
  ]) {
    const sh = cm(p.shoulder, z)
    const el = cm(p.elbow, z * 1.05)
    setLimb(r.parts['armUp' + side], sh, el)
    setLimb(r.parts['armLow' + side], el, cm(BARS, z * 1.15))
  }
  setLimb(r.parts.torso, cm(p.hip), cm(p.shoulder))
  r.head.position.copy(cm(p.head))
  // Al ir de pie, la bici se balancea de lado a lado con cada pedalada.
  r.body.rotation.x = p.stand * 0.07 * Math.sin(sim.crank)
  for (const w of r.wheels) w.rotation.z = -sim.wheel
}

// ---------- Ciclo de vida ----------
let cl

function frame(now) {
  const dt = last === null ? 0 : Math.min(0.1, (now - last) / 1000)
  last = now
  const sim = props.sim
  const d = sim.distM

  const p = posAt(cl, d)
  rider.root.position.set(p.x, p.y, p.z)
  rider.root.rotation.y = -p.h
  rider.root.rotation.z = Math.atan((gradeAt(props.route, d) * VERT) / 100)
  poseRider(rider, sim)

  // Imagen nítida: cada medio segundo pide lo que viene y libera lo que quedó atrás.
  if (detail && (detailClock += dt) >= 0.5) {
    detailClock = 0
    detail.update(d)
    detailLoading.value = detail.loading > 0
  }

  // La luz del sol (y su caja de sombras) acompaña al ciclista.
  sun.target.position.set(p.x, p.y, p.z)
  sun.position.set(p.x, p.y, p.z).addScaledVector(sunDir, 120)

  // Cámara de persecución: detrás y arriba, mirando ~20 m adelante para ver el camino que viene.
  const back = posAt(cl, d - 4.5)
  const ahead = posAt(cl, d + 20)
  const target = new THREE.Vector3(back.x, Math.max(back.y, p.y) + 1.9, back.z)
  if (!camReady) {
    camera.position.copy(target)
    camReady = true
  } else {
    camera.position.lerp(target, 1 - Math.exp(-dt * 4))
  }
  camera.lookAt(ahead.x, ahead.y + 0.6, ahead.z)

  renderer.render(scene, camera)
  raf = requestAnimationFrame(frame)
}

function resize() {
  const w = container.value.clientWidth
  const h = Math.round(Math.min(560, Math.max(260, w * 0.5)))
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}

onMounted(async () => {
  const q = QUALITY[props.quality] ?? QUALITY.media
  try {
    renderer = new THREE.WebGLRenderer({ antialias: q.antialias })
  } catch {
    error.value = 'Este equipo o navegador no tiene WebGL disponible, necesario para la vista 3D. Usa la vista 2D.'
    return
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.75
  if (q.shadows) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = q.shadows >= 2048 ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap
  }
  container.value.appendChild(renderer.domElement)

  scene = new THREE.Scene()
  camera = new THREE.PerspectiveCamera(60, 2, 0.1, 12000)
  addSky(q)

  scene.add(new THREE.HemisphereLight('#cfe3ff', '#4b5a3a', 1.1))
  sun = new THREE.DirectionalLight('#fff1dc', 2.6)
  if (q.shadows) {
    sun.castShadow = true
    sun.shadow.mapSize.set(q.shadows, q.shadows)
    const s = sun.shadow.camera
    s.left = s.bottom = -35
    s.right = s.top = 35
    s.near = 10
    s.far = 300
    sun.shadow.bias = -0.0005
    sun.shadow.normalBias = 0.02
  }
  scene.add(sun, sun.target)

  const real = props.landscape !== 'generado' && !!props.route.origen
  // Con relieve real no se exagera la altura: el paisaje debe verse como es.
  VERT = real ? 1 : 1.4

  const seed = Math.abs(hashString(props.route.id)) % 1000
  cl = buildCenterline(props.route, seed)

  scene.add(ribbon(cl, -ROAD_HALF, ROAD_HALF, 0, COLORS.road))
  scene.add(ribbon(cl, ROAD_HALF - 0.25, ROAD_HALF - 0.12, 0.02, COLORS.line))
  scene.add(ribbon(cl, -ROAD_HALF + 0.12, -ROAD_HALF + 0.25, 0.02, COLORS.line))
  scene.add(ribbon(cl, -0.07, 0.07, 0.02, '#facc15', (d) => Math.floor(d / 10) % 2 === 0))
  // Línea de salida.
  scene.add(ribbon(cl, -ROAD_HALF, ROAD_HALF, 0.03, '#f4f4f5', (d) => d >= 0 && d < STEP))
  scene.add(finishArch(cl), kmMarkers(cl))

  rider = buildRider()
  scene.add(rider.root)

  observer = new ResizeObserver(resize)
  observer.observe(container.value)
  resize()
  raf = requestAnimationFrame(frame)

  const addGenerated = () => {
    const terrain = buildTerrain(cl, seed)
    scene.add(terrain.mesh)
    scene.add(...trees(cl, terrain, seed, q.trees))
  }
  if (!real) {
    addGenerated()
    return
  }
  // Paisaje real: se descarga mientras ya se ve el camino y el ciclista.
  loading.value = true
  try {
    const t = await buildRealTerrain({
      cl,
      origen: props.route.origen,
      vert: VERT,
      quality: props.quality,
      imagery: props.landscape,
      apiKey: props.apiKey,
      anisotropy: renderer.capabilities.getMaxAnisotropy(),
      track,
    })
    if (disposed) {
      t.detail?.dispose()
      return
    }
    scene.add(t.group)
    attribution.value = t.attribution
    notice.value = t.warning
    detail = t.detail
    detail?.update(props.sim.distM)
  } catch (err) {
    if (disposed) return
    notice.value = `No se pudo cargar el paisaje real (${err.message}). Se muestra el paisaje generado.`
    addGenerated()
  } finally {
    loading.value = false
  }
})

onBeforeUnmount(() => {
  disposed = true
  detail?.dispose()
  cancelAnimationFrame(raf)
  observer?.disconnect()
  for (const o of disposables) o.dispose?.()
  scene?.traverse((o) => o.isInstancedMesh && o.dispose())
  renderer?.dispose()
  renderer?.domElement.remove()
})
</script>

<template>
  <div ref="container" class="relative w-full overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
    <p v-if="error" class="px-5 py-10 text-center text-sm text-zinc-400">{{ error }}</p>
    <div
      v-if="loading"
      class="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-zinc-950/75 px-3 py-1.5 text-xs text-zinc-200"
    >
      <span class="h-2 w-2 animate-pulse rounded-full bg-sky-400"></span>
      Descargando relieve y satélite… (la imagen nítida puede tardar un poco más)
    </div>
    <div
      v-else-if="detailLoading"
      class="absolute left-3 top-3 flex items-center gap-2 rounded-lg bg-zinc-950/60 px-2.5 py-1 text-[11px] text-zinc-300"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-400"></span>
      Cargando imagen nítida del tramo…
    </div>
    <p v-if="notice" class="absolute left-3 top-3 max-w-[80%] rounded-lg bg-zinc-950/80 px-3 py-1.5 text-xs text-amber-200">
      {{ notice }}
    </p>
    <p
      v-if="attribution"
      class="absolute bottom-0 right-0 max-w-full rounded-tl-md bg-zinc-950/60 px-2 py-0.5 text-[9px] leading-tight text-zinc-300"
    >
      {{ attribution }}
    </p>
  </div>
</template>
