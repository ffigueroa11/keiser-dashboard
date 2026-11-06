<script setup>
import { computed } from 'vue'
import { LEVEL_NAMES } from '../training/plan'
import {
  block,
  blockRemaining,
  current,
  dismissResult,
  formatClock,
  heartRateNow,
  hint,
  isActive,
  nextBlock,
  paused,
  result,
  rpmNow,
  rpmStatus,
  rpmTarget,
  skipBlock,
  stopWorkout,
  thisWeekStatus,
  totalElapsed,
  totalSeconds,
  wattsNow,
  wattsStatus,
  wattsTarget,
} from '../training/workout'

/** Franja del entrenamiento guiado: bloque actual, objetivos y resumen al terminar. */
const STATUS_CLASS = { ok: 'text-emerald-300', bajo: 'text-amber-300', alto: 'text-rose-300' }
const RESULT_TITLE = {
  completado: '✓ Entrenamiento completado',
  incompleto: 'Terminado con bloques saltados: no cuenta como hecho',
  detenido: 'Entrenamiento detenido',
}

const levelName = computed(() => (block.value?.level ? LEVEL_NAMES[block.value.level] : 'Sin objetivo de potencia'))
const progress = computed(() => (totalSeconds.value ? Math.min(100, (totalElapsed.value / totalSeconds.value) * 100) : 0))
const nextLabel = computed(() => {
  if (!nextBlock.value) return 'Último bloque'
  const name = nextBlock.value.level ? ` · ${LEVEL_NAMES[nextBlock.value.level]}` : ''
  return `Sigue: ${nextBlock.value.label}${name}`
})

function confirmStop() {
  if (confirm('¿Detener este entrenamiento? No contará como hecho. Si la grabación empezó con él, se guardará lo grabado.')) {
    stopWorkout()
  }
}
</script>

<template>
  <div v-if="isActive" class="border-t border-zinc-800 bg-zinc-900 text-zinc-100" data-workout-strip>
    <div class="h-1 bg-zinc-800" aria-hidden="true">
      <div class="h-full bg-orange-500" :style="{ width: `${progress}%` }"></div>
    </div>
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-1.5 sm:gap-x-5 sm:gap-y-2 sm:px-6 sm:py-2">
      <div class="min-w-40 flex-1">
        <p class="truncate text-sm font-semibold">{{ block.label }}</p>
        <p class="hidden truncate text-xs text-zinc-400 sm:block">
          Semana {{ current.week }}, sesión {{ current.day }} · {{ levelName }} · {{ nextLabel }}
        </p>
      </div>
      <p class="text-xl font-bold tabular-nums sm:text-2xl" aria-label="Tiempo restante del bloque">{{ formatClock(blockRemaining) }}</p>
      <p class="text-sm tabular-nums">
        <strong :class="STATUS_CLASS[wattsStatus]">{{ wattsNow }} W</strong>
        <span v-if="wattsTarget" class="text-xs text-zinc-400"> objetivo {{ wattsTarget[0] }}–{{ wattsTarget[1] }}</span>
      </p>
      <p class="text-sm tabular-nums">
        <strong :class="STATUS_CLASS[rpmStatus]">{{ rpmNow }} rpm</strong>
        <span v-if="rpmTarget" class="text-xs text-zinc-400"> objetivo {{ rpmTarget[0] }}–{{ rpmTarget[1] }}</span>
      </p>
      <p v-if="heartRateNow !== null" class="text-sm tabular-nums"><span class="text-rose-400">♥</span> {{ heartRateNow }} lpm</p>
      <p v-if="paused" class="text-sm font-semibold text-sky-300">En pausa: pedalea para seguir</p>
      <p v-else-if="hint" class="text-sm font-semibold text-amber-200">{{ hint }}</p>
      <div class="ml-auto flex gap-2 text-xs">
        <button class="rounded-lg border border-zinc-700 px-2.5 py-1 hover:bg-zinc-800" @click="skipBlock">Saltar bloque</button>
        <button class="rounded-lg border border-zinc-700 px-2.5 py-1 hover:bg-zinc-800" @click="confirmStop">Detener</button>
      </div>
    </div>
  </div>

  <div v-else-if="result" class="border-t border-zinc-800 bg-zinc-900 text-zinc-100" data-workout-result>
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm sm:px-6">
      <strong :class="result.estado === 'completado' ? 'text-emerald-300' : 'text-amber-300'">
        {{ RESULT_TITLE[result.estado] }}
      </strong>
      <span class="tabular-nums text-zinc-300">
        {{ formatClock(result.segundos) }} · {{ result.potencia }} W · {{ result.cadencia }} rpm
        <template v-if="result.pulso !== null"> · {{ result.pulso }} lpm</template>
        <template v-if="result.enPotencia !== null"> · {{ result.enPotencia }} % en potencia</template>
        <template v-if="result.enCadencia !== null"> · {{ result.enCadencia }} % en cadencia</template>
      </span>
      <span v-if="result.testWatts !== null" class="font-semibold text-orange-300">
        Test: {{ result.testWatts }} W. Revisa las intensidades en Plan.
      </span>
      <span v-if="result.estado === 'completado'" class="font-semibold text-zinc-100">{{ thisWeekStatus.title }}</span>
      <button class="ml-auto text-zinc-400 hover:text-white" aria-label="Cerrar resumen" @click="dismissResult">✕</button>
    </div>
  </div>
</template>
