<script setup>
import { computed, reactive, ref } from 'vue'
import TrendChart from './TrendChart.vue'
import { MARK_SECONDS, bestMarks, efficiencyOf, fullRides, marksOf, weeklySummaries } from '../sessions/analysis'
import { addBodyEntry, bodyChange, bodyLog, removeBodyEntry } from '../sessions/bodyLog'
import { createBackup, restoreBackup } from '../sessions/backup'
import { downloadText } from '../utils/download'
import { planDates } from '../training/workout'

const props = defineProps({ history: { type: Array, required: true } })

const shortDate = new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'numeric' })
const fullDate = new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium' })
const label = (date) => shortDate.format(new Date(date))

// ---------- Semanas ----------
const weeks = computed(() => weeklySummaries(props.history, planDates.value))
const thisWeek = computed(() => weeks.value[weeks.value.length - 1])
const lastWeek = computed(() => weeks.value[weeks.value.length - 2])
const minutesPoints = computed(() => weeks.value.map((w) => ({ label: label(w.inicio), value: w.minutos })))

function compare(key) {
  const diff = Math.round((thisWeek.value[key] - lastWeek.value[key]) * 10) / 10
  if (diff === 0) return 'igual que la semana pasada'
  return `${diff > 0 ? '+' : ''}${diff} frente a la semana pasada`
}

// ---------- Cuerpo ----------
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const form = reactive({ fecha: today(), cinturaCm: '', pesoKg: '' })
const formError = ref('')

function saveBody() {
  formError.value = addBodyEntry(form)
  if (!formError.value) {
    form.cinturaCm = ''
    form.pesoKg = ''
  }
}
const bodyPoints = (field) => bodyLog.value.filter((e) => e[field] !== null).map((e) => ({ label: label(`${e.fecha}T12:00`), value: e[field] }))
const waistPoints = computed(() => bodyPoints('cinturaCm'))
const weightPoints = computed(() => bodyPoints('pesoKg'))
const waistChange = computed(() => bodyChange(bodyLog.value, 'cinturaCm'))
const weightChange = computed(() => bodyChange(bodyLog.value, 'pesoKg'))
const signed = (v) => `${v > 0 ? '+' : ''}${v}`

// ---------- Marcas y eficiencia ----------
const rides = computed(() => fullRides(props.history))
const marks = computed(() => bestMarks(props.history))
const mark20Points = computed(() =>
  rides.value.map((s) => ({ label: label(s.fecha), value: marksOf(s)[1200] })).filter((p) => p.value !== null),
)
const efficiencyPoints = computed(() =>
  rides.value.map((s) => ({ label: label(s.fecha), value: efficiencyOf(s) })).filter((p) => p.value !== null),
)
const cadencePoints = computed(() => rides.value.map((s) => ({ label: label(s.fecha), value: s.rpmPromedio })))

// ---------- Copia de seguridad ----------
const backupMessage = ref('')
const backupError = ref(false)

function downloadBackup() {
  const backup = createBackup()
  downloadText(JSON.stringify(backup), `respaldo-keiser-${today()}.json`)
  backupError.value = false
  backupMessage.value = `Copia descargada con ${Object.keys(backup.datos).length} grupos de datos.`
}

async function restore(event) {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  try {
    const backup = JSON.parse(await file.text())
    if (!confirm('Esto reemplaza lo guardado en este navegador por el contenido de la copia. ¿Continuar?')) return
    restoreBackup(backup)
    location.reload()
  } catch (err) {
    backupError.value = true
    backupMessage.value = err instanceof SyntaxError ? 'El archivo no es una copia de seguridad de esta app.' : err.message
  }
}
</script>

<template>
  <div class="space-y-6">
    <section class="card">
      <h2 class="card-title">Resumen semanal</h2>
      <div class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="tile">
          <p class="tile-label">Días con bici</p>
          <p class="tile-value">{{ thisWeek.dias }}</p>
          <p class="tile-note">{{ thisWeek.estado }}</p>
        </div>
        <div class="tile">
          <p class="tile-label">Minutos</p>
          <p class="tile-value">{{ thisWeek.minutos }}</p>
          <p class="tile-note">{{ compare('minutos') }}</p>
        </div>
        <div class="tile">
          <p class="tile-label">Calorías de la consola</p>
          <p class="tile-value">{{ thisWeek.kcal }}</p>
          <p class="tile-note">{{ compare('kcal') }}</p>
        </div>
        <div class="tile">
          <p class="tile-label">Kilómetros de la consola</p>
          <p class="tile-value">{{ thisWeek.km }}</p>
          <p class="tile-note">{{ compare('km') }}</p>
        </div>
      </div>
      <div class="mt-5">
        <TrendChart title="Minutos por semana (lunes de cada semana)" :points="minutesPoints" unit="min" kind="bar" />
      </div>
      <p class="mt-2 text-xs text-zinc-400">Cuentan las sesiones grabadas de 15 min o más. Las calorías de la consola son una estimación.</p>
    </section>

    <section class="card">
      <h2 class="card-title">Cintura y peso</h2>
      <p class="mt-1 text-xs text-zinc-400">
        Mide la cintura una vez por semana, a la altura del ombligo y en ayunas. Del peso, mira la tendencia y no un día suelto.
        Estos datos quedan solo en este navegador.
      </p>
      <form class="mt-3 flex flex-wrap items-end gap-3 text-sm text-zinc-300" @submit.prevent="saveBody">
        <label class="flex flex-col gap-1 text-xs">
          Fecha
          <input v-model="form.fecha" type="date" class="field w-40" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          Cintura (cm)
          <input v-model="form.cinturaCm" type="number" step="0.1" min="40" max="200" class="field w-24" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          Peso (kg)
          <input v-model="form.pesoKg" type="number" step="0.1" min="30" max="300" class="field w-24" />
        </label>
        <button class="rounded-lg bg-emerald-500 px-3 py-1.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400">Guardar</button>
      </form>
      <p v-if="formError" role="alert" class="mt-2 text-sm text-amber-200">{{ formError }}</p>

      <div class="mt-5 grid gap-6 lg:grid-cols-2">
        <div>
          <TrendChart title="Cintura" :points="waistPoints" unit="cm" :decimals="1" mark-class="fill-sky-400" line-class="stroke-sky-400" />
          <p v-if="waistChange !== null" class="mt-1 text-sm text-zinc-300">Cambio total: {{ signed(waistChange) }} cm</p>
        </div>
        <div>
          <TrendChart title="Peso" :points="weightPoints" unit="kg" :decimals="1" mark-class="fill-violet-400" line-class="stroke-violet-400" />
          <p v-if="weightChange !== null" class="mt-1 text-sm text-zinc-300">Cambio total: {{ signed(weightChange) }} kg</p>
        </div>
      </div>
      <details v-if="bodyLog.length" class="mt-3 text-xs text-zinc-400">
        <summary class="cursor-pointer">Editar mediciones ({{ bodyLog.length }})</summary>
        <ul class="mt-2 space-y-1">
          <li v-for="e in bodyLog" :key="e.fecha" class="flex items-center gap-3 tabular-nums">
            <span class="w-24">{{ fullDate.format(new Date(`${e.fecha}T12:00`)) }}</span>
            <span class="w-20">{{ e.cinturaCm ?? '—' }} cm</span>
            <span class="w-20">{{ e.pesoKg ?? '—' }} kg</span>
            <button class="hover:text-red-400" :aria-label="`Eliminar medición del ${e.fecha}`" @click="removeBodyEntry(e.fecha)">✕</button>
          </li>
        </ul>
      </details>
    </section>

    <section class="card">
      <h2 class="card-title">Mejores marcas de potencia</h2>
      <div class="mt-3 grid grid-cols-3 gap-3">
        <div v-for="s in MARK_SECONDS" :key="s" class="tile">
          <p class="tile-label">{{ s / 60 }} min</p>
          <p class="tile-value">{{ marks[s]?.value ?? '—' }}<span v-if="marks[s]" class="text-sm font-normal text-zinc-400"> W</span></p>
          <p class="tile-note">{{ marks[s] ? fullDate.format(new Date(marks[s].fecha)) : 'Sin datos' }}</p>
        </div>
      </div>
      <div class="mt-5 grid gap-6 lg:grid-cols-2">
        <TrendChart title="Mejor potencia de 20 min por sesión" :points="mark20Points" unit="W" />
        <TrendChart title="Cadencia promedio por sesión" :points="cadencePoints" unit="rpm" mark-class="fill-sky-400" line-class="stroke-sky-400" />
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Eficiencia</h2>
      <p class="mt-1 text-xs text-zinc-400">
        Vatios por cada latido, de cada sesión con pulso. Solo compara sesiones de esfuerzo parecido: si sube a igual esfuerzo, vas
        mejorando.
      </p>
      <div class="mt-3">
        <TrendChart title="Vatios por latido" :points="efficiencyPoints" unit="W/lpm" :decimals="2" mark-class="fill-rose-400" line-class="stroke-rose-400" />
      </div>
    </section>

    <section class="card">
      <h2 class="card-title">Copia de seguridad</h2>
      <p class="mt-1 text-sm text-zinc-300">
        Guarda en un archivo tu historial, plan, intensidades, rutas GPX, cintura, peso y ajustes, para restaurarlos si borras los
        datos del navegador o cambias de equipo. No incluye tus claves de servicios ni archivos de video.
      </p>
      <div class="mt-3 flex flex-wrap gap-3 text-sm">
        <button class="rounded-lg bg-zinc-800 px-3 py-1.5 font-semibold text-zinc-100 hover:bg-zinc-700" @click="downloadBackup">
          Descargar copia
        </button>
        <label class="cursor-pointer rounded-lg border border-zinc-700 px-3 py-1.5 font-semibold text-zinc-200 hover:bg-zinc-800 focus-within:ring-2 focus-within:ring-sky-400">
          Restaurar copia
          <input type="file" accept=".json,application/json" class="sr-only" data-backup-input @change="restore" />
        </label>
      </div>
      <p v-if="backupMessage" role="status" class="mt-2 text-sm" :class="backupError ? 'text-amber-200' : 'text-emerald-300'">{{ backupMessage }}</p>
    </section>
  </div>
</template>

<style scoped>
@reference "../style.css";

.card {
  @apply rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5;
}
.card-title {
  @apply text-sm font-semibold uppercase tracking-wider text-zinc-400;
}
.tile {
  @apply min-w-0 rounded-xl border border-zinc-800 p-3;
}
.tile-label {
  @apply text-xs text-zinc-400;
}
.tile-value {
  @apply mt-1 text-2xl font-bold tabular-nums text-zinc-100;
}
.tile-note {
  @apply mt-1 text-xs text-zinc-400;
}
.field {
  @apply rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1 text-sm text-zinc-100;
}
</style>
