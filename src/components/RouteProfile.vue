<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { elevationAt, gradeAt, routeLength } from '../routes/routes'

/** Perfil de elevación de la ruta completa con la posición actual del ciclista. */
const props = defineProps({
  route: { type: Object, required: true },
  distM: { type: Number, default: 0 },
})

const M = { left: 44, right: 12, top: 10, bottom: 22 }
const H = 130

const root = ref(null)
const width = ref(600)
const hoverD = ref(null)
let observer

onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = Math.max(200, entry.contentRect.width)))
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const len = computed(() => routeLength(props.route))
const minEle = computed(() => Math.min(...props.route.ele))
const maxEle = computed(() => Math.max(...props.route.ele))
// Al menos 50 m de rango vertical para que una ruta llana no parezca montañosa.
const eleSpan = computed(() => Math.max(50, maxEle.value - minEle.value))
const plotW = computed(() => width.value - M.left - M.right)
const plotH = H - M.top - M.bottom

const xOf = (d) => M.left + (d / len.value) * plotW.value
const yOf = (e) => M.top + plotH - ((e - minEle.value) / eleSpan.value) * plotH

// Un punto cada ~3 px basta para el trazo.
const samples = computed(() => {
  const n = Math.max(2, Math.floor(plotW.value / 3))
  return Array.from({ length: n + 1 }, (_, i) => (i / n) * len.value)
})
const linePath = (ds) => ds.map((d, i) => `${i ? 'L' : 'M'}${xOf(d)},${yOf(elevationAt(props.route, d))}`).join('')
const areaPath = (ds) => `${linePath(ds)}L${xOf(ds[ds.length - 1])},${M.top + plotH}L${xOf(ds[0])},${M.top + plotH}Z`

const full = computed(() => samples.value)
const done = computed(() => {
  const ds = samples.value.filter((d) => d < props.distM)
  return ds.length ? [...ds, Math.min(props.distM, len.value)] : []
})

const pos = computed(() => {
  const d = Math.min(props.distM, len.value)
  return { x: xOf(d), y: yOf(elevationAt(props.route, d)) }
})

const xTicks = computed(() =>
  [0, 0.5, 1].map((t) => ({ x: xOf(t * len.value), label: `${((t * len.value) / 1000).toFixed(1)} km`, anchor: t === 0 ? 'start' : t === 1 ? 'end' : 'middle' })),
)

function onMove(e) {
  const rect = root.value.getBoundingClientRect()
  const t = (e.clientX - rect.left - M.left) / plotW.value
  hoverD.value = t < 0 || t > 1 ? null : t * len.value
}
const tip = computed(() => {
  if (hoverD.value === null) return null
  const d = hoverD.value
  const x = xOf(d)
  return {
    x,
    y: yOf(elevationAt(props.route, d)),
    left: x > width.value - 150 ? x - 140 : x + 10,
    km: (d / 1000).toFixed(2),
    ele: Math.round(elevationAt(props.route, d)),
    grade: gradeAt(props.route, d).toFixed(1),
  }
})
</script>

<template>
  <div ref="root" class="relative select-none">
    <svg
      :width="width"
      :height="H"
      class="block touch-none"
      role="img"
      :aria-label="`Perfil de ${route.nombre}: ${(len / 1000).toFixed(1)} km`"
      @pointermove="onMove"
      @pointerleave="hoverD = null"
    >
      <g v-for="e in [minEle, minEle + eleSpan]" :key="e">
        <line :x1="M.left" :x2="width - M.right" :y1="yOf(e)" :y2="yOf(e)" class="stroke-zinc-800" />
        <text :x="M.left - 6" :y="yOf(e) + 4" text-anchor="end" class="fill-zinc-500 text-[10px] tabular-nums">
          {{ Math.round(e) }} m
        </text>
      </g>
      <path :d="areaPath(full)" class="fill-zinc-700/50" />
      <path :d="linePath(full)" fill="none" class="stroke-zinc-500" stroke-width="2" stroke-linejoin="round" />
      <template v-if="done.length > 1">
        <path :d="areaPath(done)" class="fill-orange-400/25" />
        <path :d="linePath(done)" fill="none" class="stroke-orange-400" stroke-width="2" stroke-linejoin="round" />
      </template>
      <circle :cx="pos.x" :cy="pos.y" r="6" class="fill-orange-400 stroke-zinc-900" stroke-width="2" />

      <text
        v-for="t in xTicks"
        :key="t.label"
        :x="t.x"
        :y="H - 6"
        :text-anchor="t.anchor"
        class="fill-zinc-500 text-[10px] tabular-nums"
      >
        {{ t.label }}
      </text>

      <g v-if="tip" class="pointer-events-none">
        <line :x1="tip.x" :x2="tip.x" :y1="M.top" :y2="M.top + plotH" class="stroke-zinc-500" stroke-dasharray="3 3" />
        <circle :cx="tip.x" :cy="tip.y" r="4" class="fill-zinc-100 stroke-zinc-900" stroke-width="2" />
      </g>
    </svg>
    <div
      v-if="tip"
      class="pointer-events-none absolute top-1 rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-1.5 text-xs text-zinc-300 shadow-lg tabular-nums"
      :style="{ left: tip.left + 'px' }"
    >
      <span class="font-semibold text-zinc-100">km {{ tip.km }}</span> · {{ tip.ele }} m · {{ tip.grade }} %
    </div>
  </div>
</template>
