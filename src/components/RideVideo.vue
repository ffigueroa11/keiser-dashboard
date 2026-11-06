<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { routeLength, videoSecondsPerMeter, videoTimeAt } from '../routes/routes'
import {
  loadHandle,
  loadVideoSync,
  rememberSessionVideo,
  saveHandle,
  saveVideoSync,
  sessionVideo,
} from '../routes/videoStore'
import { zoneFor } from '../heartZones'
import { useIsFullscreen } from '../composables/useIsFullscreen'
import WorkoutStrip from './WorkoutStrip.vue'

/**
 * Video real de la ruta, sincronizado con la simulación de RideScene: la velocidad de reproducción
 * sale de tu velocidad virtual y de la velocidad a la que se filmó cada tramo. No simula nada: lee
 * `sim` (distM, v, finished) en cada cuadro.
 */
const props = defineProps({
  route: { type: Object, required: true },
  sim: { type: Object, required: true },
  watts: { type: Number, default: 0 },
  rpm: { type: Number, default: 0 },
  gear: { type: Number, default: null },
  grade: { type: Number, default: 0 },
  heartRate: { type: Number, default: null },
})

const MIN_RATE = 0.0625 // límite inferior de Chrome
const MAX_RATE = 8
const SEEK_AFTER_S = 2 // desfase que ya no se corrige acelerando, sino saltando
const SEEK_COOLDOWN_MS = 1500

const wrapper = ref(null)
const isFullscreen = useIsFullscreen(wrapper)
const videoEl = ref(null)
const fileInput = ref(null)
const src = ref('')
const fileName = ref('')
const pendingHandle = ref(null) // archivo recordado que necesita permiso (un clic) para reabrirse
const ready = ref(false)
const error = ref('')
const shownRate = ref(0)
const duration = ref(0)
const hrZone = computed(() => zoneFor(props.heartRate))
const sync = reactive(loadVideoSync(props.route.id))
watch(sync, () => saveVideoSync(props.route.id, sync))

const fmt = (sec) => {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

const gpxSeconds = computed(() => props.route.tiempos?.[props.route.tiempos.length - 1] ?? 0)
// El video y el GPX deberían durar parecido; si no, probablemente no corresponden o están cortados.
const durationMismatch = computed(
  () =>
    ready.value &&
    sync.useTimes &&
    gpxSeconds.value > 0 &&
    Math.abs(gpxSeconds.value - duration.value) / duration.value > 0.1,
)

function setFile(file) {
  if (src.value) URL.revokeObjectURL(src.value)
  ready.value = false
  error.value = ''
  fileName.value = file.name
  rememberSessionVideo(props.route.id, file)
  src.value = URL.createObjectURL(file)
}

async function pick() {
  if (!window.showOpenFilePicker) {
    fileInput.value.click()
    return
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.m4v', '.webm', '.mkv'] } }],
    })
    await saveHandle(props.route.id, handle)
    pendingHandle.value = null
    setFile(await handle.getFile())
  } catch (err) {
    if (err?.name !== 'AbortError') error.value = `No se pudo abrir el video: ${err?.message || err}`
  }
}

function onInput(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (file) setFile(file)
}

async function reopen() {
  try {
    if ((await pendingHandle.value.requestPermission({ mode: 'read' })) !== 'granted') return
    const handle = pendingHandle.value
    pendingHandle.value = null
    setFile(await handle.getFile())
  } catch {
    pendingHandle.value = null
    error.value = 'No se encontró el archivo: quizás se movió o se renombró. Vuelve a elegirlo.'
  }
}

function onMetadata() {
  duration.value = videoEl.value.duration
  videoEl.value.currentTime = targetTime()
  ready.value = true
}

function onVideoError() {
  ready.value = false
  error.value =
    'Chrome no puede reproducir este video. Suele pasar con H.265/HEVC (GoPro, iPhone): conviértelo a MP4 H.264.'
}

function targetTime() {
  const t = videoTimeAt(props.route, props.sim.distM, duration.value, sync.useTimes) + (sync.useTimes ? sync.offset : 0)
  return Math.min(duration.value, Math.max(0, t))
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

let raf = 0
let lastSeek = -Infinity
let lastShown = 0

function frame(now) {
  raf = requestAnimationFrame(frame)
  const v = videoEl.value
  if (!v || !ready.value) return

  const target = targetTime()
  const err = target - v.currentTime
  if (Math.abs(err) > SEEK_AFTER_S && !v.seeking && now - lastSeek > SEEK_COOLDOWN_MS) {
    v.currentTime = target
    lastSeek = now
  }

  const speed = props.sim.finished ? 0 : props.sim.v
  let rate = 0
  if (speed < 0.2 || target >= duration.value) {
    if (!v.paused) v.pause()
  } else {
    // Velocidad exacta para este tramo, más una corrección suave del desfase acumulado.
    const base = videoSecondsPerMeter(props.route, props.sim.distM, duration.value, sync.useTimes) * speed
    rate = clamp(base * (1 + clamp(err * 0.4, -0.3, 0.3)), MIN_RATE, MAX_RATE)
    if (Math.abs(rate - v.playbackRate) > 0.02) v.playbackRate = rate
    if (v.paused) v.play().catch(() => {})
  }
  if (now - lastShown > 500) {
    lastShown = now
    shownRate.value = rate
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else wrapper.value.requestFullscreen?.()
}

onMounted(async () => {
  raf = requestAnimationFrame(frame)
  const cached = sessionVideo(props.route.id)
  if (cached) {
    setFile(cached)
    return
  }
  const handle = await loadHandle(props.route.id)
  if (!handle) return
  try {
    if ((await handle.queryPermission({ mode: 'read' })) === 'granted') setFile(await handle.getFile())
    else {
      pendingHandle.value = handle
      fileName.value = handle.name
    }
  } catch {
    /* archivo movido: se vuelve a elegir */
  }
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  if (src.value) URL.revokeObjectURL(src.value)
})
</script>

<template>
  <div class="space-y-3">
    <div ref="wrapper" class="video-stage relative aspect-video w-full overflow-hidden rounded-2xl border border-zinc-800 bg-black">
      <video
        v-if="src"
        ref="videoEl"
        :src="src"
        muted
        playsinline
        preload="auto"
        class="h-full w-full object-contain"
        @loadedmetadata="onMetadata"
        @error="onVideoError"
      ></video>

      <!-- Sin video -->
      <div v-if="!ready" class="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <template v-if="pendingHandle">
          <p class="text-sm text-zinc-300">Video de esta ruta: <strong>{{ fileName }}</strong></p>
          <button class="video-btn" @click="reopen">Abrir video</button>
          <button class="text-xs text-zinc-500 hover:text-zinc-300" @click="pick">Elegir otro</button>
        </template>
        <template v-else-if="src && !error">
          <p class="text-sm text-zinc-400">Cargando {{ fileName }}…</p>
        </template>
        <template v-else>
          <p class="text-sm font-semibold text-zinc-100">Elige el video de esta ruta</p>
          <p class="max-w-md text-xs text-zinc-400">
            El mismo recorrido del GPX, filmado desde la bici o el auto. El archivo se queda en tu equipo: no se sube a
            ningún lado.
          </p>
          <button class="video-btn" @click="pick">Elegir video</button>
        </template>
        <p v-if="error" role="alert" class="max-w-md text-xs text-amber-200">{{ error }}</p>
      </div>

      <!-- Datos sobre el video -->
      <template v-if="ready">
        <div class="absolute left-3 top-3 flex flex-wrap gap-2 text-zinc-100">
          <div class="chip"><strong>{{ (sim.v * 3.6).toFixed(1) }}</strong> km/h</div>
          <div class="chip"><strong>{{ watts }}</strong> W</div>
          <div class="chip"><strong>{{ rpm }}</strong> rpm</div>
          <div v-if="gear !== null" class="chip">marcha <strong>{{ gear }}</strong></div>
          <div v-if="hrZone" class="chip">
            <span class="text-rose-400">♥</span> <strong>{{ heartRate }}</strong> lpm
            <strong :class="hrZone.text">Z{{ hrZone.n }}</strong>
          </div>
          <div class="chip">
            <strong>{{ grade > 0 ? '▲' : grade < 0 ? '▼' : '' }} {{ Math.abs(grade).toFixed(1) }}</strong> %
          </div>
          <div class="chip">
            <strong>{{ (sim.distM / 1000).toFixed(2) }}</strong> / {{ (routeLength(route) / 1000).toFixed(1) }} km
          </div>
        </div>
        <button class="chip absolute bottom-3 right-3 text-zinc-100 hover:bg-zinc-800" @click="toggleFullscreen">
          Pantalla completa
        </button>
        <div class="chip absolute bottom-3 left-3" :class="shownRate > 0 && shownRate < 0.3 ? 'text-amber-300' : 'text-zinc-300'">
          video ×{{ shownRate.toFixed(2) }}
        </div>
        <!-- En pantalla completa no se ve la barra superior -->
        <div v-if="isFullscreen" class="absolute inset-x-0 top-12 opacity-90">
          <WorkoutStrip />
        </div>
      </template>
    </div>

    <input ref="fileInput" type="file" accept="video/*" class="hidden" @change="onInput" />

    <!-- Ajustes de sincronización -->
    <div v-if="ready" class="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-400">
      <span class="truncate">{{ fileName }} · {{ fmt(duration) }}</span>
      <button class="text-sky-300 hover:text-sky-200" @click="pick">Cambiar video</button>
      <label v-if="route.tiempos" class="flex items-center gap-2">
        Sincronizar
        <select v-model="sync.useTimes" class="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100">
          <option :value="true">Con los tiempos del GPX</option>
          <option :value="false">Repartido parejo</option>
        </select>
      </label>
      <label v-if="route.tiempos && sync.useTimes" class="flex items-center gap-2">
        Desfase del video
        <input
          v-model.number="sync.offset"
          type="number"
          step="0.5"
          class="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
        />
        s
      </label>
    </div>
    <p v-if="ready && !route.tiempos" class="text-xs text-zinc-500">
      Este GPX no trae horas: el video se reparte parejo y puede no calzar en subidas o paradas. Un GPX grabado durante
      la filmación calza mucho mejor.
    </p>
    <p v-if="durationMismatch" class="text-xs text-amber-200">
      El GPX dura {{ fmt(gpxSeconds) }} y el video {{ fmt(duration) }}. Si no empiezan juntos, ajusta el desfase; si no
      corresponden al mismo recorrido, prueba "Repartido parejo".
    </p>
  </div>
</template>

<style scoped>
@reference "../style.css";

.video-stage:fullscreen {
  @apply rounded-none border-0;
}
.chip {
  @apply rounded-lg bg-zinc-950/70 px-2.5 py-1 text-xs tabular-nums;
}
.video-btn {
  @apply rounded-xl bg-orange-500 px-5 py-2 text-sm font-semibold text-zinc-950 transition hover:bg-orange-400;
}
</style>
