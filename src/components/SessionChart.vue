<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Gráfico de una sesión: potencia (línea) y resistencia/marcha (escalones) en dos paneles
 * apilados que comparten el eje de tiempo, con cursor y tooltip comunes.
 */
const props = defineProps({
  // { paso, watts: [], rpm: [], marcha: [] } — ver buildSeries() en useSession.js
  series: { type: Object, required: true },
  // Muestra debajo el tiempo pasado en cada marcha.
  breakdown: { type: Boolean, default: false },
})

const MAX_GEAR = 24
const M = { left: 40, right: 12 }
const P = { top: 22, h: 120 } // panel potencia
const G = { top: P.top + P.h + 34, h: 80 } // panel marcha

const root = ref(null)
const width = ref(600)
const hover = ref(null)
let observer

onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = Math.max(200, entry.contentRect.width)))
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const n = computed(() => props.series.watts.length)
const hasGear = computed(() => props.series.marcha?.length > 0)
const plotW = computed(() => width.value - M.left - M.right)
const height = computed(() => (hasGear.value ? G.top + G.h + 24 : P.top + P.h + 24))
const axisY = computed(() => (hasGear.value ? G.top + G.h : P.top + P.h))

const xOf = (i) => M.left + (n.value <= 1 ? 0 : (i / (n.value - 1)) * plotW.value)
const maxWatts = computed(() => Math.max(50, Math.ceil(Math.max(...props.series.watts) / 50) * 50))
const yW = (v) => P.top + P.h - (v / maxWatts.value) * P.h
const yG = (g) => G.top + G.h - (g / MAX_GEAR) * G.h

const powerLine = computed(() => props.series.watts.map((v, i) => `${i ? 'L' : 'M'}${xOf(i)},${yW(v)}`).join(''))
const powerArea = computed(
  () => `${powerLine.value}L${xOf(n.value - 1)},${P.top + P.h}L${xOf(0)},${P.top + P.h}Z`,
)

// Escalones: la marcha se mantiene hasta el siguiente cambio; los huecos (null) cortan el trazo.
const gearPath = computed(() => {
  let d = ''
  let prev = null
  props.series.marcha.forEach((g, i) => {
    if (g === null) {
      prev = null
      return
    }
    d += prev === null ? `M${xOf(i)},${yG(g)}` : `H${xOf(i)}V${yG(g)}`
    prev = g
  })
  return d
})

const fmt = (sec) => {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

const xTicks = computed(() => {
  if (n.value < 2) return []
  return [0, 1, 2, 3, 4].map((k) => {
    const i = Math.round((k / 4) * (n.value - 1))
    return { x: xOf(i), label: fmt(i * props.series.paso), anchor: k === 0 ? 'start' : k === 4 ? 'end' : 'middle' }
  })
})

function onMove(e) {
  const rect = root.value.getBoundingClientRect()
  const x = e.clientX - rect.left
  const i = Math.round(((x - M.left) / plotW.value) * (n.value - 1))
  hover.value = Math.min(n.value - 1, Math.max(0, i))
}

const tip = computed(() => {
  const i = hover.value
  if (i === null) return null
  const x = xOf(i)
  return {
    x,
    left: x > width.value - 170 ? x - 162 : x + 12,
    time: fmt(i * props.series.paso),
    watts: props.series.watts[i],
    rpm: props.series.rpm?.[i],
    gear: props.series.marcha?.[i],
  }
})

// Tiempo en cada marcha, ordenado por marcha.
const gearTime = computed(() => {
  if (!hasGear.value) return []
  const secs = {}
  for (const g of props.series.marcha) if (g !== null) secs[g] = (secs[g] || 0) + props.series.paso
  const total = Object.values(secs).reduce((a, b) => a + b, 0)
  const max = Math.max(...Object.values(secs))
  return Object.entries(secs)
    .map(([g, s]) => ({ gear: Number(g), secs: s, pct: Math.round((s / total) * 100), w: (s / max) * 100 }))
    .sort((a, b) => a.gear - b.gear)
})
</script>

<template>
  <div ref="root" class="relative select-none">
    <p v-if="n < 2" class="py-10 text-center text-sm text-zinc-500">Aún no hay datos suficientes para graficar.</p>
    <template v-else>
      <svg
        :width="width"
        :height="height"
        class="block touch-none"
        role="img"
        :aria-label="`Potencia${hasGear ? ' y marcha' : ''} durante la sesión`"
        @pointermove="onMove"
        @pointerleave="hover = null"
      >
        <!-- Panel potencia -->
        <text :x="M.left" :y="P.top - 8" class="fill-zinc-400 text-[11px] font-semibold uppercase tracking-wider">
          Potencia (W)
        </text>
        <g v-for="t in [0, maxWatts / 2, maxWatts]" :key="'w' + t">
          <line :x1="M.left" :x2="width - M.right" :y1="yW(t)" :y2="yW(t)" class="stroke-zinc-800" />
          <text :x="M.left - 6" :y="yW(t) + 4" text-anchor="end" class="fill-zinc-500 text-[10px] tabular-nums">
            {{ t }}
          </text>
        </g>
        <path :d="powerArea" class="fill-orange-400/10" />
        <path :d="powerLine" fill="none" class="stroke-orange-400" stroke-width="2" stroke-linejoin="round" />

        <!-- Panel marcha (resistencia) -->
        <template v-if="hasGear">
          <text :x="M.left" :y="G.top - 8" class="fill-zinc-400 text-[11px] font-semibold uppercase tracking-wider">
            Resistencia (marcha)
          </text>
          <g v-for="t in [0, 8, 16, 24]" :key="'g' + t">
            <line :x1="M.left" :x2="width - M.right" :y1="yG(t)" :y2="yG(t)" class="stroke-zinc-800" />
            <text :x="M.left - 6" :y="yG(t) + 4" text-anchor="end" class="fill-zinc-500 text-[10px] tabular-nums">
              {{ t }}
            </text>
          </g>
          <path :d="gearPath" fill="none" class="stroke-violet-400" stroke-width="2" stroke-linejoin="round" />
        </template>

        <!-- Eje de tiempo -->
        <text
          v-for="t in xTicks"
          :key="'x' + t.x"
          :x="t.x"
          :y="axisY + 16"
          :text-anchor="t.anchor"
          class="fill-zinc-500 text-[10px] tabular-nums"
        >
          {{ t.label }}
        </text>

        <!-- Cursor -->
        <g v-if="tip" class="pointer-events-none">
          <line :x1="tip.x" :x2="tip.x" :y1="P.top" :y2="axisY" class="stroke-zinc-500" stroke-dasharray="3 3" />
          <circle :cx="tip.x" :cy="yW(tip.watts)" r="4" class="fill-orange-400 stroke-zinc-900" stroke-width="2" />
          <circle
            v-if="hasGear && tip.gear !== null"
            :cx="tip.x"
            :cy="yG(tip.gear)"
            r="4"
            class="fill-violet-400 stroke-zinc-900"
            stroke-width="2"
          />
        </g>
      </svg>

      <div
        v-if="tip"
        class="pointer-events-none absolute top-6 w-[150px] rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs shadow-lg"
        :style="{ left: tip.left + 'px' }"
      >
        <p class="mb-1 font-semibold text-zinc-100 tabular-nums">{{ tip.time }}</p>
        <p class="flex justify-between text-zinc-400">
          <span><span class="mr-1.5 inline-block h-2 w-2 rounded-full bg-orange-400"></span>Potencia</span>
          <span class="text-zinc-100 tabular-nums">{{ tip.watts }} W</span>
        </p>
        <p v-if="tip.rpm !== undefined" class="flex justify-between text-zinc-400">
          <span><span class="mr-1.5 inline-block h-2 w-2 rounded-full bg-sky-400"></span>Cadencia</span>
          <span class="text-zinc-100 tabular-nums">{{ tip.rpm }} rpm</span>
        </p>
        <p v-if="hasGear" class="flex justify-between text-zinc-400">
          <span><span class="mr-1.5 inline-block h-2 w-2 rounded-full bg-violet-400"></span>Marcha</span>
          <span class="text-zinc-100 tabular-nums">{{ tip.gear ?? '—' }}</span>
        </p>
      </div>

      <div v-if="breakdown && gearTime.length" class="mt-5">
        <p class="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Tiempo por marcha</p>
        <div class="space-y-1">
          <div v-for="b in gearTime" :key="b.gear" class="flex items-center gap-3 text-xs">
            <span class="w-6 text-right text-zinc-400 tabular-nums">{{ b.gear }}</span>
            <div class="h-3 flex-1">
              <div class="h-full rounded-r bg-violet-400/80" :style="{ width: Math.max(1, b.w) + '%' }"></div>
            </div>
            <span class="w-24 text-right text-zinc-300 tabular-nums">{{ fmt(b.secs) }} · {{ b.pct }}%</span>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
