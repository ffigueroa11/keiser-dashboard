<script setup>
import { computed, reactive, ref, watch } from 'vue'
import RideScene from './RideScene.vue'
import { forgetVideo } from '../routes/videoStore'
import { pickRandomVideo } from '../routes/videoSearch'
import {
  MIN_DURATIONS,
  MOMENTS,
  REGIONS,
  TERRAINS,
  YOUTUBE_SEARCH_URL,
  addRejected,
  loadFilters,
  loadWebVideos,
  loadYouTubeKey,
  markSeen,
  parseYouTubeId,
  saveFilters,
  saveWebVideos,
  saveYouTubeKey,
  tagsLabel,
} from '../routes/webVideos'
import {
  BUILTIN_ROUTES,
  ascent,
  loadImportedRoutes,
  loadRouteResults,
  parseGpx,
  routeLength,
  saveImportedRoutes,
  saveRouteResults,
} from '../routes/routes'

/**
 * Ciclismo virtual. Antes de rodar: dos grupos, Videos (aleatorio con filtros, mi lista) y Rutas
 * (paseo libre, rutas, GPX). Al rodar: solo la escena y lo necesario.
 */
defineProps({
  watts: { type: Number, default: 0 },
  rpm: { type: Number, default: 0 },
  gear: { type: Number, default: null },
  heartRate: { type: Number, default: null },
})

const MAX_AUTO_SKIPS = 5

const imported = ref(loadImportedRoutes())
const results = ref(loadRouteResults())
const routes = computed(() => [...BUILTIN_ROUTES, ...imported.value])

const pickTab = ref('videos')
const selected = ref(null) // null = paseo libre
const selectedVideo = ref(null) // video de la web elegido
const webVideos = ref(loadWebVideos())
const filters = reactive(loadFilters())
watch(filters, () => saveFilters(filters))
const youtubeKey = ref(loadYouTubeKey())
watch(youtubeKey, saveYouTubeKey)
const videoLink = ref('')
const videoError = ref('')
const searching = ref(false)
const surpriseMode = ref(false)
const skipNotice = ref('')
const showTags = ref(false)
const tagDraft = reactive({ region: 'any', momento: 'any', terreno: 'any' })
let autoSkips = 0

const picking = ref(true)
const finish = ref(null)
const importError = ref('')
const fileInput = ref(null)

const fmtTime = (sec) => {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

const best = (id) => {
  const list = results.value[id] || []
  return list.length ? Math.min(...list.map((r) => r.tiempoSeg)) : null
}

function start(route) {
  selected.value = route
  selectedVideo.value = null
  finish.value = null
  picking.value = false
}

function leave() {
  if (selected.value && !finish.value && !confirm('¿Abandonar la ruta? El recorrido actual no se guardará.')) return
  selected.value = null
  selectedVideo.value = null
  surpriseMode.value = false
  showTags.value = false
  finish.value = null
  skipNotice.value = ''
  webVideos.value = loadWebVideos() // los ajustes del video se guardan mientras se rueda
  picking.value = true
}

// ---------- Videos ----------
const currentIsSaved = computed(() => webVideos.value.some((v) => v.id === selectedVideo.value?.id))

function startVideo(video, surprise = false) {
  selected.value = null
  selectedVideo.value = video
  surpriseMode.value = surprise
  showTags.value = false
  finish.value = null
  picking.value = false
  markSeen(video.videoId)
}

async function surprise() {
  videoError.value = ''
  searching.value = true
  try {
    const video = await pickRandomVideo(filters, youtubeKey.value)
    if (video) {
      startVideo(video, true)
      return
    }
    const message = youtubeKey.value
      ? 'No encontré videos con esos filtros. Prueba con filtros más amplios o una duración menor.'
      : 'Tu lista no tiene videos con esos filtros. Agrega la clave de búsqueda para buscar en todo YouTube, o pega un enlace.'
    if (picking.value) videoError.value = message
    else skipNotice.value = message
  } catch (err) {
    if (picking.value) videoError.value = err.message
    else skipNotice.value = err.message
  } finally {
    searching.value = false
  }
}

function nextVideo() {
  // Lo de la lista propia nunca se descarta; lo encontrado en la búsqueda no vuelve a aparecer.
  if (selectedVideo.value && !currentIsSaved.value) addRejected(selectedVideo.value.videoId)
  skipNotice.value = ''
  autoSkips = 0
  surprise()
}

function onVideoUnavailable() {
  if (!surpriseMode.value || autoSkips >= MAX_AUTO_SKIPS) return
  autoSkips++
  addRejected(selectedVideo.value.videoId)
  skipNotice.value = 'Ese video no se pudo reproducir aquí: busqué otro.'
  surprise()
}

function addVideo() {
  videoError.value = ''
  const videoId = parseYouTubeId(videoLink.value)
  if (!videoId) {
    videoError.value = 'No reconozco ese enlace. Pega la dirección de un video de YouTube.'
    return
  }
  let video = webVideos.value.find((v) => v.videoId === videoId)
  if (!video) {
    video = { id: `yt-${videoId}`, videoId, nombre: 'Video de YouTube', inicioSeg: 0 }
    webVideos.value = [...webVideos.value, video]
    saveWebVideos(webVideos.value)
  }
  videoLink.value = ''
  startVideo(video)
}

function removeVideo(video) {
  webVideos.value = webVideos.value.filter((v) => v.id !== video.id)
  saveWebVideos(webVideos.value)
}

// YouTube entrega título y duración al cargar.
function onVideoMeta({ title, duration }) {
  const id = selectedVideo.value?.id
  if (!id) return
  autoSkips = 0
  selectedVideo.value = { ...selectedVideo.value, nombre: title || selectedVideo.value.nombre, duracionSeg: duration }
  if (currentIsSaved.value) {
    webVideos.value = loadWebVideos().map((v) =>
      v.id === id ? { ...v, nombre: selectedVideo.value.nombre, duracionSeg: duration } : v,
    )
    saveWebVideos(webVideos.value)
  }
}

function openTags() {
  const t = selectedVideo.value?.etiquetas ?? {}
  // Al guardar por primera vez, parte de los filtros con que se encontró.
  tagDraft.region = t.region ?? filters.region
  tagDraft.momento = t.momento ?? filters.momento
  tagDraft.terreno = t.terreno ?? filters.terreno
  showTags.value = true
}

function saveCurrent() {
  const stored = loadWebVideos()
  const velo = stored.find((v) => v.id === selectedVideo.value.id)
  const video = { ...selectedVideo.value, ...velo, nombre: selectedVideo.value.nombre, etiquetas: { ...tagDraft } }
  webVideos.value = velo ? stored.map((v) => (v.id === video.id ? video : v)) : [...stored, video]
  saveWebVideos(webVideos.value)
  selectedVideo.value = video
  showTags.value = false
}

// ---------- Rutas ----------
function onFinish(res) {
  const id = selected.value.id
  const previousBest = best(id)
  const entry = { fecha: new Date().toISOString(), ...res }
  results.value = { ...results.value, [id]: [entry, ...(results.value[id] || [])] }
  saveRouteResults(results.value)
  finish.value = { ...entry, previousBest, isBest: previousBest === null || res.tiempoSeg < previousBest }
}

async function onFile(e) {
  importError.value = ''
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  try {
    const route = parseGpx(await file.text(), file.name)
    imported.value = [...imported.value, route]
    if (!saveImportedRoutes(imported.value)) {
      importError.value = 'La ruta se cargó, pero no cabe en el almacenamiento del navegador: se perderá al recargar.'
    }
  } catch (err) {
    importError.value = err.message || 'No se pudo leer el GPX.'
  }
}

function removeRoute(route) {
  if (!confirm(`¿Eliminar la ruta "${route.nombre}" y sus resultados?`)) return
  imported.value = imported.value.filter((r) => r.id !== route.id)
  saveImportedRoutes(imported.value)
  const { [route.id]: _, ...rest } = results.value
  results.value = rest
  saveRouteResults(rest)
  forgetVideo(route.id)
}

const dateFmt = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' })
</script>

<template>
  <div class="space-y-4">
    <!-- Antes de rodar -->
    <section v-if="picking" class="space-y-4">
      <div class="flex gap-1 rounded-xl border border-zinc-800 bg-zinc-900 p-1 text-sm sm:w-fit" role="group" aria-label="Dónde rodar">
        <button
          v-for="t in [
            { id: 'videos', label: 'Videos reales' },
            { id: 'rutas', label: 'Rutas y paseo libre' },
          ]"
          :key="t.id"
          class="flex-1 rounded-lg px-4 py-1.5 font-medium transition sm:flex-none"
          :class="pickTab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'"
          :aria-pressed="pickTab === t.id"
          @click="pickTab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- Videos reales -->
      <template v-if="pickTab === 'videos'">
        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <h2 class="text-sm font-semibold text-zinc-100">Un video distinto cada vez</h2>
          <div class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <label class="field">
              Lugar
              <select v-model="filters.region"><option v-for="o in REGIONS" :key="o.id" :value="o.id">{{ o.label }}</option></select>
            </label>
            <label class="field">
              Momento
              <select v-model="filters.momento"><option v-for="o in MOMENTS" :key="o.id" :value="o.id">{{ o.label }}</option></select>
            </label>
            <label class="field">
              Terreno
              <select v-model="filters.terreno"><option v-for="o in TERRAINS" :key="o.id" :value="o.id">{{ o.label }}</option></select>
            </label>
            <label class="field">
              Duración mínima
              <select v-model.number="filters.duracionMin">
                <option v-for="m in MIN_DURATIONS" :key="m" :value="m">{{ m }} min</option>
              </select>
            </label>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
            <button class="btn-primary" :disabled="searching" @click="surprise">
              {{ searching ? 'Buscando…' : 'Sorpréndeme' }}
            </button>
            <label class="flex items-center gap-2 text-xs text-zinc-400">
              <input v-model="filters.sinMusica" type="checkbox" class="accent-orange-500" />
              Sin música
            </label>
          </div>
          <p v-if="videoError" role="alert" class="mt-3 text-sm text-amber-200">{{ videoError }}</p>

          <details class="mt-3 text-xs text-zinc-400" :open="!youtubeKey">
            <summary class="cursor-pointer">Clave de búsqueda {{ youtubeKey ? '(lista)' : '(falta)' }}</summary>
            <div class="mt-2 space-y-2">
              <p>
                Para buscar en todo YouTube se necesita una clave gratuita: en console.cloud.google.com crea un proyecto,
                activa "YouTube Data API v3" y crea una clave de API. Conviene restringirla al sitio donde usas la app. Sin clave,
                solo se elige entre tu lista. La clave queda solo en este navegador.
              </p>
              <input
                v-model.lazy.trim="youtubeKey"
                type="password"
                autocomplete="off"
                placeholder="Pega tu clave y presiona Enter"
                aria-label="Clave de YouTube Data API"
                class="w-full max-w-md rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-zinc-100"
              />
              <p>Lugar y terreno se buscan por texto, y "de noche" es muy poco común: pueden no ser exactos. En tu lista sí lo son.</p>
            </div>
          </details>
        </div>

        <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="text-sm font-semibold text-zinc-100">Mi lista</h2>
            <a :href="YOUTUBE_SEARCH_URL" target="_blank" rel="noopener" class="text-xs text-sky-300 hover:text-sky-200">
              Buscar videos en YouTube ↗
            </a>
          </div>
          <form class="mt-3 flex flex-wrap gap-2" @submit.prevent="addVideo">
            <input
              v-model="videoLink"
              type="text"
              placeholder="Pega aquí el enlace de un video"
              aria-label="Enlace del video de YouTube"
              class="min-w-0 flex-1 basis-64 rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100"
            />
            <button type="submit" class="btn-ghost">Rodar</button>
          </form>
          <div v-if="webVideos.length" class="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div
              v-for="v in webVideos"
              :key="v.id"
              class="route-card relative"
              role="button"
              tabindex="0"
              @click="startVideo(v)"
              @keydown.enter="startVideo(v)"
            >
              <span class="line-clamp-2 pr-6 text-sm font-semibold text-zinc-100">{{ v.nombre }}</span>
              <span class="text-xs text-zinc-400">{{ tagsLabel(v) || 'Sin etiquetas' }}</span>
              <button
                class="absolute right-3 top-3 text-zinc-600 hover:text-red-400"
                aria-label="Quitar video"
                @click.stop="removeVideo(v)"
              >
                ✕
              </button>
            </div>
          </div>
          <p v-else class="mt-3 text-xs text-zinc-500">Los videos que guardes mientras ruedas aparecerán aquí.</p>
        </div>
      </template>

      <!-- Rutas y paseo libre -->
      <template v-else>
        <div class="flex justify-end">
          <button class="text-sm text-sky-300 hover:text-sky-200" @click="fileInput.click()">+ Importar GPX</button>
          <input ref="fileInput" type="file" accept=".gpx,application/gpx+xml" class="hidden" @change="onFile" />
        </div>
        <p v-if="importError" role="alert" class="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm text-red-200">
          {{ importError }}
        </p>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button class="route-card" @click="start(null)">
            <span class="font-semibold text-zinc-100">Paseo libre</span>
            <span class="text-xs text-zinc-400">Sin recorrido fijo: la pendiente la pone tu marcha.</span>
          </button>
          <div v-for="r in routes" :key="r.id" class="route-card relative" role="button" tabindex="0" @click="start(r)" @keydown.enter="start(r)">
            <span class="pr-6 font-semibold text-zinc-100">{{ r.nombre }}</span>
            <span class="text-xs text-zinc-400 tabular-nums">
              {{ (routeLength(r) / 1000).toFixed(1) }} km · ▲ {{ ascent(r) }} m
            </span>
            <span class="text-xs tabular-nums" :class="best(r.id) ? 'text-orange-300' : 'text-zinc-600'">
              {{ best(r.id) ? `Mejor tiempo ${fmtTime(best(r.id))}` : 'Sin recorridos aún' }}
            </span>
            <button
              v-if="!r.incluida"
              class="absolute right-3 top-3 text-zinc-600 hover:text-red-400"
              aria-label="Eliminar ruta importada"
              @click.stop="removeRoute(r)"
            >
              ✕
            </button>
          </div>
        </div>
      </template>
    </section>

    <!-- Rodando -->
    <template v-else>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p class="min-w-0 flex-1 basis-64 truncate text-sm font-semibold text-zinc-100">
          {{ selectedVideo ? selectedVideo.nombre : selected ? selected.nombre : 'Paseo libre' }}
        </p>
        <div class="flex flex-wrap gap-2">
          <template v-if="selectedVideo">
            <button v-if="surpriseMode" class="btn-ghost" :disabled="searching" @click="nextVideo">
              {{ searching ? 'Buscando…' : 'Otro video' }}
            </button>
            <button class="btn-ghost" @click="openTags">{{ currentIsSaved ? 'Etiquetas' : 'Guardar en mi lista' }}</button>
          </template>
          <button class="btn-ghost" @click="leave">
            {{ selected && !finish ? 'Abandonar ruta' : 'Volver' }}
          </button>
        </div>
      </div>

      <p v-if="skipNotice" class="text-xs text-amber-200">{{ skipNotice }}</p>

      <div v-if="showTags" class="flex flex-wrap items-end gap-3 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <label class="field">
          Lugar
          <select v-model="tagDraft.region">
            <option v-for="o in REGIONS" :key="o.id" :value="o.id">{{ o.id === 'any' ? 'Sin definir' : o.label }}</option>
          </select>
        </label>
        <label class="field">
          Momento
          <select v-model="tagDraft.momento">
            <option v-for="o in MOMENTS" :key="o.id" :value="o.id">{{ o.id === 'any' ? 'Sin definir' : o.label }}</option>
          </select>
        </label>
        <label class="field">
          Terreno
          <select v-model="tagDraft.terreno">
            <option v-for="o in TERRAINS" :key="o.id" :value="o.id">{{ o.id === 'any' ? 'Sin definir' : o.label }}</option>
          </select>
        </label>
        <button class="btn-primary" @click="saveCurrent">Guardar</button>
        <button class="btn-ghost" @click="showTags = false">Cancelar</button>
      </div>

      <div v-if="finish" class="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-4">
        <p class="text-lg font-bold text-emerald-300">
          ¡Llegaste a la meta!
          <span v-if="finish.isBest && finish.previousBest !== null" class="ml-2 text-sm font-semibold text-orange-300">Nuevo mejor tiempo</span>
        </p>
        <div class="mt-2 flex flex-wrap gap-x-8 gap-y-1 text-sm text-zinc-300 tabular-nums">
          <span>Tiempo <strong class="text-zinc-100">{{ fmtTime(finish.tiempoSeg) }}</strong></span>
          <span>Velocidad media <strong class="text-zinc-100">{{ finish.velMediaKmh }} km/h</strong></span>
          <span>Desnivel <strong class="text-zinc-100">▲ {{ ascent(selected) }} m</strong></span>
          <span v-if="finish.previousBest !== null">
            Mejor anterior <strong class="text-zinc-100">{{ fmtTime(finish.previousBest) }}</strong>
          </span>
        </div>
        <details v-if="(results[selected.id] || []).length > 1" class="mt-3 text-sm text-zinc-400">
          <summary class="cursor-pointer">Recorridos anteriores en esta ruta</summary>
          <ul class="mt-2 space-y-1 tabular-nums">
            <li v-for="r in results[selected.id]" :key="r.fecha">
              {{ dateFmt.format(new Date(r.fecha)) }} · {{ fmtTime(r.tiempoSeg) }} · {{ r.velMediaKmh }} km/h
            </li>
          </ul>
        </details>
      </div>

      <RideScene
        :key="selectedVideo ? 'web' : (selected?.id ?? 'libre')"
        :watts="watts"
        :rpm="rpm"
        :gear="gear"
        :heart-rate="heartRate"
        :route="selected"
        :web-video="selectedVideo"
        @finish="onFinish"
        @video-meta="onVideoMeta"
        @video-unavailable="onVideoUnavailable"
      />
    </template>
  </div>
</template>

<style scoped>
@reference "../style.css";

.route-card {
  @apply flex cursor-pointer flex-col items-start gap-1 rounded-2xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-left transition hover:border-zinc-600 hover:bg-zinc-800/60;
}
.btn-ghost {
  @apply rounded-xl border border-zinc-700 px-3 py-1.5 text-sm font-medium text-zinc-300 transition hover:bg-zinc-800 disabled:opacity-40;
}
.btn-primary {
  @apply rounded-xl bg-orange-500 px-5 py-1.5 text-sm font-semibold text-zinc-950 transition hover:bg-orange-400 disabled:opacity-50;
}
.field {
  @apply flex min-w-0 flex-col gap-1 text-xs text-zinc-400;
}
.field select {
  @apply w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100;
}
</style>
