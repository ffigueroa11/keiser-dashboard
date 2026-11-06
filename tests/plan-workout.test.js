import { computed, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ALL_SESSIONS, MAIN_SESSIONS, PLAN_WEEKS, ftpFromTest, levelsFromFtp, sessionSeconds } from '../src/training/plan'
import {
  blockIndex,
  completed,
  connectWorkout,
  currentPlanWeek,
  hint,
  isActive,
  lastTest,
  nextSession,
  paused,
  result,
  resetPlan,
  skipBlock,
  startWorkout,
  thisWeekCount,
  totalElapsed,
} from '../src/training/workout'

describe('plan', () => {
  it('tiene 12 semanas de 5 sesiones', () => {
    expect(PLAN_WEEKS).toHaveLength(12)
    expect(PLAN_WEEKS.every((w) => w.sessions.length === 5)).toBe(true)
    expect(ALL_SESSIONS).toHaveLength(60)
    expect(MAIN_SESSIONS).toHaveLength(42)
  })

  it('no tiene ids repetidos ni bloques sin duración', () => {
    expect(new Set(ALL_SESSIONS.map((s) => s.id)).size).toBe(60)
    expect(ALL_SESSIONS.every((s) => s.blocks.every((b) => b.seconds > 0))).toBe(true)
  })

  it('no pone dos sesiones exigentes seguidas', () => {
    const hard = new Set(['moderado', 'intervalos', 'test'])
    for (const week of PLAN_WEEKS) {
      week.sessions.forEach((s, i) => {
        if (i) expect(hard.has(s.kind) && hard.has(week.sessions[i - 1].kind)).toBe(false)
      })
    }
  })

  it('las opcionales son suaves y el test dura 40 min', () => {
    expect(ALL_SESSIONS.filter((s) => s.extra).every((s) => s.kind === 'suave')).toBe(true)
    expect(sessionSeconds(ALL_SESSIONS.find((s) => s.kind === 'test'))).toBe(40 * 60)
  })

  it('calcula intensidades desde el test', () => {
    expect(ftpFromTest(150)).toBe(143)
    expect(levelsFromFtp(143)).toEqual({ suave: [85, 105], moderado: [115, 130], fuerte: [150, 165] })
  })
})

describe('entrenamiento guiado', () => {
  const watts = ref(95)
  const rpm = ref(68)
  const isRecording = ref(false)
  const history = ref([])
  const startRecording = vi.fn(() => (isRecording.value = true))
  const finishRecording = vi.fn(() => (isRecording.value = false))
  connectWorkout({
    watts,
    rpm,
    heartRate: ref(null),
    isLive: computed(() => true),
    isRecording,
    history,
    startRecording,
    finishRecording,
  })

  const session = ALL_SESSIONS.find((s) => s.id === 's1-1')
  const ride = (seconds) => vi.advanceTimersByTime(seconds * 1000)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 6, 10))
    watts.value = 95
    rpm.value = 68
    isRecording.value = false
    resetPlan()
    result.value = null
    startRecording.mockClear()
    finishRecording.mockClear()
  })

  afterEach(() => vi.useRealTimers())

  it('completa la sesión, la marca hecha y maneja la grabación', () => {
    startWorkout(session)
    expect(startRecording).toHaveBeenCalledOnce()
    ride(35 * 60 + 2)
    expect(isActive.value).toBe(false)
    expect(result.value).toMatchObject({ estado: 'completado', potencia: 95, cadencia: 68, enPotencia: 100, enCadencia: 100 })
    expect(completed.value['s1-1']).toBeTruthy()
    expect(finishRecording).toHaveBeenCalledOnce()
    expect(thisWeekCount.value).toBe(1)
    expect(nextSession.value.id).toBe('s1-2')
  })

  it('no termina una grabación que ya estaba en curso', () => {
    isRecording.value = true
    startWorkout(session)
    expect(startRecording).not.toHaveBeenCalled()
    ride(35 * 60 + 2)
    expect(finishRecording).not.toHaveBeenCalled()
  })

  it('el tiempo se pausa sin pedalear', () => {
    startWorkout(session)
    ride(10)
    const before = totalElapsed.value
    rpm.value = 0
    ride(20)
    expect(paused.value).toBe(true)
    expect(totalElapsed.value).toBe(before)
    rpm.value = 68
    ride(30 * 60)
    expect(isActive.value).toBe(true)
    ride(6 * 60)
    expect(isActive.value).toBe(false)
  })

  it('saltar todos los bloques no marca la sesión ni suma el día', () => {
    startWorkout(session)
    ride(2)
    skipBlock()
    skipBlock()
    skipBlock()
    expect(result.value.estado).toBe('incompleto')
    expect(completed.value['s1-1']).toBeUndefined()
    expect(thisWeekCount.value).toBe(0)
  })

  it('terminar la grabación por fuera detiene el entrenamiento', async () => {
    startWorkout(session)
    await nextTick() // Vue debe ver primero que la grabación empezó
    ride(60)
    isRecording.value = false
    await nextTick()
    expect(isActive.value).toBe(false)
    expect(result.value.estado).toBe('detenido')
    expect(completed.value['s1-1']).toBeUndefined()
  })

  it('el test entrega su promedio solo si se hacen los 20 min', () => {
    const test = ALL_SESSIONS.find((s) => s.id === 's4-3')
    lastTest.value = null
    watts.value = 150
    startWorkout(test)
    ride(40 * 60 + 2)
    expect(result.value.testWatts).toBe(150)
    expect(result.value.enPotencia).toBeNull()
    expect(lastTest.value.watts).toBe(150)
  })

  it('indica qué hacer con la marcha', () => {
    startWorkout(session)
    ride(5 * 60 + 1)
    expect(blockIndex.value).toBe(1)
    expect(hint.value).toBe('')
    rpm.value = 55
    expect(hint.value).toBe('Baja una marcha y pedalea más rápido')
    rpm.value = 68
    watts.value = 70
    expect(hint.value).toBe('Sube una marcha')
    watts.value = 120
    expect(hint.value).toBe('Baja una marcha')
    skipBlock()
    skipBlock()
  })

  it('avanza de semana del plan según el calendario', () => {
    const mark = (ids, fecha) => (completed.value = Object.fromEntries(ids.map((id) => [id, { fecha, manual: true }])))
    const lastWeek = new Date(2026, 9, 30, 12).toISOString()
    const thisWeek = new Date(2026, 10, 3, 12).toISOString()

    mark(['s1-1', 's1-2'], lastWeek)
    expect(currentPlanWeek.value.n).toBe(1)
    mark(['s1-1', 's1-2', 's1-3'], lastWeek)
    expect(currentPlanWeek.value.n).toBe(2)
    mark(['s1-1', 's1-2', 's1-3'], thisWeek)
    expect(currentPlanWeek.value.n).toBe(1)
    expect(nextSession.value.id).toBe('s1-4')
    mark(['s1-1', 's1-2', 's1-3', 's1-4', 's1-5'], thisWeek)
    expect(currentPlanWeek.value.n).toBe(2)
    mark(ALL_SESSIONS.map((s) => s.id), lastWeek)
    expect(nextSession.value).toBeNull()
  })
})
