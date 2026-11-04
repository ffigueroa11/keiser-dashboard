import { ref, computed, onBeforeUnmount } from 'vue'

const STORAGE_KEY = 'keiser.sessions'
const SAMPLE_MS = 1000
// Puntos máximos de la serie que se guarda en el historial (localStorage es limitado).
const MAX_SERIES_POINTS = 300

const pad = (n) => String(n).padStart(2, '0')

function fileNameFor(date) {
  const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const t = `${pad(date.getHours())}${pad(date.getMinutes())}`
  return `sesion-keiser-${d}-${t}.json`
}

function downloadJson(data, fileName) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function loadHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveHistory(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
    return true
  } catch {
    return false
  }
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds))
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`
}

/**
 * Reduce las muestras a como máximo MAX_SERIES_POINTS tramos de `paso` segundos:
 * potencia y cadencia promediadas, marcha = última del tramo.
 */
export function buildSeries(records) {
  const paso = Math.max(1, Math.ceil(records.length / MAX_SERIES_POINTS))
  const watts = []
  const rpm = []
  const marcha = []
  for (let i = 0; i < records.length; i += paso) {
    const chunk = records.slice(i, i + paso)
    watts.push(Math.round(chunk.reduce((s, r) => s + r.watts, 0) / chunk.length))
    rpm.push(Math.round(chunk.reduce((s, r) => s + r.rpm, 0) / chunk.length))
    marcha.push(chunk.findLast((r) => r.marcha !== undefined)?.marcha ?? null)
  }
  return { paso, watts, rpm, marcha: marcha.some((g) => g !== null) ? marcha : [] }
}

function computeStats(list) {
  if (!list.length) return { avgWatts: 0, maxWatts: 0, avgRpm: 0, avgGear: null, maxGear: null }
  let sumW = 0
  let sumR = 0
  let maxW = 0
  let sumG = 0
  let nG = 0
  let maxG = null
  for (const r of list) {
    sumW += r.watts
    sumR += r.rpm
    if (r.watts > maxW) maxW = r.watts
    if (r.marcha !== undefined) {
      sumG += r.marcha
      nG++
      if (maxG === null || r.marcha > maxG) maxG = r.marcha
    }
  }
  return {
    avgWatts: Math.round(sumW / list.length),
    maxWatts: maxW,
    avgRpm: Math.round(sumR / list.length),
    avgGear: nG ? Math.round((sumG / nG) * 10) / 10 : null,
    maxGear: maxG,
  }
}

function buildSummary(data, startMs, wallSeconds, fileName) {
  const stats = computeStats(data)
  // Manda la consola: tiempo, calorías y distancia son los que marcaba, aunque se empezara a grabar
  // tarde o hubiera que reconectar. Se toma su mayor tiempo por si se reinició antes de finalizar.
  const peak = data.reduce((best, r) => ((r.tiempoBici ?? -1) >= (best.tiempoBici ?? -1) ? r : best))
  return {
    id: `${startMs}`,
    fecha: new Date(startMs).toISOString(),
    duracionSeg: peak.tiempoBici ?? wallSeconds,
    wattsPromedio: stats.avgWatts,
    wattsMax: stats.maxWatts,
    rpmPromedio: stats.avgRpm,
    marchaPromedio: stats.avgGear,
    marchaMax: stats.maxGear,
    calorias: peak.calorias ?? null,
    distanciaKm: peak.distanciaKm ?? null,
    muestras: data.length,
    archivo: fileName,
    serie: buildSeries(data),
  }
}

const isSessionData = (data) =>
  Array.isArray(data) &&
  data.length > 0 &&
  data.every((r) => Number.isFinite(Date.parse(r?.timestamp)) && Number.isFinite(r.watts) && Number.isFinite(r.rpm))

/**
 * Graba una muestra por segundo a partir de los refs de la bicicleta:
 * { timestamp, watts, rpm } y, si la fuente los envía, tiempoBici, marcha, calorias, distanciaKm.
 */
export function useSession({ watts, rpm, bikeSeconds, gear, calories, distanceKm }) {
  const records = ref([])
  const isRecording = ref(false)
  const startedAt = ref(null)
  const elapsedSeconds = ref(0)
  const history = ref(loadHistory())
  const notice = ref('')

  let timer = null

  const liveStats = computed(() => computeStats(records.value))

  function sample() {
    const record = {
      timestamp: new Date().toISOString(),
      watts: watts.value,
      rpm: rpm.value,
    }
    if (bikeSeconds.value !== null) record.tiempoBici = bikeSeconds.value
    if (gear.value !== null) record.marcha = gear.value
    if (calories.value !== null) record.calorias = calories.value
    if (distanceKm.value !== null) record.distanciaKm = distanceKm.value
    records.value.push(record)
    elapsedSeconds.value = Math.round((Date.now() - startedAt.value) / 1000)
  }

  function start() {
    if (isRecording.value) return
    notice.value = ''
    records.value = []
    startedAt.value = Date.now()
    elapsedSeconds.value = 0
    isRecording.value = true
    timer = setInterval(sample, SAMPLE_MS)
  }

  function finish() {
    if (!isRecording.value) return null
    clearInterval(timer)
    timer = null
    isRecording.value = false

    const data = records.value
    if (!data.length) {
      notice.value = 'La sesión no tiene registros (duró menos de 1 segundo). No se exportó nada.'
      return null
    }

    const fileName = fileNameFor(new Date(startedAt.value))
    downloadJson(data, fileName)

    const wallSeconds = Math.round((Date.now() - startedAt.value) / 1000)
    const summary = buildSummary(data, startedAt.value, wallSeconds, fileName)

    history.value = [summary, ...history.value]
    notice.value = saveHistory(history.value)
      ? `Sesión guardada y exportada como ${fileName}.`
      : `Se exportó ${fileName}, pero no se pudo guardar el resumen en localStorage.`
    return summary
  }

  /** Carga archivos exportados. Si la sesión ya estaba, se reemplaza por lo que calcula el archivo. */
  async function importFiles(files) {
    const list = [...history.value]
    let added = 0
    let updated = 0
    const failed = []
    for (const file of files) {
      let data = null
      try {
        data = JSON.parse(await file.text())
      } catch {
        // se informa abajo, junto con los archivos que no son sesiones
      }
      if (!isSessionData(data)) {
        failed.push(file.name)
        continue
      }
      const startMs = Date.parse(data[0].timestamp)
      const wallSeconds = Math.round((Date.parse(data[data.length - 1].timestamp) - startMs) / 1000) + 1
      const summary = buildSummary(data, startMs, wallSeconds, file.name)
      // Al grabar, la fecha es la de inicio y la primera muestra llega un segundo después.
      const i = list.findIndex((s) => Math.abs(Date.parse(s.fecha) - startMs) < 5000)
      if (i >= 0) {
        list[i] = summary
        updated++
      } else {
        list.push(summary)
        added++
      }
    }
    list.sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha))
    history.value = list
    const saved = saveHistory(list)
    const parts = []
    if (added) parts.push(`${added} ${added === 1 ? 'sesión cargada' : 'sesiones cargadas'}`)
    if (updated) parts.push(`${updated} ${updated === 1 ? 'sesión actualizada' : 'sesiones actualizadas'}`)
    if (failed.length) parts.push(`no son sesiones válidas: ${failed.join(', ')}`)
    if (!saved) parts.push('no se pudo guardar en localStorage')
    notice.value = `${parts.join(' · ')}.`
  }

  function deleteSession(id) {
    history.value = history.value.filter((s) => s.id !== id)
    saveHistory(history.value)
  }

  function clearHistory() {
    history.value = []
    saveHistory([])
  }

  // Evita perder una sesión en curso al cerrar o recargar la pestaña.
  const beforeUnload = (e) => {
    if (isRecording.value) {
      e.preventDefault()
      e.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', beforeUnload)

  onBeforeUnmount(() => {
    clearInterval(timer)
    window.removeEventListener('beforeunload', beforeUnload)
  })

  return {
    records,
    isRecording,
    elapsedSeconds,
    liveStats,
    history,
    notice,
    start,
    finish,
    importFiles,
    deleteSession,
    clearHistory,
  }
}
