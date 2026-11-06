/** Cálculos sobre sesiones ya grabadas: mejores marcas, avance por semana y análisis en palabras. */
import { MIN_RIDE_SAMPLES, WEEK_MINIMUM, WEEK_GOAL, mondayOf } from '../training/week'

export const MARK_SECONDS = [60, 300, 1200]
const CADENCE_GOOD_RPM = 70
const STEADY_POWER_DIFF = 0.1
const MIN_DRIFT_SECONDS = 20 * 60

const avg = (list) => list.reduce((sum, x) => sum + x, 0) / list.length

/** Mayor promedio de una ventana de `size` valores; null si no alcanza. */
function bestWindow(values, size) {
  if (size < 1 || values.length < size) return null
  let sum = 0
  for (let i = 0; i < size; i++) sum += values[i]
  let best = sum
  for (let i = size; i < values.length; i++) {
    sum += values[i] - values[i - size]
    if (sum > best) best = sum
  }
  return Math.round(best / size)
}

/** Mejores potencias de 1, 5 y 20 minutos a partir de las muestras de 1 segundo. */
export function bestEfforts(records) {
  const watts = records.map((r) => r.watts)
  return Object.fromEntries(MARK_SECONDS.map((s) => [s, bestWindow(watts, s)]))
}

/** Marcas de una sesión; las guardadas antes de calcularlas se aproximan con su serie reducida. */
export function marksOf(session) {
  if (session.mejores) return session.mejores
  const serie = session.serie
  if (!serie?.watts?.length) return Object.fromEntries(MARK_SECONDS.map((s) => [s, null]))
  return Object.fromEntries(MARK_SECONDS.map((s) => [s, bestWindow(serie.watts, Math.round(s / serie.paso))]))
}

export function bestMarks(history) {
  return Object.fromEntries(
    MARK_SECONDS.map((seconds) => {
      let best = null
      for (const session of history) {
        const value = marksOf(session)[seconds]
        if (value !== null && (best === null || value > best.value)) best = { value, fecha: session.fecha }
      }
      return [seconds, best]
    }),
  )
}

const isFullRide = (session) => session.muestras >= MIN_RIDE_SAMPLES

/** Sesiones completas de más antigua a más nueva. */
export const fullRides = (history) =>
  history.filter(isFullRide).sort((a, b) => Date.parse(a.fecha) - Date.parse(b.fecha))

/** Vatios por latido de una sesión; null sin pulso. */
export const efficiencyOf = (session) =>
  session.pulsoPromedio ? Math.round((session.wattsPromedio / session.pulsoPromedio) * 100) / 100 : null

/**
 * Resumen de las últimas `count` semanas, de más antigua a más nueva. Minutos, km y kcal son los de la
 * consola; `planDates` suma los días con sesiones del plan marcadas a mano.
 */
export function weeklySummaries(history, planDates = [], now = new Date(), count = 8) {
  const weeks = []
  const thisMonday = mondayOf(now)
  for (let i = count - 1; i >= 0; i--) {
    const start = new Date(thisMonday)
    start.setDate(start.getDate() - i * 7)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    const inWeek = (fecha) => {
      const t = Date.parse(fecha)
      return t >= start.getTime() && t < end.getTime()
    }
    const rides = history.filter((s) => isFullRide(s) && inWeek(s.fecha))
    const days = new Set(
      [...rides.map((s) => s.fecha), ...planDates.filter(inWeek)].map((f) => new Date(f).toDateString()),
    ).size
    weeks.push({
      inicio: start,
      dias: days,
      sesiones: rides.length,
      minutos: Math.round(rides.reduce((sum, s) => sum + (s.duracionSeg || 0), 0) / 60),
      kcal: rides.reduce((sum, s) => sum + (s.calorias || 0), 0),
      km: Math.round(rides.reduce((sum, s) => sum + (s.distanciaKm || 0), 0) * 10) / 10,
      estado: days >= WEEK_GOAL ? 'Completa' : days > WEEK_MINIMUM ? 'Superó el mínimo' : days === WEEK_MINIMUM ? 'Mínimo' : 'Bajo el mínimo',
    })
  }
  return weeks
}

/** Cambio de vatios por latido entre la primera y la segunda mitad, solo a potencia pareja. */
function pulseDrift(session) {
  const serie = session.serie
  if (!serie?.pulso?.length) return null
  const points = serie.watts
    .map((w, i) => ({ w, r: serie.rpm[i], h: serie.pulso[i] }))
    .filter((p) => p.h !== null && p.r > 0)
  if (points.length * serie.paso < MIN_DRIFT_SECONDS) return null
  const mid = Math.floor(points.length / 2)
  const first = points.slice(0, mid)
  const second = points.slice(mid)
  const w1 = avg(first.map((p) => p.w))
  const w2 = avg(second.map((p) => p.w))
  if (Math.abs(w2 - w1) / w1 > STEADY_POWER_DIFF) return null
  const e1 = w1 / avg(first.map((p) => p.h))
  const e2 = w2 / avg(second.map((p) => p.h))
  return Math.round(((e1 - e2) / e1) * 100)
}

/** Observaciones en palabras. `history` da con qué comparar: solo cuentan sesiones anteriores. */
export function analyzeSession(session, history = []) {
  const notes = []
  const earlier = fullRides(history).filter((s) => Date.parse(s.fecha) < Date.parse(session.fecha))

  const lateSeconds = (session.duracionSeg || 0) - (session.muestras || 0)
  if (lateSeconds > 60 && session.calorias !== null) {
    notes.push(`Se grabaron ${Math.round(session.muestras / 60)} de ${Math.round(session.duracionSeg / 60)} min de la consola: el gráfico no cubre el resto.`)
  }

  const rpm = session.serie?.rpm?.filter((r) => r > 0) ?? []
  if (rpm.length) {
    const share = Math.round((rpm.filter((r) => r >= CADENCE_GOOD_RPM).length / rpm.length) * 100)
    notes.push(`Cadencia promedio ${session.rpmPromedio} rpm, con ${share} % del tiempo en ${CADENCE_GOOD_RPM} rpm o más.`)
  }

  for (const seconds of MARK_SECONDS) {
    const value = marksOf(session)[seconds]
    if (value === null || !earlier.length) continue
    const previous = earlier.map((s) => marksOf(s)[seconds]).filter((v) => v !== null)
    if (previous.length && value > Math.max(...previous)) {
      notes.push(`Nueva mejor marca de ${seconds / 60} min: ${value} W.`)
    }
  }

  const recent = earlier.slice(-5)
  if (recent.length && isFullRide(session)) {
    const base = Math.round(avg(recent.map((s) => s.wattsPromedio)))
    const diff = session.wattsPromedio - base
    const word = diff > 0 ? `${diff} W más que` : diff < 0 ? `${-diff} W menos que` : 'lo mismo que'
    notes.push(`Potencia promedio ${session.wattsPromedio} W: ${word} ${recent.length === 1 ? 'tu última sesión' : `tus últimas ${recent.length} sesiones`} (${base} W).`)
  }

  const drift = pulseDrift(session)
  if (drift !== null) {
    notes.push(
      Math.abs(drift) <= 5
        ? 'El pulso se mantuvo estable para la potencia entregada.'
        : drift > 0
          ? `Para la misma potencia, el pulso subió hacia el final (eficiencia ${drift} % menor).`
          : 'El pulso bajó para la misma potencia durante la sesión.',
    )
  }

  if (session.senal?.reinicios > 0) {
    notes.push(`La escucha de la bici se reinició ${session.senal.reinicios} ${session.senal.reinicios === 1 ? 'vez' : 'veces'} por falta de señal.`)
  }
  return notes
}
