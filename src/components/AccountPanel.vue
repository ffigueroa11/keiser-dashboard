<script setup>
import { computed, reactive, ref } from 'vue'
import {
  authReady,
  isSignedIn,
  lastSyncAt,
  sendReset,
  signInWithEmail,
  signInWithGoogle,
  signOutUser,
  signUpWithEmail,
  skippedKeys,
  syncError,
  syncNow,
  syncStatus,
  user,
} from '../cloud/useCloud'

/** Botón de la barra superior y panel para entrar, crear cuenta y ver la sincronización. */
const open = ref(false)
const mode = ref('login') // login | signup
const form = reactive({ email: '', password: '' })
const busy = ref(false)
const message = ref('')
const messageIsError = ref(true)

const timeFmt = new Intl.DateTimeFormat('es-CL', { timeStyle: 'short' })
const syncLabel = computed(() => {
  if (syncStatus.value === 'syncing') return 'Sincronizando…'
  if (syncStatus.value === 'error') return syncError.value
  if (lastSyncAt.value) return `Sincronizado a las ${timeFmt.format(lastSyncAt.value)}`
  return 'Sincroniza al terminar cada sesión y cada 5 minutos.'
})
const buttonDot = computed(() => {
  if (syncStatus.value === 'error') return 'bg-amber-400'
  return syncStatus.value === 'syncing' ? 'animate-pulse bg-sky-400' : 'bg-emerald-400'
})

async function run(action, success = '') {
  busy.value = true
  message.value = ''
  const error = await action()
  busy.value = false
  message.value = error || success
  messageIsError.value = !!error
  if (!error && !success) {
    form.password = ''
    open.value = false
  }
}

const submit = () =>
  run(() => (mode.value === 'login' ? signInWithEmail(form.email, form.password) : signUpWithEmail(form.email, form.password)))
const google = () => run(signInWithGoogle)
function reset() {
  if (!form.email) {
    message.value = 'Escribe tu correo para enviarte el enlace.'
    messageIsError.value = true
    return
  }
  run(() => sendReset(form.email), 'Si el correo tiene cuenta, te enviamos un enlace para cambiar la contraseña.')
}
</script>

<template>
  <button
    class="flex max-w-44 items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
    :disabled="!authReady"
    data-account-button
    @click="open = true"
  >
    <template v-if="isSignedIn">
      <span class="h-2 w-2 shrink-0 rounded-full" :class="buttonDot"></span>
      <span class="truncate">{{ user.email }}</span>
    </template>
    <template v-else>Iniciar sesión</template>
  </button>

  <Teleport to="body">
    <div
      v-if="open"
      class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/70 p-4 pt-16"
      data-account-panel
      @click.self="open = false"
    >
      <div role="dialog" aria-modal="true" aria-label="Cuenta" class="w-full max-w-sm rounded-2xl border border-zinc-700 bg-zinc-900 p-5 text-sm text-zinc-200">
        <div class="flex items-center justify-between">
          <h2 class="text-base font-semibold text-zinc-100">{{ isSignedIn ? 'Tu cuenta' : mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta' }}</h2>
          <button class="text-zinc-400 hover:text-white" aria-label="Cerrar" @click="open = false">✕</button>
        </div>

        <template v-if="isSignedIn">
          <p class="mt-3 truncate text-zinc-300">{{ user.email }}</p>
          <p class="mt-2" :class="syncStatus === 'error' ? 'text-amber-200' : 'text-zinc-400'" role="status">{{ syncLabel }}</p>
          <p v-if="skippedKeys.length" class="mt-2 text-xs text-amber-200">
            No se sincronizó por su tamaño: {{ skippedKeys.join(', ') }}.
          </p>
          <p class="mt-2 text-xs text-zinc-400">
            Tus sesiones, plan, cintura, peso y ajustes quedan asociados a esta cuenta. Las claves de servicios se quedan en este
            navegador.
          </p>
          <div class="mt-4 flex gap-2">
            <button class="rounded-lg bg-zinc-800 px-3 py-1.5 font-semibold hover:bg-zinc-700" :disabled="syncStatus === 'syncing'" @click="syncNow">
              Sincronizar ahora
            </button>
            <button class="rounded-lg border border-zinc-700 px-3 py-1.5 font-semibold hover:bg-zinc-800" @click="run(signOutUser)">
              Cerrar sesión
            </button>
          </div>
        </template>

        <template v-else>
          <p class="mt-2 text-xs text-zinc-400">
            Es opcional: la app funciona igual sin cuenta. Con ella, tus datos quedan respaldados y disponibles en tus otros equipos.
          </p>
          <button
            class="mt-4 w-full rounded-lg bg-zinc-100 px-3 py-2 font-semibold text-zinc-900 hover:bg-white disabled:opacity-50"
            :disabled="busy"
            @click="google"
          >
            Continuar con Google
          </button>
          <form class="mt-4 space-y-3" @submit.prevent="submit">
            <label class="block text-xs text-zinc-300">
              Correo
              <input v-model="form.email" type="email" required autocomplete="email" class="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100" />
            </label>
            <label class="block text-xs text-zinc-300">
              Contraseña
              <input
                v-model="form.password"
                type="password"
                required
                minlength="6"
                :autocomplete="mode === 'login' ? 'current-password' : 'new-password'"
                class="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm text-zinc-100"
              />
            </label>
            <button class="w-full rounded-lg bg-orange-500 px-3 py-2 font-semibold text-zinc-950 hover:bg-orange-400 disabled:opacity-50" :disabled="busy">
              {{ mode === 'login' ? 'Entrar' : 'Crear cuenta' }}
            </button>
          </form>
          <div class="mt-3 flex justify-between text-xs">
            <button class="text-sky-300 hover:text-sky-200" @click="mode = mode === 'login' ? 'signup' : 'login'">
              {{ mode === 'login' ? 'Crear una cuenta' : 'Ya tengo cuenta' }}
            </button>
            <button v-if="mode === 'login'" class="text-zinc-400 hover:text-zinc-200" @click="reset">Olvidé mi contraseña</button>
          </div>
        </template>

        <p v-if="message" class="mt-3 text-sm" :class="messageIsError ? 'text-amber-200' : 'text-emerald-300'" role="alert">{{ message }}</p>
      </div>
    </div>
  </Teleport>
</template>
