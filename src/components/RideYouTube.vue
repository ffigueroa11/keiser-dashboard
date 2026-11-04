<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { updateWebVideo } from '../routes/webVideos'

/**
 * Video de YouTube sincronizado con la simulación de RideScene. Usa el reproductor oficial: nada se
 * dibuja encima de él (lo exigen las políticas de YouTube), así que los datos van en una franja
 * aparte. El video siempre corre a velocidad normal: avanza mientras pedaleas y se pausa si paras.
 */
const props = defineProps({
  video: { type: Object, required: true },
  sim: { type: Object, required: true },
  watts: { type: Number, default: 0 },
  rpm: { type: Number, default: 0 },
  gear: { type: Number, default: null },
  grade: { type: Number, default: 0 },
  effort: { type: String, default: '' },
})
const emit = defineEmits(['meta', 'unavailable'])

const TICK_MS = 250
const STOP_AFTER_MS = 3000 // sin pedalear este tiempo, el video se pausa
const ENDED = 0
const PLAYING = 1
const BUFFERING = 3

const wrapper = ref(null)
const host = ref(null)
const ready = ref(false)
const error = ref('')
const duration = ref(0)
const muted = ref(true)
const ended = ref(false)
const waiting = ref(false) // sin pedaleo: el video espera en pausa
const cfg = reactive({ inicioSeg: props.video.inicioSeg })

const watchUrl = computed(() => `https://www.youtube.com/watch?v=${props.video.videoId}`)
const startSec = computed(() => Math.max(0, Number(cfg.inicioSeg) || 0))

watch(startSec, (s) => {
  updateWebVideo(props.video.id, { inicioSeg: s })
  if (ready.value) player.seekTo(s, true)
})

// La API de YouTube se carga una sola vez, aunque se abran varios videos.
let apiPromise = null
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  apiPromise ||= new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT)
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.onerror = () => {
      apiPromise = null
      reject(new Error('sin conexión'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

const ERRORS = {
  2: 'El enlace no es válido.',
  5: 'Este navegador no puede reproducir el video.',
  100: 'El video ya no existe o es privado.',
  // YouTube usa estos códigos también para videos que no existen.
  101: 'Este video no existe o su autor no permite reproducirlo fuera de YouTube. Prueba con otro.',
  150: 'Este video no existe o su autor no permite reproducirlo fuera de YouTube. Prueba con otro.',
  153: 'YouTube rechazó la reproducción porque no recibió el origen de la página. Abre la app desde su dirección http://localhost o https://.',
}

let player = null
let timer = 0
let lastPedalAt = -Infinity
let lastDist = props.sim.distM
let disposed = false
let previewing = false
let loadTimeout = 0

const isPedaling = () => performance.now() - lastPedalAt < STOP_AFTER_MS

function tick() {
  if (!player || !ready.value) return
  if (props.rpm > 0) lastPedalAt = performance.now()
  const pedaling = isPedaling()
  waiting.value = !pedaling
  if (previewing) return
  if (props.sim.distM < lastDist) player.seekTo(startSec.value, true) // "Reiniciar distancia"
  lastDist = props.sim.distM
  const state = player.getPlayerState()
  ended.value = state === ENDED
  if (ended.value) return
  // Fuera de la pestaña no se reproduce (lo exige YouTube): al volver, sigue donde quedó.
  const visible = document.fullscreenElement || wrapper.value?.getClientRects().length
  if (!pedaling || !visible) {
    if (state === PLAYING) player.pauseVideo()
    return
  }
  if (state !== PLAYING && state !== BUFFERING) player.playVideo()
}

function onPlayerReady() {
  if (disposed) return
  clearTimeout(loadTimeout)
  player.mute()
  player.setPlaybackRate(1)
  duration.value = player.getDuration()
  ready.value = true
  emit('meta', { title: player.getVideoData?.().title, duration: Math.round(duration.value) })
  player.seekTo(startSec.value, true)
  // Pausar antes de que empiece deja la pantalla en negro: se reproduce (en silencio) hasta que
  // YouTube muestra la primera imagen, y ahí se pausa a la espera del pedaleo.
  previewing = true
  player.playVideo()
  timer = setInterval(tick, TICK_MS)
}

function onStateChange(e) {
  if (!previewing || e.data !== PLAYING) return
  previewing = false
  if (!isPedaling()) player.pauseVideo()
}

function toggleSound() {
  if (!player) return
  if (muted.value) player.unMute()
  else player.mute()
  muted.value = !muted.value
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen()
  else wrapper.value.requestFullscreen?.()
}

onMounted(async () => {
  // Un bloqueador de anuncios o una extensión puede frenar a YouTube sin dar ningún error.
  loadTimeout = setTimeout(() => {
    if (!ready.value && !error.value) {
      error.value =
        'YouTube no respondió. Revisa tu conexión y desactiva en esta página los bloqueadores de anuncios o extensiones de privacidad.'
    }
  }, 15000)
  try {
    const YT = await loadYouTubeApi()
    if (disposed) return
    player = new YT.Player(host.value, {
      videoId: props.video.videoId,
      width: '100%',
      height: '100%',
      playerVars: { controls: 0, disablekb: 1, playsinline: 1, rel: 0, origin: location.origin },
      events: {
        onReady: onPlayerReady,
        onStateChange,
        onError: (e) => {
          clearTimeout(loadTimeout)
          ready.value = false
          error.value = ERRORS[e.data] ?? `YouTube no pudo reproducir el video (código ${e.data}).`
          if ([100, 101, 150].includes(e.data)) emit('unavailable')
        },
      },
    })
  } catch {
    error.value = 'No se pudo cargar YouTube. Revisa tu conexión a internet.'
  }
})

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(loadTimeout)
  clearInterval(timer)
  player?.destroy?.()
})
</script>

<template>
  <div class="space-y-3">
    <div ref="wrapper" class="yt-stage flex flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-black">
      <div class="yt-screen relative aspect-video w-full">
        <div ref="host" class="absolute inset-0"></div>
        <p v-if="error" role="alert" class="absolute inset-0 flex items-center justify-center bg-zinc-950 px-6 text-center text-sm text-amber-200">
          {{ error }}
        </p>
      </div>
      <!-- Datos: en una franja aparte, nunca sobre el reproductor -->
      <div class="flex flex-wrap items-center gap-2 bg-zinc-950 px-3 py-2 text-zinc-100">
        <div class="chip"><strong>{{ (sim.v * 3.6).toFixed(1) }}</strong> km/h</div>
        <div class="chip"><strong>{{ watts }}</strong> W</div>
        <div class="chip"><strong>{{ rpm }}</strong> rpm</div>
        <div v-if="gear !== null" class="chip">marcha <strong>{{ gear }}</strong></div>
        <div class="chip"><strong>{{ grade.toFixed(1) }}</strong> % virtual</div>
        <div v-if="effort" class="chip">{{ effort }}</div>
        <div class="chip"><strong>{{ (sim.distM / 1000).toFixed(2) }}</strong> km</div>
        <div class="ml-auto flex gap-2">
          <button class="chip hover:bg-zinc-700" @click="toggleSound">{{ muted ? 'Activar sonido' : 'Silenciar' }}</button>
          <button class="chip hover:bg-zinc-700" @click="toggleFullscreen">Pantalla completa</button>
        </div>
      </div>
    </div>

    <p
      v-if="ready && waiting && !ended"
      class="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-2 text-sm text-sky-200"
    >
      El video espera en pausa: conecta la bicicleta (o activa el Simulador) y pedalea para avanzar.
    </p>
    <p v-if="ended" class="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
      Llegaste al final del video: {{ (sim.distM / 1000).toFixed(2) }} km.
    </p>

    <details class="text-xs text-zinc-400">
      <summary class="cursor-pointer">Ajustes del video</summary>
      <div class="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
      <label class="flex items-center gap-2">
        Empezar en el segundo
        <input
          v-model.number="cfg.inicioSeg"
          type="number"
          min="0"
          class="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
        />
      </label>
      <a :href="watchUrl" target="_blank" rel="noopener" class="text-sky-300 hover:text-sky-200">Ver en YouTube</a>
      </div>
      <p class="mt-2 text-zinc-500">
        El video corre siempre a velocidad normal mientras pedaleas. Tu velocidad y tu distancia se calculan aparte, y la
        pendiente la pone tu marcha.
      </p>
    </details>
  </div>
</template>

<style scoped>
@reference "../style.css";

.yt-stage:fullscreen {
  @apply rounded-none border-0;
}
.yt-stage:fullscreen .yt-screen {
  @apply aspect-auto min-h-0 flex-1;
}
.chip {
  @apply rounded-lg bg-zinc-800/80 px-2.5 py-1 text-xs tabular-nums;
}
</style>
