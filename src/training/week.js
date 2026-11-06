/** Semana de calendario (lunes a domingo, hora local) y estado frente a la meta semanal. */
export const WEEK_MINIMUM = 3
export const WEEK_GOAL = 5
// Una sesión grabada cuenta como día de bici desde este largo (muestras a 1 por segundo).
export const MIN_RIDE_SAMPLES = 15 * 60

const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

export function mondayOf(date) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

const dayKey = (date) => {
  const d = new Date(date)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/**
 * Días de la semana de `now`, con cuáles tienen bici. Los de lunes a viernes se muestran siempre;
 * sábado y domingo, solo si se pedaleó.
 */
export function weekDays(rideDates, now = new Date()) {
  const monday = mondayOf(now)
  const ridden = new Set(rideDates.map(dayKey))
  return DAY_NAMES.map((name, i) => {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    return { name, done: ridden.has(dayKey(d)), today: dayKey(d) === dayKey(now), weekend: i >= 5 }
  }).filter((d) => !d.weekend || d.done)
}

/** Mensaje según los días con bici de la semana. tone: pendiente | minimo | superado | completa */
export function weekStatus(count) {
  if (count >= WEEK_GOAL) {
    return { tone: 'completa', title: '¡Semana completa!', detail: `Hiciste ${count} días de bici esta semana.` }
  }
  if (count > WEEK_MINIMUM) {
    const left = WEEK_GOAL - count
    return {
      tone: 'superado',
      title: '¡Felicidades! Superaste el mínimo',
      detail: `Llevas ${count} de ${WEEK_GOAL} días. ${left === 1 ? 'Te falta 1 sesión' : `Te faltan ${left} sesiones`} para la semana completa.`,
    }
  }
  if (count === WEEK_MINIMUM) {
    return {
      tone: 'minimo',
      title: '¡Mínimo cumplido!',
      detail: `Llevas ${count} de ${WEEK_GOAL} días. Una sesión más y superas el mínimo.`,
    }
  }
  const left = WEEK_MINIMUM - count
  return {
    tone: 'pendiente',
    title: left === 1 ? 'Te falta 1 sesión para completar el mínimo' : `Te faltan ${left} sesiones para completar el mínimo`,
    detail: `Llevas ${count} de ${WEEK_MINIMUM} días mínimos de esta semana.`,
  }
}
