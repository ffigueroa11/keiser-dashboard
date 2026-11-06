<script setup>
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, reactive, watch } from 'vue'
import { elevationAt, gradeAt, nextChange, routeLength } from '../routes/routes'
import RouteProfile from './RouteProfile.vue'
import RideVideo from './RideVideo.vue'
import RideYouTube from './RideYouTube.vue'
import { BARS, BB, FRONT, HEAD_TUBE, REAR, SEAT, computePose } from '../ride/pose'
import { zoneFor } from '../heartZones'

// Three.js pesa ~0.5 MB: la vista 3D se carga solo cuando se usa.
const Ride3D = defineAsyncComponent(() => import('./Ride3D.vue'))

/**
 * Escena lateral de un ciclista virtual. La cadencia real mueve las piernas y la potencia real,
 * con física de ciclismo, da la velocidad. La marcha de la Keiser (palanca de resistencia) fija la
 * postura y el esfuerzo del avatar.
 * - Paseo libre (sin `route`): la marcha también fija una pendiente virtual.
 * - Ruta: la pendiente la pone el terreno de la ruta, y se ve el relieve que viene.
 * - Video de la web (`webVideo`): como el paseo libre, pero en vez del dibujo se ve el video.
 */
const props = defineProps({
  watts: { type: Number, default: 0 },
  rpm: { type: Number, default: 0 },
  gear: { type: Number, default: null },
  heartRate: { type: Number, default: null },
  route: { type: Object, default: null },
  webVideo: { type: Object, default: null },
})
const emit = defineEmits(['finish', 'video-meta', 'video-unavailable'])

const MAX_SPEED = 70 / 3.6 // en bajadas largas, tope razonable (no hay frenos simulados)

// Física de ciclismo (valores típicos en ruta, posición sobre manillar).
const G = 9.81
const CRR = 0.004 // resistencia a la rodadura
const CDA = 0.32 // área frontal × coeficiente aerodinámico (m²)
const RHO = 1.2 // densidad del aire (kg/m³)
const ETA = 0.97 // eficiencia de la transmisión
const BIKE_KG = 9
const WHEEL_R = 0.34 // m
const PX_PER_M = 100 // escala de la escena
const TILT_EXAGGERATION = 2.5 // la pendiente real se vería casi plana; se exagera solo en el dibujo

const SETTINGS_KEY = 'keiser.ride'
const settings = reactive(loadSettings())
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
    return {
      weightKg: s.weightKg >= 30 && s.weightKg <= 200 ? s.weightKg : 75,
      mode: s.mode === 'llano' ? 'llano' : 'subida',
      view: ['2d', 'video'].includes(s.view) ? s.view : '3d',
      quality: ['baja', 'media', 'alta'].includes(s.quality) ? s.quality : 'media',
      landscape: ['generado', 'sentinel', 'maptiler', 'esri'].includes(s.landscape) ? s.landscape : 'sentinel',
    }
  } catch {
    return { weightKg: 75, mode: 'subida', view: '3d', quality: 'media', landscape: 'sentinel' }
  }
}
watch(settings, (s) => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s))
  } catch {
    /* sin almacenamiento: los ajustes duran solo esta visita */
  }
})

// Claves de los proveedores de imagen satelital: quedan solo en este navegador.
const KEYS_KEY = 'keiser.imageryKeys'
const imageryKeys = reactive(loadKeys())
function loadKeys() {
  try {
    const k = JSON.parse(localStorage.getItem(KEYS_KEY) || '{}')
    return { maptiler: String(k.maptiler || ''), esri: String(k.esri || '') }
  } catch {
    return { maptiler: '', esri: '' }
  }
}
watch(imageryKeys, (k) => {
  try {
    localStorage.setItem(KEYS_KEY, JSON.stringify(k))
  } catch {
    /* sin almacenamiento: la clave dura solo esta visita */
  }
})
const KEY_HELP = {
  maptiler: `Cuenta gratuita en maptiler.com → Account → API keys. Conviene restringirla al sitio donde usas la app (${location.origin}).`,
  esri: 'Cuenta gratuita de ArcGIS Location Platform → API key con acceso a basemaps.',
}
const needsKey = computed(() => settings.landscape === 'maptiler' || settings.landscape === 'esri')

const pedaling = computed(() => props.rpm > 0)
const hrZone = computed(() => zoneFor(props.heartRate))

const routeLen = computed(() => (props.route ? routeLength(props.route) : 0))

// Ruta: pendiente del terreno. Paseo libre: marchas 1-6 = llano; desde la 7, +0.5 % por marcha
// (marcha 24 = 9 %).
// El video solo aplica a rutas importadas (filmadas por ti); en las demás se usa el 3D.
const canVideo = computed(() => !!props.route && !props.route.incluida)
const view = computed(() => (settings.view === 'video' && !canVideo.value ? '3d' : settings.view))
const viewOptions = computed(() => (canVideo.value ? ['video', '3d', '2d'] : ['3d', '2d']))

const gradePct = computed(() => {
  if (props.route) return gradeAt(props.route, f.distM)
  return settings.mode === 'llano' || props.gear === null ? 0 : Math.max(0, props.gear - 6) * 0.5
})

// Esfuerzo 0-1: lo fija la marcha (la palanca); sin dato de marcha se estima por el torque.
const effort = computed(() => {
  if (!pedaling.value) return 0
  if (props.gear !== null) return Math.min(1, Math.max(0, (props.gear - 1) / 23))
  const torque = props.watts / ((props.rpm * 2 * Math.PI) / 60)
  return Math.min(1, torque / 40)
})
const effortLevel = computed(() => {
  if (!pedaling.value) return { label: 'Sin pedalear', cls: 'bg-zinc-600' }
  const e = effort.value
  if (e < 0.25) return { label: 'Suave', cls: 'bg-orange-200' }
  if (e < 0.5) return { label: 'Moderado', cls: 'bg-orange-300' }
  if (e < 0.75) return { label: 'Duro', cls: 'bg-orange-400' }
  return { label: 'Muy duro', cls: 'bg-orange-500' }
})

// Estado de la simulación, avanzado en cada cuadro.
const f = reactive({ v: 0, crank: 0, wheel: 0, distM: 0, e: 0, drops: [], routeTime: 0, finished: false })
let raf = 0
let last = null

const SIM_STEP_S = 0.1
const MAX_CATCH_UP_S = 120

function step(now) {
  // Con la pestaña oculta no hay cuadros: al volver se recupera ese tiempo en pasos cortos.
  let elapsed = last === null ? 0 : Math.min(MAX_CATCH_UP_S, (now - last) / 1000)
  last = now
  const frameDt = Math.min(SIM_STEP_S, elapsed)
  while (elapsed > 0) {
    const dt = Math.min(SIM_STEP_S, elapsed)
    advance(dt)
    elapsed -= dt
  }
  updateDrops(frameDt)
  raf = requestAnimationFrame(step)
}

function advance(dt) {
  const theta = Math.atan(gradePct.value / 100)
  const m = settings.weightKg + BIKE_KG
  const power = pedaling.value ? props.watts : 0
  const resist = m * G * (CRR * Math.cos(theta) + Math.sin(theta)) + 0.5 * RHO * CDA * f.v * f.v
  const propulsion = (power * ETA) / Math.max(f.v, 1.5)
  // Integrar la aceleración da inercia natural y suaviza los huecos entre paquetes de la bici.
  f.v = Math.min(MAX_SPEED, Math.max(0, f.v + ((propulsion - resist) / m) * dt))
  if (f.finished) f.v *= 0.9 // tras la meta, se detiene

  f.crank += (props.rpm / 60) * 2 * Math.PI * dt
  f.wheel += (f.v / WHEEL_R) * dt
  if (!f.finished) {
    f.distM += f.v * dt
    // El cronómetro de la ruta parte con el primer metro recorrido.
    if (props.route && f.distM > 0) f.routeTime += dt
    if (props.route && f.distM >= routeLen.value) {
      f.distM = routeLen.value
      f.finished = true
      emit('finish', {
        tiempoSeg: Math.round(f.routeTime),
        velMediaKmh: Math.round((routeLen.value / f.routeTime) * 3.6 * 10) / 10,
      })
    }
  }
  f.e += (effort.value - f.e) * Math.min(1, dt * 2) // la postura cambia en ~0.5 s
}

onMounted(() => (raf = requestAnimationFrame(step)))
onBeforeUnmount(() => cancelAnimationFrame(raf))

// ---------- Ciclista (postura compartida con la vista 3D) ----------
const rider = computed(() => computePose(f.crank, f.e, pedaling.value))

// Gotas de sudor cuando el esfuerzo es alto.
function updateDrops(dt) {
  const r = rider.value
  if (pedaling.value && f.e > 0.5 && f.drops.length < 6 && Math.random() < dt * (f.e - 0.4) * 8) {
    f.drops.push({ x: r.head.x - 4 + Math.random() * 6, y: r.head.y - 2, vy: -15, life: 0.9 })
  }
  for (const d of f.drops) {
    d.vy += 160 * dt
    d.y += d.vy * dt
    d.x -= 30 * dt // el viento las lleva hacia atrás
    d.life -= dt
  }
  f.drops = f.drops.filter((d) => d.life > 0)
}

const spokes = (c) =>
  [0, 1, 2].map((i) => {
    const ang = f.wheel + (i * Math.PI) / 3
    return { x1: c.x - 30 * Math.cos(ang), y1: c.y - 30 * Math.sin(ang), x2: c.x + 30 * Math.cos(ang), y2: c.y + 30 * Math.sin(ang) }
  })

// ---------- Escena ----------
const tiltDeg = computed(() => (Math.atan(gradePct.value / 100) * 180 * TILT_EXAGGERATION) / Math.PI)
const dashOffset = computed(() => -((f.distM * PX_PER_M) % 60))
const farShift = computed(() => -((f.distM * 4) % 800))
const nearShift = computed(() => -((f.distM * 12) % 800))
const speedKmh = computed(() => f.v * 3.6)

// Relieve de la ruta en el horizonte: ±1 km alrededor del ciclista (2.5 m por px), con la
// altura exagerada para que se lea la subida que viene.
const AHEAD_M_PER_PX = 2.5
const AHEAD_PX_PER_M = 1.2
const HORIZON_Y = 228
const terrain = computed(() => {
  if (!props.route) return null
  const here = elevationAt(props.route, f.distM)
  const pts = []
  for (let px = 0; px <= 800; px += 10) {
    const d = f.distM + (px - 400) * AHEAD_M_PER_PX
    const y = HORIZON_Y - (elevationAt(props.route, d) - here) * AHEAD_PX_PER_M
    pts.push(`${px},${Math.min(330, Math.max(30, y))}`)
  }
  const line = `M${pts.join('L')}`
  return { line, area: `${line}L800,340L0,340Z` }
})

const upcoming = computed(() => (props.route && !f.finished ? nextChange(props.route, f.distM) : null))

const fmtTime = (sec) => {
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0')
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

function resetDistance() {
  f.distM = 0
}
</script>

<template>
  <div class="space-y-4">
    <!-- Indicadores (en los modos de video ya van junto al video) -->
    <div
      v-if="!webVideo && !(route && view === 'video')"
      class="grid grid-cols-2 gap-3"
      :class="hrZone ? 'sm:grid-cols-3 lg:grid-cols-6' : 'sm:grid-cols-5'"
    >
      <div class="hud">
        <span class="hud-label">Velocidad</span>
        <span class="hud-value">{{ speedKmh.toFixed(1) }} <small>km/h</small></span>
      </div>
      <div v-if="hrZone" class="hud">
        <span class="hud-label">Pulso</span>
        <span class="hud-value text-rose-400">{{ heartRate }} <small>lpm</small></span>
        <span class="mt-0.5 text-xs font-semibold" :class="hrZone.text">Z{{ hrZone.n }} · {{ hrZone.nombre }}</span>
      </div>
      <div class="hud">
        <span class="hud-label">{{ route ? 'Pendiente' : 'Pendiente virtual' }}</span>
        <span class="hud-value">{{ gradePct.toFixed(1) }} <small>%</small></span>
      </div>
      <div class="hud">
        <span class="hud-label">Marcha</span>
        <span class="hud-value text-violet-400">{{ gear ?? '—' }}</span>
      </div>
      <div class="hud">
        <span class="hud-label" title="La calcula esta rodada con tu potencia y la pendiente. La de la consola está en Datos en vivo.">Distancia virtual</span>
        <span class="hud-value">
          {{ (f.distM / 1000).toFixed(2) }}
          <small>{{ route ? `/ ${(routeLen / 1000).toFixed(1)} km` : 'km' }}</small>
        </span>
      </div>
      <div class="hud col-span-2 sm:col-span-1">
        <span class="hud-label">Esfuerzo</span>
        <span class="mt-1 text-sm font-semibold text-zinc-100">{{ effortLevel.label }}</span>
        <div class="mt-2 h-2 rounded-full bg-zinc-800">
          <div
            class="h-full rounded-full transition-all duration-500"
            :class="effortLevel.cls"
            :style="{ width: `${Math.round(effort * 100)}%` }"
          ></div>
        </div>
      </div>
    </div>

    <!-- Escena: 3D (solo en rutas) o 2D -->
    <div v-if="route" class="flex flex-wrap items-center justify-end gap-3">
      <div class="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-1 text-xs" role="group" aria-label="Vista">
        <button
          v-for="v in viewOptions"
          :key="v"
          class="rounded-md px-3 py-1 font-semibold uppercase"
          :class="view === v ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'"
          :aria-pressed="view === v"
          @click="settings.view = v"
        >
          {{ v }}
        </button>
      </div>
    </div>
    <RideYouTube
      v-if="webVideo"
      :key="webVideo.id"
      :video="webVideo"
      :effort="effortLevel.label"
      :sim="f"
      :watts="watts"
      :rpm="rpm"
      :gear="gear"
      :grade="gradePct"
      :heart-rate="heartRate"
      @meta="emit('video-meta', $event)"
      @unavailable="emit('video-unavailable')"
    />
    <RideVideo
      v-else-if="route && view === 'video'"
      :route="route"
      :sim="f"
      :watts="watts"
      :rpm="rpm"
      :gear="gear"
      :grade="gradePct"
      :heart-rate="heartRate"
    />
    <Ride3D
      v-else-if="route && view === '3d'"
      :key="`${settings.quality}-${settings.landscape}-${imageryKeys[settings.landscape] ?? ''}`"
      :route="route"
      :sim="f"
      :pedaling="pedaling"
      :quality="settings.quality"
      :landscape="settings.landscape"
      :api-key="imageryKeys[settings.landscape] ?? ''"
    />
    <div v-else class="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900">
      <svg viewBox="0 0 800 340" class="block w-full" role="img" :aria-label="`Ciclista virtual, ${effortLevel.label}`">
        <defs>
          <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#0b1020" />
            <stop offset="1" stop-color="#1e293b" />
          </linearGradient>
        </defs>
        <rect width="800" height="340" fill="url(#sky)" />

        <!-- Cerros con paralaje -->
        <g :transform="`translate(${farShift} 0)`" class="fill-zinc-800/80">
          <path
            v-for="k in 2"
            :key="'far' + k"
            :transform="`translate(${(k - 1) * 800} 0)`"
            d="M0 200 L90 150 L170 185 L260 120 L350 175 L440 140 L540 190 L630 130 L720 170 L800 200 V340 H0 Z"
          />
        </g>
        <g v-if="terrain">
          <path :d="terrain.area" class="fill-zinc-700/70" />
          <path :d="terrain.line" fill="none" class="stroke-zinc-400/70" stroke-width="2" stroke-linejoin="round" />
        </g>
        <g v-else :transform="`translate(${nearShift} 0)`" class="fill-zinc-700/60">
          <path
            v-for="k in 2"
            :key="'near' + k"
            :transform="`translate(${(k - 1) * 800} 0)`"
            d="M0 240 L120 205 L230 235 L330 200 L460 238 L580 210 L700 236 L800 240 V340 H0 Z"
          />
        </g>

        <!-- Carretera y ciclista, inclinados según la pendiente -->
        <g :transform="`rotate(${-tiltDeg} 400 270)`" style="transition: transform 0.6s ease">
          <rect x="-1200" y="270" width="3200" height="600" class="fill-zinc-800" />
          <line x1="-1200" y1="271" x2="2000" y2="271" class="stroke-zinc-500" stroke-width="3" />
          <line
            x1="-1200"
            y1="284"
            x2="2000"
            y2="284"
            class="stroke-zinc-400"
            stroke-width="3"
            stroke-dasharray="30 30"
            :stroke-dashoffset="dashOffset"
          />

          <g transform="translate(400 270)" stroke-linecap="round" stroke-linejoin="round">
            <!-- Pierna izquierda (detrás, más oscura) -->
            <g opacity="0.55">
              <line :x1="rider.hip.x" :y1="rider.hip.y" :x2="rider.kneeL.x" :y2="rider.kneeL.y" stroke="#475569" stroke-width="8" />
              <line :x1="rider.kneeL.x" :y1="rider.kneeL.y" :x2="rider.pedalL.x" :y2="rider.pedalL.y" stroke="#c99a72" stroke-width="5" />
              <line :x1="rider.pedalL.x - 4" :y1="rider.pedalL.y" :x2="rider.pedalL.x + 6" :y2="rider.pedalL.y" stroke="#e4e4e7" stroke-width="4" />
            </g>

            <!-- Ruedas -->
            <g v-for="c in [REAR, FRONT]" :key="c.x">
              <circle :cx="c.x" :cy="c.y" r="33" fill="none" class="stroke-zinc-300" stroke-width="3" />
              <line v-for="(s, i) in spokes(c)" :key="i" v-bind="s" class="stroke-zinc-500" stroke-width="1" />
              <circle :cx="c.x" :cy="c.y" r="2.5" class="fill-zinc-300" />
            </g>

            <!-- Cuadro -->
            <polyline
              :points="`${REAR.x},${REAR.y} ${BB.x},${BB.y} ${SEAT.x},${SEAT.y} ${REAR.x},${REAR.y}`"
              fill="none"
              class="stroke-sky-400"
              stroke-width="4"
            />
            <polyline
              :points="`${SEAT.x},${SEAT.y} ${HEAD_TUBE.x},${HEAD_TUBE.y} ${BB.x},${BB.y}`"
              fill="none"
              class="stroke-sky-400"
              stroke-width="4"
            />
            <polyline
              :points="`${FRONT.x},${FRONT.y} ${HEAD_TUBE.x},${HEAD_TUBE.y} ${BARS.x - 4},${BARS.y} ${BARS.x + 4},${BARS.y + 6}`"
              fill="none"
              class="stroke-zinc-300"
              stroke-width="3"
            />
            <line :x1="SEAT.x - 10" :y1="SEAT.y - 3" :x2="SEAT.x + 8" :y2="SEAT.y - 3" class="stroke-zinc-200" stroke-width="4" />

            <!-- Biela -->
            <line
              :x1="rider.pedalL.x"
              :y1="rider.pedalL.y"
              :x2="rider.pedalR.x"
              :y2="rider.pedalR.y"
              class="stroke-zinc-400"
              stroke-width="3"
            />
            <circle :cx="BB.x" :cy="BB.y" r="5" fill="none" class="stroke-zinc-400" stroke-width="2" />

            <!-- Pierna derecha (delante) -->
            <line :x1="rider.hip.x" :y1="rider.hip.y" :x2="rider.kneeR.x" :y2="rider.kneeR.y" stroke="#475569" stroke-width="9" />
            <line :x1="rider.kneeR.x" :y1="rider.kneeR.y" :x2="rider.pedalR.x" :y2="rider.pedalR.y" stroke="#e8b98f" stroke-width="6" />
            <line :x1="rider.pedalR.x - 4" :y1="rider.pedalR.y" :x2="rider.pedalR.x + 6" :y2="rider.pedalR.y" stroke="#f4f4f5" stroke-width="4" />

            <!-- Torso, brazo y cabeza -->
            <line
              :x1="rider.hip.x"
              :y1="rider.hip.y"
              :x2="rider.shoulder.x"
              :y2="rider.shoulder.y"
              class="stroke-orange-400"
              stroke-width="11"
            />
            <polyline
              :points="`${rider.shoulder.x},${rider.shoulder.y} ${rider.elbow.x},${rider.elbow.y} ${BARS.x},${BARS.y}`"
              fill="none"
              class="stroke-orange-300"
              stroke-width="5"
            />
            <circle :cx="rider.head.x" :cy="rider.head.y" r="8" fill="#e8b98f" />
            <path
              :d="`M${rider.head.x - 9},${rider.head.y - 1} A9 9 0 0 1 ${rider.head.x + 9},${rider.head.y - 3} Z`"
              class="fill-sky-400"
            />
            <ellipse
              :cx="rider.head.x + 6"
              :cy="rider.head.y + 4"
              rx="1.6"
              :ry="rider.mouth"
              class="fill-zinc-900"
            />

            <!-- Sudor -->
            <circle
              v-for="(d, i) in f.drops"
              :key="'d' + i"
              :cx="d.x"
              :cy="d.y"
              r="1.8"
              class="fill-sky-300"
              :opacity="Math.min(1, d.life * 2)"
            />
          </g>
        </g>

        <!-- Señal de pendiente -->
        <g v-if="Math.abs(gradePct) >= 0.5" transform="translate(690 40)">
          <rect x="-8" y="-24" width="104" height="34" rx="8" class="fill-zinc-900/80 stroke-zinc-700" />
          <text x="44" y="-1" text-anchor="middle" class="fill-zinc-100 text-[18px] font-bold tabular-nums">
            {{ gradePct > 0 ? '▲' : '▼' }} {{ Math.abs(gradePct).toFixed(1) }}%
          </text>
        </g>
      </svg>
    </div>

    <!-- Ruta: tiempo, próximo tramo y perfil -->
    <div v-if="route" class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div class="mb-3 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-sm">
        <span class="text-zinc-400">
          Tiempo <span class="ml-1 font-semibold text-zinc-100 tabular-nums">{{ fmtTime(f.routeTime) }}</span>
        </span>
        <span v-if="f.finished" class="font-semibold text-emerald-400">Meta alcanzada</span>
        <span v-else-if="upcoming" class="text-zinc-300">
          En <span class="font-semibold tabular-nums">{{ upcoming.inM }} m</span>:
          <span class="font-semibold tabular-nums" :class="upcoming.grade > gradePct ? 'text-orange-300' : 'text-sky-300'">
            {{ upcoming.grade > 0 ? '▲' : '▼' }} {{ Math.abs(upcoming.grade).toFixed(1) }} %
          </span>
        </span>
        <span v-else class="text-zinc-400">Pendiente estable el próximo kilómetro</span>
      </div>
      <RouteProfile :route="route" :dist-m="f.distM" />
    </div>

    <!-- Ajustes -->
    <details class="text-xs text-zinc-400">
      <summary class="cursor-pointer">Ajustes de la simulación</summary>
      <div class="mt-2 flex flex-wrap items-center gap-x-6 gap-y-3">
      <label v-if="route && view === '3d' && route.origen" class="flex items-center gap-2">
        Paisaje
        <select v-model="settings.landscape" class="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100">
          <option value="sentinel">Real · Sentinel-2 (gratis)</option>
          <option value="maptiler">Real · MapTiler (nítido)</option>
          <option value="esri">Real · Esri (nítido)</option>
          <option value="generado">Generado</option>
        </select>
      </label>
      <label v-if="route && view === '3d'" class="flex items-center gap-2">
        Calidad
        <select v-model="settings.quality" class="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100">
          <option value="baja">Baja</option>
          <option value="media">Media</option>
          <option value="alta">Alta</option>
        </select>
      </label>
      <label v-if="!route" class="flex items-center gap-2">
        Modo
        <select v-model="settings.mode" class="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100">
          <option value="subida">Subida según la marcha</option>
          <option value="llano">Llano (solo postura)</option>
        </select>
      </label>
      <label class="flex items-center gap-2">
        Tu peso
        <input
          v-model.number="settings.weightKg"
          type="number"
          min="30"
          max="200"
          class="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-100"
        />
        kg
      </label>
      <button v-if="!route" class="text-zinc-400 hover:text-zinc-200" @click="resetDistance">Reiniciar distancia</button>
      </div>
      <div v-if="route?.origen && view === '3d' && needsKey" class="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <label class="flex items-center gap-2">
          Clave {{ settings.landscape === 'maptiler' ? 'MapTiler' : 'Esri' }}
          <input
            v-model.lazy.trim="imageryKeys[settings.landscape]"
            type="password"
            autocomplete="off"
            placeholder="pega tu API key y presiona Enter"
            class="w-64 max-w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
          />
        </label>
        <span>{{ KEY_HELP[settings.landscape] }} La clave queda guardada solo en este navegador.</span>
      </div>
    </details>
    <p v-if="gear === null && pedaling" class="text-xs text-zinc-400">
      Esta fuente no envía la marcha: el esfuerzo se estima con el torque (potencia ÷ cadencia).
    </p>
  </div>
</template>

<style scoped>
@reference "../style.css";

.hud {
  @apply flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3;
}
.hud-label {
  @apply text-[10px] font-semibold uppercase tracking-wider text-zinc-400 sm:text-xs;
}
.hud-value {
  @apply mt-1 text-2xl font-bold tabular-nums text-zinc-100;
}
.hud-value small {
  @apply text-xs font-normal text-zinc-400;
}
</style>
