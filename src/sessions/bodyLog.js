import { ref } from 'vue'

/** Registro de cintura y peso, por fecha. Se guarda solo en este navegador. */
const KEY = 'keiser.cuerpo'

export const WAIST_RANGE = [40, 200]
export const WEIGHT_RANGE = [30, 300]

function load() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export const bodyLog = ref(load())

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(bodyLog.value))
  } catch {
    /* sin almacenamiento: dura solo esta visita */
  }
}

const inRange = (value, [lo, hi]) => Number.isFinite(value) && value >= lo && value <= hi

/** Guarda una medición; si la fecha ya existe, la reemplaza. Devuelve un mensaje de error o ''. */
export function addBodyEntry({ fecha, cinturaCm, pesoKg }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '')) return 'Elige una fecha.'
  const waist = cinturaCm === '' || cinturaCm === null ? null : Number(cinturaCm)
  const weight = pesoKg === '' || pesoKg === null ? null : Number(pesoKg)
  if (waist === null && weight === null) return 'Ingresa la cintura, el peso o ambos.'
  if (waist !== null && !inRange(waist, WAIST_RANGE)) return `La cintura debe estar entre ${WAIST_RANGE[0]} y ${WAIST_RANGE[1]} cm.`
  if (weight !== null && !inRange(weight, WEIGHT_RANGE)) return `El peso debe estar entre ${WEIGHT_RANGE[0]} y ${WEIGHT_RANGE[1]} kg.`
  const entry = { fecha, cinturaCm: waist, pesoKg: weight }
  bodyLog.value = [...bodyLog.value.filter((e) => e.fecha !== fecha), entry].sort((a, b) => a.fecha.localeCompare(b.fecha))
  save()
  return ''
}

export function removeBodyEntry(fecha) {
  bodyLog.value = bodyLog.value.filter((e) => e.fecha !== fecha)
  save()
}

/** Primera y última medición de un campo, con su diferencia. null si hay menos de dos. */
export function bodyChange(list, field) {
  const values = list.filter((e) => e[field] !== null)
  if (values.length < 2) return null
  return Math.round((values[values.length - 1][field] - values[0][field]) * 10) / 10
}
