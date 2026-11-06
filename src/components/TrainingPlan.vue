<script setup>
import { computed } from 'vue'
import { LEVEL_FEEL, LEVEL_NAMES, MAIN_SESSIONS, PLAN, ftpFromTest, levelsFromFtp, sessionSeconds } from '../training/plan'
import { WEEK_GOAL, WEEK_MINIMUM } from '../training/week'
import {
  applyTest,
  completed,
  current,
  currentPlanWeek,
  formatClock,
  isActive,
  lastTest,
  levels,
  levelsOrigin,
  nextSession,
  resetPlan,
  restoreLevels,
  setLevels,
  sound,
  startWorkout,
  thisWeekCount,
  thisWeekDays,
  thisWeekStatus,
  toggleCompleted,
} from '../training/workout'

const props = defineProps({ isLive: { type: Boolean, default: false } })
const emit = defineEmits(['ride'])

const minutes = (session) => Math.round(sessionSeconds(session) / 60)
const doneCount = computed(() => MAIN_SESSIONS.filter((s) => completed.value[s.id]).length)
const donePercent = computed(() => Math.round((doneCount.value / MAIN_SESSIONS.length) * 100))
const weekMinutes = (week) => week.sessions.reduce((sum, s) => sum + minutes(s), 0)

const TONE = {
  pendiente: { box: 'border-amber-500/40 bg-amber-500/10', title: 'text-amber-200', bar: 'bg-amber-400' },
  minimo: { box: 'border-sky-500/40 bg-sky-500/10', title: 'text-sky-200', bar: 'bg-sky-400' },
  superado: { box: 'border-emerald-500/40 bg-emerald-500/10', title: 'text-emerald-200', bar: 'bg-emerald-400' },
  completa: { box: 'border-orange-500/50 bg-orange-500/10', title: 'text-orange-200', bar: 'bg-orange-400' },
}
const tone = computed(() => TONE[thisWeekStatus.value.tone])
const weekPercent = computed(() => Math.min(100, (thisWeekCount.value / WEEK_GOAL) * 100))
const minimumMark = `${(WEEK_MINIMUM / WEEK_GOAL) * 100}%`

const ORIGIN = {
  provisional: 'Provisionales, a partir de tus sesiones. Si no coinciden con la sensación, guíate por la sensación.',
  test: 'Calculadas con tu último test.',
  manual: 'Ajustadas a mano.',
}

const testFtp = computed(() => (lastTest.value ? ftpFromTest(lastTest.value.watts) : null))
const testLevels = computed(() => (testFtp.value ? levelsFromFtp(testFtp.value) : null))
const testApplied = computed(
  () => testLevels.value && levelsOrigin.value === 'test' && JSON.stringify(testLevels.value) === JSON.stringify(levels.value),
)

function setLevelValue(level, index, event) {
  const value = Math.round(Number(event.target.value))
  const range = [...levels.value[level]]
  range[index] = value
  // Un valor imposible vuelve al que sigue en uso.
  if (value > 0 && range[0] < range[1]) setLevels({ ...levels.value, [level]: range }, 'manual')
  event.target.value = levels.value[level][index]
}

function start(session) {
  if (
    session.kind === 'test' &&
    !confirm(
      'El test es un esfuerzo alto durante 20 minutos. Si tienes alguna condición cardíaca, tomas medicamentos que afecten el pulso o llevas tiempo sin hacer ejercicio, consulta antes a un médico. Detente si sientes dolor en el pecho, mareo o falta de aire inusual. ¿Empezar?',
    )
  ) {
    return
  }
  startWorkout(session)
}

function confirmReset() {
  if (confirm('¿Borrar el avance del plan? Tus intensidades y tu historial de sesiones se mantienen.')) resetPlan()
}
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-2xl border p-5" :class="tone.box" data-week-panel>
      <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div>
          <h2 class="text-xs font-semibold uppercase tracking-wider text-zinc-400">Esta semana</h2>
          <p class="mt-1 text-xl font-bold" :class="tone.title">{{ thisWeekStatus.title }}</p>
          <p class="mt-1 text-sm text-zinc-300">{{ thisWeekStatus.detail }}</p>
        </div>
        <p class="text-3xl font-bold tabular-nums text-zinc-100">
          {{ thisWeekCount }}<span class="text-lg font-normal text-zinc-400"> / {{ WEEK_GOAL }}</span>
        </p>
      </div>
      <ul class="mt-4 flex flex-wrap gap-2" aria-label="Días con bici esta semana">
        <li
          v-for="d in thisWeekDays"
          :key="d.name"
          class="flex w-12 flex-col items-center rounded-lg border py-1.5 text-xs"
          :class="[
            d.done ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200' : 'border-zinc-700 text-zinc-400',
            d.today && 'ring-1 ring-zinc-300',
          ]"
        >
          {{ d.name }}
          <span class="mt-0.5 text-sm font-bold" :aria-label="d.done ? 'con bici' : 'sin bici'">{{ d.done ? '✓' : '·' }}</span>
        </li>
      </ul>
      <div class="relative mt-4 h-2 rounded-full bg-zinc-800" aria-hidden="true">
        <div class="h-full rounded-full" :class="tone.bar" :style="{ width: `${weekPercent}%` }"></div>
        <div class="absolute -top-1 h-4 w-0.5 bg-zinc-300" :style="{ left: minimumMark }"></div>
      </div>
      <p class="mt-2 text-xs text-zinc-400">
        Mínimo {{ WEEK_MINIMUM }} días, ideal {{ WEEK_GOAL }}. Cuentan las sesiones del plan y cualquier sesión grabada de 15 min o más; un día
        cuenta una vez.
      </p>
    </section>

    <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 class="text-lg font-semibold text-zinc-100">Plan de 12 semanas</h2>
        <p class="text-sm tabular-nums text-zinc-400">{{ doneCount }} de {{ MAIN_SESSIONS.length }} sesiones principales · {{ donePercent }} %</p>
      </div>
      <div class="mt-3 h-2 overflow-hidden rounded-full bg-zinc-800" aria-hidden="true">
        <div class="h-full bg-emerald-500" :style="{ width: `${donePercent}%` }"></div>
      </div>

      <div v-if="isActive" class="mt-4 flex flex-wrap items-center gap-3">
        <p class="text-sm text-zinc-300">En curso: <strong>{{ current.title }}</strong></p>
        <button class="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-orange-400" @click="emit('ride')">
          Ir a Rodar
        </button>
      </div>
      <div v-else-if="nextSession" class="mt-4 flex flex-wrap items-center gap-3">
        <p class="text-sm text-zinc-300">
          Siguiente: semana {{ nextSession.week }}, sesión {{ nextSession.day }} ·
          <strong>{{ nextSession.title }}</strong> ({{ minutes(nextSession) }} min)<template v-if="nextSession.extra"> · opcional</template>
        </p>
        <button
          class="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-orange-400 disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="!props.isLive"
          @click="start(nextSession)"
        >
          Empezar
        </button>
        <span v-if="!props.isLive" class="text-xs text-zinc-400">Conecta la bicicleta o activa el simulador.</span>
      </div>
      <p v-else class="mt-4 text-sm font-semibold text-emerald-300">¡Completaste el plan!</p>

      <p class="mt-3 text-xs text-zinc-400">
        Cada semana trae 5 sesiones para pedalear de lunes a viernes. Si haces menos, prioriza las principales: las
        opcionales son suaves. La semana siguiente del plan se abre al hacer las 5 o, en la semana de calendario siguiente, si
        cumpliste el mínimo. Si no, sigues en la misma.
      </p>
      <p class="mt-2 text-xs text-zinc-400">
        El tiempo solo corre mientras pedaleas. La grabación empieza con el entrenamiento y, si empezó con él, se guarda al
        terminar. Puedes seguirlo mientras ruedas en una ruta o un video.
      </p>
      <label class="mt-2 inline-flex items-center gap-2 text-xs text-zinc-400">
        <input v-model="sound" type="checkbox" class="accent-orange-500" />
        Sonar al cambiar de bloque
      </label>
    </section>

    <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Intensidades</h2>
      <p class="mt-1 text-xs text-zinc-400">{{ ORIGIN[levelsOrigin] }}</p>
      <div class="mt-3 grid gap-3 sm:grid-cols-3">
        <div v-for="(name, key) in LEVEL_NAMES" :key="key" class="rounded-xl border border-zinc-800 p-3">
          <p class="text-sm font-semibold text-zinc-100">{{ name }}</p>
          <p class="text-xs text-zinc-400">{{ LEVEL_FEEL[key] }}</p>
          <div class="mt-2 flex items-center gap-1.5 text-sm text-zinc-300">
            <input
              :value="levels[key][0]"
              type="number"
              min="1"
              :aria-label="`${name}: potencia mínima`"
              class="w-16 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1"
              @change="setLevelValue(key, 0, $event)"
            />
            –
            <input
              :value="levels[key][1]"
              type="number"
              min="1"
              :aria-label="`${name}: potencia máxima`"
              class="w-16 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1"
              @change="setLevelValue(key, 1, $event)"
            />
            W
          </div>
        </div>
      </div>
      <div v-if="lastTest" class="mt-3 rounded-xl border border-orange-500/30 bg-orange-500/5 p-3 text-sm text-zinc-300">
        Último test: <strong>{{ lastTest.watts }} W</strong> durante 20 min → FTP aproximado <strong>{{ testFtp }} W</strong>.
        <template v-if="!testApplied">
          Sugiere: suave {{ testLevels.suave.join('–') }}, moderado {{ testLevels.moderado.join('–') }}, fuerte
          {{ testLevels.fuerte.join('–') }} W.
          <button class="ml-1 font-semibold text-orange-300 hover:text-orange-200" @click="applyTest">Usar estas intensidades</button>
        </template>
      </div>
      <button
        v-if="levelsOrigin !== 'provisional'"
        class="mt-2 text-xs text-zinc-400 hover:text-zinc-300"
        @click="restoreLevels"
      >
        Volver a las intensidades provisionales
      </button>
    </section>

    <section v-for="phase in PLAN" :key="phase.n" class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Fase {{ phase.n }} · {{ phase.name }}</h2>
      <div v-for="week in phase.weeks" :key="week.n" class="mt-4">
        <p class="mb-2 text-xs text-zinc-400">
          Semana {{ week.n }}<template v-if="week.lighter"> · descarga</template> · hasta {{ weekMinutes(week) }} min
          <strong v-if="currentPlanWeek?.n === week.n" class="text-orange-300"> · semana actual</strong>
        </p>
        <ul class="space-y-1.5">
          <li
            v-for="s in week.sessions"
            :key="s.id"
            class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800 px-3 py-2 text-sm"
            :class="completed[s.id] ? 'text-zinc-400' : 'text-zinc-200'"
          >
            <button
              class="flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs"
              :class="completed[s.id] ? 'border-emerald-500 bg-emerald-500/20 text-emerald-300' : 'border-zinc-600'"
              :aria-label="completed[s.id] ? `Desmarcar ${s.title}` : `Marcar ${s.title} como hecha`"
              :aria-pressed="!!completed[s.id]"
              @click="toggleCompleted(s)"
            >
              <span v-if="completed[s.id]">✓</span>
            </button>
            <span class="min-w-40 flex-1">
              Sesión {{ s.day }} · {{ s.title }}
              <span v-if="s.extra" class="ml-1 rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">opcional</span>
            </span>
            <span class="text-xs tabular-nums text-zinc-400">
              <template v-if="completed[s.id]?.potencia !== undefined">
                {{ completed[s.id].potencia }} W · {{ completed[s.id].cadencia }} rpm ·
              </template>
              {{ formatClock(sessionSeconds(s)) }}
            </span>
            <button
              class="rounded-lg border border-zinc-700 px-2.5 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40"
              :disabled="!props.isLive || isActive"
              @click="start(s)"
            >
              Empezar
            </button>
          </li>
        </ul>
      </div>
    </section>

    <section class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5 text-sm text-zinc-400">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Además de la bici</h2>
      <p class="mt-2">
        Suma 2 días de fuerza de 20–30 min: sentadillas, zancadas, flexiones, remo, peso muerto rumano con carga liviana y
        plancha. Estas sesiones no se guían ni se registran aquí.
      </p>
      <p class="mt-2 text-xs text-zinc-400">
        Es una orientación general, no una prescripción médica. Detente si sientes dolor en el pecho, mareo o falta de aire
        inusual.
      </p>
      <button class="mt-3 text-xs text-zinc-400 hover:text-zinc-300" @click="confirmReset">Borrar el avance del plan</button>
    </section>
  </div>
</template>
