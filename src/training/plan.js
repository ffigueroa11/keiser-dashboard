/**
 * Plan de 12 semanas para mejorar la condición física. Cada sesión es una lista de bloques:
 * { label, seconds, level, rpm } con level = suave | moderado | fuerte (objetivo de potencia) o
 * null (sin objetivo: aceleraciones y test), y rpm = [mín, máx] o null (cadencia libre).
 * Cada semana tiene 5 sesiones para pedalear de lunes a viernes: primero las principales y al final
 * las opcionales (extra: true), suaves y en orden que evita dos días fuertes seguidos.
 */

export const LEVEL_NAMES = { suave: 'Suave', moderado: 'Moderado', fuerte: 'Fuerte' }

// Intensidades provisionales, a partir de las sesiones de noviembre de 2026, hasta hacer el test.
export const DEFAULT_LEVELS = { suave: [90, 105], moderado: [115, 130], fuerte: [145, 160] }
export const LEVEL_FEEL = {
  suave: 'Puedes conversar sin problema',
  moderado: 'Hablas con frases cortas',
  fuerte: 'Solo unas pocas palabras',
}

const roundTo5 = (w) => Math.round(w / 5) * 5

/** FTP aproximado: 95 % de la potencia promedio del test de 20 minutos. */
export const ftpFromTest = (watts) => Math.round(watts * 0.95)

export function levelsFromFtp(ftp) {
  const range = (lo, hi) => [roundTo5(ftp * lo), roundTo5(ftp * hi)]
  return { suave: range(0.6, 0.75), moderado: range(0.8, 0.9), fuerte: range(1.05, 1.15) }
}

const block = (minutes, label, level, rpm = null) => ({ label, seconds: Math.round(minutes * 60), level, rpm })
const warmUp = (minutes = 5) => block(minutes, 'Calentamiento', 'suave')
const coolDown = (minutes = 5) => block(minutes, 'Vuelta a la calma', 'suave')

function easy(minutes, rpm) {
  return {
    kind: 'suave',
    title: `${minutes} min suaves`,
    blocks: [warmUp(), block(minutes - 10, 'Suave constante', 'suave', rpm), coolDown()],
  }
}

const extra = (minutes, rpm) => ({ ...easy(minutes, rpm), extra: true })

function moderate(repMinutes, cool, rpm) {
  const rep = (n) => block(repMinutes, `Moderado ${n} de 2`, 'moderado', rpm)
  const blocks = [warmUp(), rep(1), block(3, 'Recuperación', 'suave'), rep(2), coolDown(cool)]
  return { kind: 'moderado', title: `2 × ${repMinutes} min moderados`, blocks }
}

function intervals(reps, cool, rpm) {
  const blocks = [warmUp()]
  for (let i = 1; i <= reps; i++) {
    blocks.push(block(1, `Fuerte ${i} de ${reps}`, 'fuerte', rpm), block(2, 'Recuperación', 'suave'))
  }
  blocks.push(coolDown(cool))
  return { kind: 'intervalos', title: `${reps} × 1 min fuertes`, blocks }
}

function test20() {
  const accel = (n) => block(0.5, `Aceleración ${n} de 3`, null)
  return {
    kind: 'test',
    title: 'Test de 20 min',
    blocks: [
      block(3, 'Calentamiento', 'suave'),
      accel(1),
      block(1.5, 'Calentamiento', 'suave'),
      accel(2),
      block(1.5, 'Calentamiento', 'suave'),
      accel(3),
      block(2.5, 'Calentamiento', 'suave'),
      block(20, 'Test: el mayor esfuerzo que puedas mantener parejo', null),
      block(10, 'Vuelta a la calma', 'suave'),
    ],
  }
}

const SUAVE_2 = [70, 80]
const SUAVE_3 = [75, 85]
const MOD = [70, 85]
const FUERTE = [75, 90]

const phase1Week = (rpm) => [easy(35, rpm), easy(35, rpm), easy(35, rpm), extra(30, rpm), extra(30, rpm)]
const phase2Week = () => [
  easy(45, SUAVE_2),
  moderate(10, 7, MOD),
  easy(45, SUAVE_2),
  intervals(6, 7, FUERTE),
  extra(30, SUAVE_2),
]
const phase3Week = () => [
  intervals(8, 5, FUERTE),
  easy(50, SUAVE_3),
  moderate(15, 5, MOD),
  easy(60, SUAVE_3),
  extra(30, SUAVE_3),
]
// Semana de descarga: menos volumen, y el test después de dos días suaves.
const lighterWeek = (first, second, rpm) => [easy(first, rpm), easy(second, rpm), test20(), extra(20, rpm), extra(20, rpm)]

const PHASES = [
  {
    name: 'Base y cadencia',
    weeks: [phase1Week([65, 70]), phase1Week([65, 75]), phase1Week([70, 75]), lighterWeek(20, 20, [65, 75])],
  },
  {
    name: 'Más constancia',
    weeks: [phase2Week(), phase2Week(), phase2Week(), lighterWeek(35, 30, SUAVE_2)],
  },
  {
    name: 'Consolidar',
    weeks: [phase3Week(), phase3Week(), phase3Week(), lighterWeek(45, 40, SUAVE_3)],
  },
]

export const sessionSeconds = (session) => session.blocks.reduce((sum, b) => sum + b.seconds, 0)

/** Fases → semanas → sesiones, con id estable para guardar el avance. */
export const PLAN = (() => {
  let week = 0
  return PHASES.map((phase, p) => ({
    n: p + 1,
    name: phase.name,
    weeks: phase.weeks.map((sessions, w) => {
      week++
      const weekNumber = week
      return {
        n: weekNumber,
        lighter: w === phase.weeks.length - 1,
        sessions: sessions.map((s, d) => ({ ...s, id: `s${weekNumber}-${d + 1}`, week: weekNumber, day: d + 1 })),
      }
    }),
  }))
})()

export const PLAN_WEEKS = PLAN.flatMap((phase) => phase.weeks)
export const ALL_SESSIONS = PLAN_WEEKS.flatMap((week) => week.sessions)
export const MAIN_SESSIONS = ALL_SESSIONS.filter((s) => !s.extra)
