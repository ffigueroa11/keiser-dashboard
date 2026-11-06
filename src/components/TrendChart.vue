<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

/**
 * Gráfico de una sola medida en el tiempo: barras (cantidades, parten de 0) o línea. Con cursor y
 * tooltip, el último valor rotulado y una tabla con los mismos datos.
 */
const props = defineProps({
  title: { type: String, required: true },
  // [{ label, value }], de más antiguo a más nuevo; value null deja un hueco.
  points: { type: Array, required: true },
  unit: { type: String, default: '' },
  kind: { type: String, default: 'line' },
  markClass: { type: String, default: 'fill-orange-400' },
  lineClass: { type: String, default: 'stroke-orange-400' },
  decimals: { type: Number, default: 0 },
})

const HEIGHT = 160
const M = { top: 14, right: 44, bottom: 22, left: 36 }
const root = ref(null)
const width = ref(600)
const hover = ref(null)
let observer = null

onMounted(() => {
  observer = new ResizeObserver(([entry]) => (width.value = entry.contentRect.width || 600))
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

const values = computed(() => props.points.map((p) => p.value).filter((v) => v !== null))
const plotW = computed(() => Math.max(1, width.value - M.left - M.right))
const plotH = HEIGHT - M.top - M.bottom
const fmt = (v) => v.toFixed(props.decimals)

const scale = computed(() => {
  const max = Math.max(...values.value, 0)
  if (props.kind === 'bar') return { lo: 0, hi: max || 1 }
  const lo = Math.min(...values.value)
  const pad = Math.max((max - lo) * 0.2, Math.abs(max) * 0.02, 0.5)
  return { lo: lo - pad, hi: max + pad }
})
const yOf = (v) => M.top + plotH - ((v - scale.value.lo) / (scale.value.hi - scale.value.lo)) * plotH
const xOf = (i) => {
  const n = props.points.length
  if (props.kind === 'bar') return M.left + ((i + 0.5) / n) * plotW.value
  return M.left + (n <= 1 ? plotW.value / 2 : (i / (n - 1)) * plotW.value)
}
const ticks = computed(() => {
  const { lo, hi } = scale.value
  return [lo, (lo + hi) / 2, hi]
})

const barWidth = computed(() => Math.min(28, Math.max(4, (plotW.value / props.points.length) * 0.6)))
function barPath(i, v) {
  const x = xOf(i) - barWidth.value / 2
  const y = yOf(v)
  const base = yOf(0)
  const r = Math.min(4, barWidth.value / 2, base - y)
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + barWidth.value - r}Q${x + barWidth.value},${y} ${x + barWidth.value},${y + r}V${base}Z`
}

const linePath = computed(() => {
  let d = ''
  let open = false
  props.points.forEach((p, i) => {
    if (p.value === null) {
      open = false
      return
    }
    d += `${open ? 'L' : 'M'}${xOf(i)},${yOf(p.value)}`
    open = true
  })
  return d
})

const lastIndex = computed(() => props.points.findLastIndex((p) => p.value !== null))
// Etiquetas del eje: pocas, para que no choquen.
const labelEvery = computed(() => Math.max(1, Math.ceil(props.points.length / Math.max(2, Math.floor(plotW.value / 70)))))

function onMove(e) {
  const rect = e.currentTarget.getBoundingClientRect()
  const x = e.clientX - rect.left
  let best = null
  props.points.forEach((p, i) => {
    if (p.value === null) return
    if (best === null || Math.abs(xOf(i) - x) < Math.abs(xOf(best) - x)) best = i
  })
  hover.value = best
}
const tip = computed(() => {
  if (hover.value === null) return null
  const p = props.points[hover.value]
  const x = xOf(hover.value)
  return { x, y: yOf(p.value), left: x > width.value - 140 ? x - 132 : x + 12, label: p.label, value: fmt(p.value) }
})
</script>

<template>
  <figure class="min-w-0">
    <figcaption class="mb-2 text-sm font-semibold text-zinc-200">{{ title }}</figcaption>
    <div ref="root" class="relative">
      <p v-if="!values.length" class="py-10 text-center text-sm text-zinc-400">Aún no hay datos.</p>
      <template v-else>
        <svg
          :viewBox="`0 0 ${width} ${HEIGHT}`"
          :width="width"
          :height="HEIGHT"
          class="block touch-none"
          role="img"
          :aria-label="`${title}. Último valor: ${fmt(points[lastIndex].value)} ${unit}`"
          @pointermove="onMove"
          @pointerleave="hover = null"
        >
          <g v-for="t in ticks" :key="t">
            <line :x1="M.left" :x2="width - M.right" :y1="yOf(t)" :y2="yOf(t)" class="stroke-zinc-800" />
            <text :x="M.left - 6" :y="yOf(t) + 3" text-anchor="end" class="fill-zinc-400 text-[10px] tabular-nums">{{ fmt(t) }}</text>
          </g>
          <template v-for="(p, i) in points" :key="i">
            <text
              v-if="i % labelEvery === 0"
              :x="xOf(i)"
              :y="HEIGHT - 6"
              text-anchor="middle"
              class="fill-zinc-400 text-[10px] tabular-nums"
            >
              {{ p.label }}
            </text>
          </template>

          <template v-if="kind === 'bar'">
            <template v-for="(p, i) in points" :key="i">
              <path v-if="p.value" :d="barPath(i, p.value)" :class="markClass" />
            </template>
          </template>
          <template v-else>
            <path :d="linePath" fill="none" :class="lineClass" stroke-width="2" stroke-linejoin="round" />
            <template v-for="(p, i) in points" :key="i">
              <circle v-if="p.value !== null" :cx="xOf(i)" :cy="yOf(p.value)" r="4" :class="markClass" class="stroke-zinc-900" stroke-width="2" />
            </template>
          </template>

          <text
            v-if="lastIndex >= 0"
            :x="kind === 'bar' ? xOf(lastIndex) : Math.min(xOf(lastIndex) + 8, width - M.right + 4)"
            :y="kind === 'bar' ? Math.max(M.top - 3, yOf(points[lastIndex].value) - 5) : yOf(points[lastIndex].value) + 4"
            :text-anchor="kind === 'bar' ? 'middle' : 'start'"
            class="fill-zinc-100 text-[11px] font-semibold tabular-nums"
          >
            {{ fmt(points[lastIndex].value) }}
          </text>

          <g v-if="tip" class="pointer-events-none">
            <line :x1="tip.x" :x2="tip.x" :y1="M.top" :y2="M.top + plotH" class="stroke-zinc-500" stroke-dasharray="3 3" />
          </g>
        </svg>
        <div
          v-if="tip"
          class="pointer-events-none absolute top-1 z-10 w-28 rounded-lg border border-zinc-700 bg-zinc-950/95 px-2.5 py-1.5 text-xs shadow-lg"
          :style="{ left: `${tip.left}px` }"
        >
          <p class="text-zinc-400">{{ tip.label }}</p>
          <p class="font-semibold tabular-nums text-zinc-100">{{ tip.value }} {{ unit }}</p>
        </div>
      </template>
    </div>
    <details v-if="values.length" class="mt-1 text-xs text-zinc-400">
      <summary class="cursor-pointer">Ver tabla</summary>
      <table class="mt-1 tabular-nums">
        <tbody>
          <tr v-for="(p, i) in points" :key="i">
            <td class="py-0.5 pr-4">{{ p.label }}</td>
            <td class="py-0.5 text-right text-zinc-200">{{ p.value === null ? '—' : `${fmt(p.value)} ${unit}` }}</td>
          </tr>
        </tbody>
      </table>
    </details>
  </figure>
</template>
