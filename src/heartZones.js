import { ref, watch } from 'vue'

/**
 * Zonas de pulso (Z1–Z5) como porcentaje del pulso máximo, el modelo más común en ciclismo:
 * Z1 < 60 %, Z2 60–70 %, Z3 70–80 %, Z4 80–90 %, Z5 ≥ 90 %.
 * El pulso máximo lo configura el usuario y queda guardado en este navegador.
 * Las clases de Tailwind van escritas completas para que Tailwind las detecte.
 */
export const ZONES = [
  { n: 1, nombre: 'Recuperación', desde: 0, bar: 'bg-sky-400', text: 'text-sky-300', band: 'fill-sky-400/10' },
  { n: 2, nombre: 'Resistencia', desde: 0.6, bar: 'bg-emerald-400', text: 'text-emerald-300', band: 'fill-emerald-400/10' },
  { n: 3, nombre: 'Tempo', desde: 0.7, bar: 'bg-yellow-400', text: 'text-yellow-300', band: 'fill-yellow-400/10' },
  { n: 4, nombre: 'Umbral', desde: 0.8, bar: 'bg-orange-400', text: 'text-orange-300', band: 'fill-orange-400/10' },
  { n: 5, nombre: 'Máximo', desde: 0.9, bar: 'bg-red-500', text: 'text-red-400', band: 'fill-red-500/10' },
]

const STORAGE_KEY = 'keiser.pulsoMax'
export const DEFAULT_HR_MAX = 190

export const isValidHrMax = (v) => Number.isFinite(v) && v >= 100 && v <= 230

function load() {
  try {
    const v = Number(localStorage.getItem(STORAGE_KEY))
    return isValidHrMax(v) ? v : DEFAULT_HR_MAX
  } catch {
    return DEFAULT_HR_MAX
  }
}

const PULSE_JUMP_LPM = 25
const PULSE_GAP_MS = 10000
const PULSE_SETTLE_MS = 30000

/**
 * Filtro de lecturas falsas del sensor de pulso:
 * - Picos (en una sesión real: 118 → 225 → 119): un salto grande se ignora hasta que una segunda
 *   lectura lo confirme, así un cambio real solo se atrasa una lectura.
 * - Arranque (en una sesión real: 32, 179, 28, 31 con cortes entre medio): al empezar o tras un corte
 *   de 10 s o más, no se usa el pulso hasta tener 30 s seguidos de lecturas.
 * next(bpm, atMs) devuelve el pulso que se debe usar, o null mientras se estabiliza.
 */
export function createPulseFilter() {
  let last = null
  let pending = null
  let lastAt = null
  let settleFrom = null
  return {
    next(bpm, atMs) {
      if (lastAt === null || atMs - lastAt >= PULSE_GAP_MS) {
        last = null
        pending = null
        settleFrom = atMs
      }
      lastAt = atMs
      const near = (a) => Math.abs(bpm - a) < PULSE_JUMP_LPM
      if (last === null || near(last) || (pending !== null && near(pending))) {
        last = bpm
        pending = null
      } else {
        pending = bpm
      }
      return atMs - settleFrom >= PULSE_SETTLE_MS ? last : null
    },
  }
}

/** Pulso máximo compartido por toda la app. */
export const hrMax = ref(load())
watch(hrMax, (v) => {
  if (!isValidHrMax(v)) return
  try {
    localStorage.setItem(STORAGE_KEY, String(v))
  } catch {
    /* sin almacenamiento: dura solo esta visita */
  }
})

const effectiveMax = (max) => (isValidHrMax(max) ? max : DEFAULT_HR_MAX)

/** Zona de un pulso (null si no hay pulso). */
export function zoneFor(bpm, max = hrMax.value) {
  if (bpm === null || bpm === undefined) return null
  const pct = bpm / effectiveMax(max)
  for (let i = ZONES.length - 1; i >= 0; i--) if (pct >= ZONES[i].desde) return ZONES[i]
  return ZONES[0]
}

// Primer pulso entero que zoneFor cuenta dentro de la zona: la tabla no puede diferir del cálculo.
function firstBpm(desde, max) {
  let bpm = Math.floor(desde * max)
  while (bpm / max < desde) bpm++
  return bpm
}

/** Zonas con sus límites en lpm para un pulso máximo: lo (incluido) y hi (excluido, null en Z5). */
export function zoneRanges(max = hrMax.value) {
  const m = effectiveMax(max)
  return ZONES.map((z, i) => ({
    ...z,
    lo: firstBpm(z.desde, m),
    hi: i < ZONES.length - 1 ? firstBpm(ZONES[i + 1].desde, m) : null,
  }))
}

/**
 * Tiempo en cada zona a partir de una serie de pulso (un valor cada `paso` segundos, null = sin dato).
 * Devuelve las 5 zonas con { secs, pct, w } (w = ancho relativo a la zona con más tiempo).
 */
export function timeInZones(pulso, paso = 1, max = hrMax.value) {
  const secs = ZONES.map(() => 0)
  for (const v of pulso || []) {
    const z = zoneFor(v, max)
    if (z) secs[z.n - 1] += paso
  }
  const total = secs.reduce((a, b) => a + b, 0)
  const top = Math.max(...secs)
  return ZONES.map((z, i) => ({
    ...z,
    secs: secs[i],
    pct: total ? Math.round((secs[i] / total) * 100) : 0,
    w: top ? (secs[i] / top) * 100 : 0,
  }))
}
