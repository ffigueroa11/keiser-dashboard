<script setup>
import { computed, ref, watch } from 'vue'
import { useBike } from './composables/useBike'
import { useHeartRate } from './composables/useHeartRate'
import { useSession, formatDuration, buildSeries } from './composables/useSession'
import { ZONES, hrMax, isValidHrMax, zoneFor, zoneRanges } from './heartZones'
import SessionChart from './components/SessionChart.vue'
import VirtualRide from './components/VirtualRide.vue'
import TrainingPlan from './components/TrainingPlan.vue'
import WorkoutStrip from './components/WorkoutStrip.vue'
import { connectWorkout } from './training/workout'

const bike = useBike()
const {
  watts,
  rpm,
  mode,
  deviceName,
  sources,
  error,
  rawPacket,
  bleStats,
  consoleSeconds,
  gear,
  calories,
  distanceKm,
  heartRate: bikeHeartRate,
  isLive,
  isBluetoothSupported,
} = bike

// Pulso por Bluetooth: Apple Watch (con una app que lo transmite, como HeartCast) o banda de pecho.
const heart = useHeartRate()
const { bpm: sensorBpm, mode: hrMode, deviceName: hrName, error: hrError } = heart

// Pulso que se muestra y graba: el del sensor conectado y, si no hay, el que informe la consola Keiser.
const heartRate = computed(() => sensorBpm.value ?? bikeHeartRate.value)
const heartSource = computed(() => {
  if (sensorBpm.value !== null) return hrName.value
  if (bikeHeartRate.value !== null) return 'consola Keiser'
  return ''
})
const hrLabel = computed(() => {
  if (hrMode.value === 'connecting') return 'Conectando pulso…'
  if (hrMode.value === 'reconnecting') return 'Reconectando pulso…'
  if (heart.settling.value) return 'Estabilizando pulso…'
  return sensorBpm.value !== null ? `${sensorBpm.value} lpm` : 'Sin pulso'
})

// Zonas de pulso según el pulso máximo configurado (se guarda en este navegador).
function applyHrMax(event) {
  const value = Math.round(Number(event.target.value))
  if (isValidHrMax(value)) hrMax.value = value
  event.target.value = hrMax.value // un valor no válido vuelve al que sigue en uso
}
const currentZone = computed(() => zoneFor(heartRate.value, hrMax.value))
const zoneTable = computed(() => zoneRanges(hrMax.value))

const session = useSession({
  watts,
  rpm,
  bikeSeconds: consoleSeconds,
  gear,
  calories,
  distanceKm,
  heartRate,
})
const { isRecording, elapsedSeconds, liveStats, history, notice, records } = session

connectWorkout({
  watts,
  rpm,
  heartRate,
  isLive,
  isRecording,
  startRecording: session.start,
  finishRecording: session.finish,
})

const tab = ref('ride')
// La rodada sigue viva al mirar otra sección: se monta la primera vez y luego solo se oculta.
const rideOpened = ref(true)
watch(tab, (t) => {
  if (t === 'ride') rideOpened.value = true
})

// El pulso simulado acompaña al simulador de la bicicleta y se detiene con él.
function startSimulator() {
  bike.startSimulator()
  if (hrMode.value === 'idle') heart.startSimulator(watts)
}
watch(mode, (m) => {
  if (m !== 'simulator' && hrMode.value === 'simulator') heart.disconnect()
})

// Con la Keiser (anuncios BLE) son normales huecos de hasta ~14 s, y la escucha se reinicia a los 16 s:
// solo se avisa cuando eso tampoco la recuperó.
const signalLost = computed(() => mode.value === 'bluetooth' && bleStats.lastPacketAt > 0 && bleStats.silentSec >= 30)

const statusLabel = computed(() => {
  if (signalLost.value) return `${deviceName.value} · sin señal hace ${bleStats.silentSec} s`
  return {
    idle: 'Desconectado',
    connecting: 'Conectando…',
    bluetooth: `Conectado · ${deviceName.value}`,
    simulator: 'Modo simulador',
  }[mode.value]
})

const statusDot = computed(() => {
  if (signalLost.value) return 'bg-amber-400 animate-pulse'
  return {
    idle: 'bg-zinc-500',
    connecting: 'bg-amber-400 animate-pulse',
    bluetooth: 'bg-emerald-400',
    simulator: 'bg-sky-400',
  }[mode.value]
})

// Con la Keiser conectada siempre manda el tiempo de su consola; el cronómetro propio es solo
// para el simulador o bicicletas que no lo envían.
const hasBikeTime = computed(() => consoleSeconds.value !== null)
const shownSeconds = computed(() => (hasBikeTime.value ? consoleSeconds.value : elapsedSeconds.value))
const timeCaption = computed(() => {
  if (hasBikeTime.value) return isRecording.value ? 'tiempo de la bicicleta · grabando' : 'tiempo de la bicicleta'
  return isRecording.value ? 'grabando' : 'hh:mm:ss'
})

const liveSeries = computed(() => buildSeries(records.value))

const expandedId = ref(null)
const toggleRow = (id) => (expandedId.value = expandedId.value === id ? null : id)

const dash = (v, suffix = '') => (v === null || v === undefined ? '—' : `${v}${suffix}`)
const fmtKm = (v) => (v === null || v === undefined ? '—' : v.toFixed(2))

function disconnect() {
  if (isRecording.value && !confirm('Hay una sesión en curso. ¿Finalizarla y desconectar?')) return
  if (isRecording.value) session.finish()
  bike.disconnect()
}

function finishSession() {
  session.finish()
}

async function importSessions(event) {
  await session.importFiles([...event.target.files])
  event.target.value = '' // permite volver a elegir el mismo archivo
}

function clearHistory() {
  if (confirm('¿Borrar todo el historial de sesiones guardado en este navegador?')) session.clearHistory()
}

const dateFmt = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' })
const formatDate = (iso) => dateFmt.format(new Date(iso))
</script>

<template>
  <!-- Barra superior: secciones, bicicleta, pulso y sesión, siempre a mano -->
  <header class="sticky top-0 z-20 border-b border-zinc-800 bg-zinc-950">
    <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
      <h1 class="text-sm font-bold tracking-tight text-orange-400">Keiser M3i</h1>
      <nav class="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5 text-sm" aria-label="Secciones">
        <button
          v-for="t in [
            { id: 'ride', label: 'Rodar' },
            { id: 'plan', label: 'Plan' },
            { id: 'live', label: 'Datos en vivo' },
            { id: 'history', label: `Historial (${history.length})` },
          ]"
          :key="t.id"
          class="rounded-md px-3 py-1 font-medium transition"
          :class="tab === t.id ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'"
          :aria-current="tab === t.id ? 'page' : undefined"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </nav>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-2 px-1 text-xs text-zinc-300">
          <span class="h-2 w-2 rounded-full" :class="statusDot"></span>
          {{ statusLabel }}
        </div>
        <button
          v-if="mode !== 'bluetooth'"
          class="btn bg-orange-500 text-zinc-950 hover:bg-orange-400"
          :disabled="mode === 'connecting' || isRecording"
          @click="bike.connect"
        >
          {{ mode === 'connecting' ? 'Conectando…' : 'Conectar Bicicleta' }}
        </button>
        <button
          v-if="mode !== 'simulator'"
          class="btn border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          :disabled="mode === 'connecting' || isRecording"
          @click="startSimulator"
        >
          Simulador
        </button>
        <button v-if="isLive" class="btn border border-zinc-700 text-zinc-300 hover:bg-zinc-800" @click="disconnect">
          {{ mode === 'simulator' ? 'Detener simulador' : 'Desconectar' }}
        </button>
        <button
          v-if="hrMode === 'idle'"
          class="btn border border-rose-500/50 text-rose-300 hover:bg-rose-500/10"
          :disabled="!isBluetoothSupported"
          title="Pulso desde el Apple Watch (con una app como HeartCast) o una banda de pecho Bluetooth"
          @click="heart.connect"
        >
          ♥ Conectar pulso
        </button>
        <button
          v-else
          class="btn flex items-center gap-1.5 border border-zinc-700 text-zinc-300 hover:bg-zinc-800"
          :disabled="hrMode === 'connecting'"
          :title="`${hrName || 'Sensor de pulso'} · clic para desconectar`"
          @click="heart.disconnect"
        >
          <span class="text-rose-400" :class="sensorBpm !== null && 'animate-pulse'">♥</span>
          <span class="tabular-nums">{{ hrLabel }}</span>
          <span v-if="currentZone && sensorBpm !== null" class="font-bold" :class="currentZone.text">Z{{ currentZone.n }}</span>
          <span class="text-zinc-500">✕</span>
        </button>
        <button
          v-if="!isRecording"
          class="btn bg-emerald-500 text-zinc-950 hover:bg-emerald-400"
          :disabled="!isLive"
          :title="isLive ? '' : 'Conecta la bicicleta o activa el simulador'"
          @click="session.start"
        >
          ● Grabar sesión
        </button>
        <button v-else class="btn bg-red-500 text-white hover:bg-red-400" @click="finishSession">
          ■ {{ formatDuration(shownSeconds) }} · Finalizar
        </button>
      </div>
    </div>
    <WorkoutStrip />
  </header>

  <div class="mx-auto max-w-6xl px-4 py-4 sm:px-6">

    <!-- Alertas -->
    <div
      v-if="!isBluetoothSupported"
      class="mb-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
    >
      Este navegador no soporta Web Bluetooth. Puedes usar el <strong>Simulador</strong>, o abrir la app en
      Chrome / Edge para conectar la bicicleta.
    </div>
    <div
      v-if="error"
      role="alert"
      class="mb-4 flex items-start justify-between gap-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
    >
      <span>{{ error }}</span>
      <button class="shrink-0 text-red-300 hover:text-white" aria-label="Cerrar alerta" @click="error = ''">✕</button>
    </div>
    <div
      v-if="hrError"
      role="alert"
      class="mb-4 flex items-start justify-between gap-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
    >
      <span>{{ hrError }}</span>
      <button class="shrink-0 text-red-300 hover:text-white" aria-label="Cerrar alerta" @click="hrError = ''">
        ✕
      </button>
    </div>
    <div
      v-if="notice"
      class="mb-4 flex items-start justify-between gap-4 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200"
    >
      <span>{{ notice }}</span>
      <button class="shrink-0 text-emerald-300 hover:text-white" aria-label="Cerrar aviso" @click="notice = ''">
        ✕
      </button>
    </div>

    <!-- En vivo -->
    <main v-if="tab === 'live'" class="space-y-6">
      <div class="grid gap-4 sm:grid-cols-3">
        <div class="metric">
          <span class="metric-label">Potencia</span>
          <span class="metric-value text-orange-400">{{ watts }}</span>
          <span class="metric-unit">vatios</span>
        </div>
        <div class="metric">
          <span class="metric-label">Cadencia</span>
          <span class="metric-value text-sky-400">{{ rpm }}</span>
          <span class="metric-unit">rpm</span>
        </div>
        <div class="metric">
          <span class="metric-label flex items-center gap-2">
            Tiempo
            <span v-if="isRecording" class="flex items-center gap-1 text-red-400">
              <span class="h-2 w-2 animate-pulse rounded-full bg-red-500"></span>REC
            </span>
          </span>
          <span class="metric-value text-zinc-100">{{ formatDuration(shownSeconds) }}</span>
          <span class="metric-unit">{{ timeCaption }}</span>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div class="metric-sm">
          <span class="metric-label">Pulso</span>
          <span class="metric-sm-value text-rose-400">{{ dash(heartRate) }}</span>
          <span v-if="currentZone" class="mt-1 truncate text-xs font-semibold" :class="currentZone.text">
            Z{{ currentZone.n }} · {{ currentZone.nombre }}
          </span>
          <div class="mt-2 flex gap-0.5" aria-hidden="true">
            <div
              v-for="z in ZONES"
              :key="z.n"
              class="h-1.5 flex-1 rounded-full"
              :class="currentZone && z.n <= currentZone.n ? z.bar : 'bg-zinc-800'"
            ></div>
          </div>
          <span class="metric-unit truncate">lpm{{ heartSource ? ` · ${heartSource}` : '' }}</span>
        </div>
        <div class="metric-sm">
          <span class="metric-label">Resistencia</span>
          <span class="metric-sm-value text-violet-400">{{ dash(gear) }}</span>
          <span class="metric-unit">marcha (1–24)</span>
        </div>
        <div class="metric-sm">
          <span class="metric-label">Calorías</span>
          <span class="metric-sm-value">{{ dash(calories) }}</span>
          <span class="metric-unit">kcal</span>
        </div>
        <div class="metric-sm">
          <span class="metric-label">Distancia</span>
          <span class="metric-sm-value">{{ fmtKm(distanceKm) }}</span>
          <span class="metric-unit">km</span>
        </div>
      </div>

      <details class="rounded-2xl border border-zinc-800 bg-zinc-900/60 px-5 py-3 text-sm text-zinc-400">
        <summary class="cursor-pointer text-xs font-semibold uppercase tracking-wider">
          Zonas de pulso · pulso máximo {{ hrMax }} lpm
        </summary>
        <div class="mt-3 flex flex-wrap items-start gap-x-8 gap-y-4">
          <div class="max-w-sm space-y-2">
            <label class="flex items-center gap-2 text-zinc-300">
              Pulso máximo
              <input
                :value="hrMax"
                type="number"
                min="100"
                max="230"
                class="w-20 rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-zinc-100"
                @change="applyHrMax"
              />
              lpm
            </label>
            <p class="text-xs text-zinc-500">
              Lo más preciso es el máximo que hayas visto en un esfuerzo a fondo o en una prueba de esfuerzo. Si no lo
              conoces, una estimación común es 208 − 0,7 × tu edad. Queda guardado en este navegador.
            </p>
          </div>
          <table class="text-xs tabular-nums">
            <tbody>
              <tr v-for="z in zoneTable" :key="z.n">
                <td class="py-0.5 pr-3 font-semibold" :class="z.text">Z{{ z.n }}</td>
                <td class="py-0.5 pr-4 text-zinc-300">{{ z.nombre }}</td>
                <td class="py-0.5 text-zinc-400">
                  {{ z.n === 1 ? `menos de ${z.hi}` : z.hi === null ? `${z.lo} o más` : `${z.lo}–${z.hi - 1}` }} lpm
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>

      <div class="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
        <div class="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Sesión actual</h2>
          <span class="text-xs text-zinc-500">
            {{ records.length }} muestras · fuente: {{ sources.join(', ') || '—' }}
          </span>
        </div>
        <div
          class="grid grid-cols-2 gap-4 text-center sm:grid-cols-4"
          :class="liveStats.avgHr !== null && 'lg:grid-cols-6'"
        >
          <div>
            <p class="tabular text-2xl font-bold">{{ liveStats.avgWatts }}</p>
            <p class="text-xs text-zinc-500">W promedio</p>
          </div>
          <div>
            <p class="tabular text-2xl font-bold">{{ liveStats.maxWatts }}</p>
            <p class="text-xs text-zinc-500">W máximo</p>
          </div>
          <div>
            <p class="tabular text-2xl font-bold">{{ liveStats.avgRpm }}</p>
            <p class="text-xs text-zinc-500">RPM promedio</p>
          </div>
          <div>
            <p class="tabular text-2xl font-bold">{{ dash(liveStats.avgGear) }}</p>
            <p class="text-xs text-zinc-500">Marcha promedio</p>
          </div>
          <template v-if="liveStats.avgHr !== null">
            <div>
              <p class="tabular text-2xl font-bold text-rose-400">{{ liveStats.avgHr }}</p>
              <p class="text-xs text-zinc-500">Pulso promedio</p>
            </div>
            <div>
              <p class="tabular text-2xl font-bold">{{ liveStats.maxHr }}</p>
              <p class="text-xs text-zinc-500">Pulso máximo</p>
            </div>
          </template>
        </div>
        <div class="mt-6">
          <SessionChart v-if="records.length >= 2" :series="liveSeries" />
          <p v-else class="py-10 text-center text-sm text-zinc-500">
            Inicia una sesión para ver la potencia, el pulso y la resistencia en el tiempo.
          </p>
        </div>
        <details v-if="rawPacket || (mode === 'bluetooth' && bleStats.packets)" class="mt-3 text-xs text-zinc-500">
          <summary class="cursor-pointer">Diagnóstico Bluetooth</summary>
        <p v-if="rawPacket" class="mt-3 break-all font-mono text-[11px] text-zinc-600">
          Último anuncio Keiser: {{ rawPacket }}
        </p>
        <p v-if="mode === 'bluetooth' && bleStats.packets" class="mt-1 text-[11px] text-zinc-500 tabular-nums">
          Señal: {{ bleStats.packets }} anuncios recibidos · último hace {{ bleStats.silentSec ?? 0 }} s ·
          reinicios de escucha: {{ bleStats.restarts }}
        </p>
        </details>
      </div>
    </main>

    <!-- Plan de entrenamiento -->
    <main v-if="tab === 'plan'">
      <TrainingPlan :is-live="isLive" @ride="tab = 'ride'" />
    </main>

    <!-- Rodar -->
    <main v-if="rideOpened" v-show="tab === 'ride'">
      <VirtualRide :watts="watts" :rpm="rpm" :gear="gear" :heart-rate="heartRate" />
    </main>

    <!-- Historial -->
    <section v-if="tab === 'history'" class="rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <div class="flex items-center justify-between border-b border-zinc-800 px-5 py-4">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-zinc-400">Sesiones anteriores</h2>
        <div class="flex items-center gap-4">
          <button v-if="history.length" class="text-xs text-zinc-500 hover:text-red-400" @click="clearHistory">
            Borrar historial
          </button>
          <label class="btn cursor-pointer bg-zinc-800 text-zinc-100 hover:bg-zinc-700 focus-within:ring-2 focus-within:ring-sky-400">
            Importar sesiones
            <input type="file" accept=".json,application/json" multiple class="sr-only" @change="importSessions" />
          </label>
        </div>
      </div>
      <p v-if="!history.length" class="px-5 py-10 text-center text-sm text-zinc-500">
        Aún no hay sesiones guardadas. Finaliza una sesión o importa tus archivos sesion-keiser-….json.
      </p>
      <div v-else class="overflow-x-auto">
        <table class="tabular w-full text-sm">
          <thead class="text-left text-xs uppercase tracking-wider text-zinc-500">
            <tr>
              <th class="px-5 py-3 font-medium">Fecha</th>
              <th class="px-5 py-3 font-medium">Duración</th>
              <th class="px-5 py-3 text-right font-medium">W prom.</th>
              <th class="px-5 py-3 text-right font-medium">W máx.</th>
              <th class="px-5 py-3 text-right font-medium">RPM prom.</th>
              <th class="px-5 py-3 text-right font-medium">Marcha prom.</th>
              <th class="px-5 py-3 text-right font-medium">Pulso prom.</th>
              <th class="px-5 py-3 text-right font-medium">kcal</th>
              <th class="px-5 py-3 text-right font-medium">km</th>
              <th class="px-5 py-3"></th>
            </tr>
          </thead>
          <tbody v-for="s in history" :key="s.id" class="border-t border-zinc-800">
            <tr
              class="cursor-pointer hover:bg-zinc-800/40"
              :class="expandedId === s.id && 'bg-zinc-800/30'"
              :aria-expanded="expandedId === s.id"
              @click="toggleRow(s.id)"
            >
              <td class="whitespace-nowrap px-5 py-3">
                <span class="mr-2 inline-block w-3 text-zinc-500">{{ expandedId === s.id ? '▾' : '▸' }}</span>
                {{ formatDate(s.fecha) }}
                <span class="block pl-5 text-xs text-zinc-500">{{ s.archivo }}</span>
              </td>
              <td class="px-5 py-3">{{ formatDuration(s.duracionSeg) }}</td>
              <td class="px-5 py-3 text-right font-semibold text-orange-400">{{ s.wattsPromedio }}</td>
              <td class="px-5 py-3 text-right">{{ s.wattsMax }}</td>
              <td class="px-5 py-3 text-right text-sky-400">{{ s.rpmPromedio }}</td>
              <td class="px-5 py-3 text-right text-violet-400">
                {{ dash(s.marchaPromedio) }}
                <span v-if="s.marchaMax" class="text-xs text-zinc-500">/ {{ s.marchaMax }}</span>
              </td>
              <td class="px-5 py-3 text-right text-rose-400">
                {{ dash(s.pulsoPromedio) }}
                <span v-if="s.pulsoMax" class="text-xs text-zinc-500">/ {{ s.pulsoMax }}</span>
              </td>
              <td class="px-5 py-3 text-right">{{ dash(s.calorias) }}</td>
              <td class="px-5 py-3 text-right">{{ fmtKm(s.distanciaKm) }}</td>
              <td class="px-5 py-3 text-right">
                <button
                  class="text-zinc-600 hover:text-red-400"
                  aria-label="Eliminar sesión"
                  @click.stop="session.deleteSession(s.id)"
                >
                  ✕
                </button>
              </td>
            </tr>
            <tr v-if="expandedId === s.id">
              <td colspan="10" class="bg-zinc-950/40 px-5 py-5">
                <p v-if="s.duracionSeg - s.muestras > 60" class="mb-4 text-xs text-zinc-400">
                  Tiempo, km y kcal son los de la consola. El gráfico y los promedios cubren solo los
                  {{ formatDuration(s.muestras) }} que se grabaron.
                </p>
                <SessionChart v-if="s.serie" :series="s.serie" breakdown />
                <p v-else class="py-4 text-center text-sm text-zinc-500">
                  Esta sesión se guardó antes de que existiera el gráfico; sus datos completos están en
                  {{ s.archivo }}.
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
@reference "./style.css";

.btn {
  @apply rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-40;
}
.metric {
  @apply flex flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 p-6;
}
.metric-label {
  @apply truncate text-[10px] font-semibold uppercase tracking-wider text-zinc-400 sm:text-xs;
}
.metric-value {
  @apply mt-2 tabular-nums text-6xl font-bold leading-none sm:text-7xl;
}
.metric-sm {
  @apply flex min-w-0 flex-col rounded-2xl border border-zinc-800 bg-zinc-900/60 px-3 py-4 sm:px-6;
}
.metric-sm-value {
  @apply mt-1 text-3xl font-bold tabular-nums sm:text-4xl;
}
.metric-unit {
  @apply mt-2 text-sm text-zinc-500;
}
</style>
