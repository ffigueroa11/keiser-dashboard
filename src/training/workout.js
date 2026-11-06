import { computed, ref, shallowRef, watch } from 'vue'
import { DEFAULT_LEVELS, PLAN_WEEKS, ftpFromTest, levelsFromFtp, sessionSeconds } from './plan'
import { MIN_RIDE_SAMPLES, WEEK_MINIMUM, mondayOf, weekDays, weekStatus } from './week'

/**
 * Entrenamiento guiado en curso. Es un estado único de la app: lo controla la pestaña Plan y lo
 * muestran la franja de la barra superior y la de pantalla completa. El tiempo solo corre mientras
 * se pedalea, y la grabación se inicia y se termina sola si no estaba activa antes.
 */
const STORAGE_KEY = 'keiser.plan'
const TICK_MS = 1000
const MAX_TICK_S = 10 // si el navegador frena la página, no se cuenta más que esto de una vez
const TEST_MIN_SECONDS = 19.5 * 60

function loadProgress() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}
  } catch {
    return {}
  }
}

const saved = loadProgress()

export const completed = ref(saved.completed || {})
export const levels = ref(saved.levels || DEFAULT_LEVELS)
export const levelsOrigin = ref(saved.levelsOrigin || 'provisional')
export const lastTest = ref(saved.lastTest || null)
export const sound = ref(saved.sound ?? true)

function saveProgress() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        completed: completed.value,
        levels: levels.value,
        levelsOrigin: levelsOrigin.value,
        lastTest: lastTest.value,
        sound: sound.value,
      }),
    )
  } catch {
    /* sin almacenamiento: el avance dura solo esta visita */
  }
}
watch(sound, saveProgress)

const deps = shallowRef(null)

export const current = shallowRef(null) // sesión en curso
export const blockIndex = ref(0)
export const blockElapsed = ref(0)
export const totalElapsed = ref(0)
export const paused = ref(false)
export const result = ref(null) // resumen del último entrenamiento terminado

export const isActive = computed(() => current.value !== null)
export const block = computed(() => current.value?.blocks[blockIndex.value] ?? null)
export const nextBlock = computed(() => current.value?.blocks[blockIndex.value + 1] ?? null)
export const blockRemaining = computed(() => (block.value ? Math.max(0, block.value.seconds - blockElapsed.value) : 0))
export const totalSeconds = computed(() => (current.value ? sessionSeconds(current.value) : 0))
export const wattsNow = computed(() => deps.value?.watts.value ?? 0)
export const rpmNow = computed(() => deps.value?.rpm.value ?? 0)
export const heartRateNow = computed(() => deps.value?.heartRate.value ?? null)
export const wattsTarget = computed(() => (block.value?.level ? levels.value[block.value.level] : null))
export const rpmTarget = computed(() => block.value?.rpm ?? null)

const position = (value, range) => {
  if (!range) return null
  if (value < range[0]) return 'bajo'
  return value > range[1] ? 'alto' : 'ok'
}
export const wattsStatus = computed(() => position(wattsNow.value, wattsTarget.value))
export const rpmStatus = computed(() => position(rpmNow.value, rpmTarget.value))

/** Qué hacer con la marcha o la cadencia para volver al objetivo. */
export const hint = computed(() => {
  const w = wattsStatus.value
  const r = rpmStatus.value
  if (r === 'bajo') return w === 'alto' || w === 'ok' ? 'Baja una marcha y pedalea más rápido' : 'Pedalea más rápido'
  if (r === 'alto') return w === 'bajo' || w === 'ok' ? 'Sube una marcha y pedalea más lento' : 'Pedalea más lento'
  if (w === 'bajo') return 'Sube una marcha'
  if (w === 'alto') return 'Baja una marcha'
  return ''
})

let timer = 0
let lastTick = 0
let startedRecording = false
let ending = false
let skippedBlocks = false
let stats = null
let audio = null

function beep() {
  if (!sound.value) return
  try {
    audio ||= new AudioContext()
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()
    oscillator.frequency.value = 880
    gain.gain.value = 0.15
    oscillator.connect(gain).connect(audio.destination)
    oscillator.start()
    oscillator.stop(audio.currentTime + 0.25)
  } catch {
    /* sin audio: basta con lo que se ve en pantalla */
  }
}

function accumulate(dt) {
  const w = wattsNow.value
  const r = rpmNow.value
  const hr = heartRateNow.value
  stats.seconds += dt
  stats.watts += w * dt
  stats.rpm += r * dt
  if (hr !== null) {
    stats.hr += hr * dt
    stats.hrSeconds += dt
  }
  if (wattsTarget.value) {
    stats.wattsTargetSeconds += dt
    if (wattsStatus.value === 'ok') stats.wattsInRange += dt
  }
  if (rpmTarget.value) {
    stats.rpmTargetSeconds += dt
    if (rpmStatus.value === 'ok') stats.rpmInRange += dt
  }
  if (block.value.seconds === 20 * 60 && current.value.kind === 'test') {
    stats.testWatts += w * dt
    stats.testSeconds += dt
  }
}

function moveToNextBlock() {
  blockIndex.value++
  blockElapsed.value = 0
  if (blockIndex.value >= current.value.blocks.length) end('completado')
  else beep()
}

function tick() {
  const now = Date.now()
  const dt = Math.min((now - lastTick) / 1000, MAX_TICK_S)
  lastTick = now
  if (!current.value) return
  paused.value = rpmNow.value <= 0
  if (paused.value) return
  accumulate(dt)
  totalElapsed.value += dt
  let elapsed = blockElapsed.value + dt
  // Si el tiempo cruza el final del bloque, lo que sobra ya es del siguiente.
  while (current.value && elapsed >= block.value.seconds) {
    elapsed -= block.value.seconds
    moveToNextBlock()
  }
  if (current.value) blockElapsed.value = elapsed
}

const percent = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null)

function end(state) {
  const session = current.value
  clearInterval(timer)
  current.value = null
  paused.value = false
  beep()

  const s = stats
  const testWatts = s.testSeconds >= TEST_MIN_SECONDS ? Math.round(s.testWatts / s.testSeconds) : null
  result.value = {
    estado: state,
    id: session.id,
    titulo: session.title,
    semana: session.week,
    dia: session.day,
    segundos: Math.round(s.seconds),
    potencia: s.seconds ? Math.round(s.watts / s.seconds) : 0,
    cadencia: s.seconds ? Math.round(s.rpm / s.seconds) : 0,
    pulso: s.hrSeconds ? Math.round(s.hr / s.hrSeconds) : null,
    // En el test solo el calentamiento tiene objetivo: el porcentaje no diría nada del esfuerzo.
    enPotencia: session.kind === 'test' ? null : percent(s.wattsInRange, s.wattsTargetSeconds),
    enCadencia: percent(s.rpmInRange, s.rpmTargetSeconds),
    bloquesSaltados: skippedBlocks,
    testWatts,
  }
  if (state === 'completado') {
    completed.value = { ...completed.value, [session.id]: { fecha: new Date().toISOString(), ...result.value } }
  }
  if (testWatts !== null) lastTest.value = { fecha: new Date().toISOString(), watts: testWatts }
  saveProgress()

  ending = true
  if (startedRecording && deps.value.isRecording.value) deps.value.finishRecording()
  ending = false
  startedRecording = false
}

/** Une el entrenamiento a los datos de la bicicleta y a la grabación. Se llama una vez, desde App. */
export function connectWorkout(dependencies) {
  deps.value = dependencies
  setInterval(() => (now.value = new Date()), 60000) // la app puede quedar abierta de un día a otro
  // Si la grabación termina por fuera (Finalizar o Desconectar), el entrenamiento termina con ella.
  watch(dependencies.isRecording, (recording) => {
    if (!recording && current.value && !ending) {
      startedRecording = false
      end('detenido')
    }
  })
}

export function startWorkout(session) {
  if (current.value || !deps.value?.isLive.value) return false
  result.value = null
  stats = {
    seconds: 0,
    watts: 0,
    rpm: 0,
    hr: 0,
    hrSeconds: 0,
    wattsInRange: 0,
    wattsTargetSeconds: 0,
    rpmInRange: 0,
    rpmTargetSeconds: 0,
    testWatts: 0,
    testSeconds: 0,
  }
  skippedBlocks = false
  blockIndex.value = 0
  blockElapsed.value = 0
  totalElapsed.value = 0
  paused.value = false
  current.value = session
  startedRecording = !deps.value.isRecording.value
  if (startedRecording) deps.value.startRecording()
  lastTick = Date.now()
  timer = setInterval(tick, TICK_MS)
  return true
}

export function skipBlock() {
  if (!current.value) return
  skippedBlocks = true
  moveToNextBlock()
}

export function stopWorkout() {
  if (current.value) end('detenido')
}

export const dismissResult = () => (result.value = null)

const now = ref(new Date())
const isDone = (session) => !!completed.value[session.id]

// Días con bici: sesiones del plan y sesiones grabadas de al menos 15 min, aunque sean libres.
const rideDates = computed(() => [
  ...Object.values(completed.value).map((c) => c.fecha),
  ...(deps.value?.history.value ?? []).filter((s) => s.muestras >= MIN_RIDE_SAMPLES).map((s) => s.fecha),
])
export const thisWeekDays = computed(() => weekDays(rideDates.value, now.value))
export const thisWeekCount = computed(() => thisWeekDays.value.filter((d) => d.done).length)
export const thisWeekStatus = computed(() => weekStatus(thisWeekCount.value))

/**
 * Semana del plan en curso. Se pasa a la siguiente al hacer sus 5 sesiones o, ya en otra semana de
 * calendario, si se alcanzó el mínimo. Sin el mínimo, la misma semana del plan continúa.
 */
export const currentPlanWeek = computed(() => {
  const monday = mondayOf(now.value)
  return (
    PLAN_WEEKS.find((week) => {
      const done = week.sessions.filter(isDone)
      if (done.length === week.sessions.length) return false
      const lastDone = Math.max(...done.map((s) => Date.parse(completed.value[s.id].fecha)), 0)
      return !(done.length >= WEEK_MINIMUM && lastDone < monday.getTime())
    }) ?? null
  )
})

/** Primero las sesiones principales de la semana y luego las opcionales. */
export const nextSession = computed(() => {
  const sessions = currentPlanWeek.value?.sessions.filter((s) => !isDone(s)) ?? []
  return sessions.find((s) => !s.extra) ?? sessions[0] ?? null
})

export function toggleCompleted(session) {
  const next = { ...completed.value }
  if (next[session.id]) delete next[session.id]
  else next[session.id] = { fecha: new Date().toISOString(), manual: true }
  completed.value = next
  saveProgress()
}

export function resetPlan() {
  completed.value = {}
  saveProgress()
}

export function setLevels(value, origin) {
  levels.value = value
  levelsOrigin.value = origin
  saveProgress()
}

export const applyTest = () => setLevels(levelsFromFtp(ftpFromTest(lastTest.value.watts)), 'test')
export const restoreLevels = () => setLevels(DEFAULT_LEVELS, 'provisional')

export function formatClock(totalSec) {
  const s = Math.max(0, Math.ceil(totalSec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
