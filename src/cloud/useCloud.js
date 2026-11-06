import { computed, ref } from 'vue'
import { isCloudConfigured } from './config'
import { outbox } from './outbox'
import { belongsToOtherUser, clearSyncedData, runSync } from './syncCore'
import { downloadText } from '../utils/download'

/** Sesión del usuario y sincronización. Es un estado único de la app. */
const SYNC_EVERY_MS = 5 * 60 * 1000
const DEBOUNCE_MS = 5000

const ERRORS = {
  'auth/invalid-credential': 'Correo o contraseña incorrectos.',
  'auth/invalid-email': 'El correo no es válido.',
  'auth/email-already-in-use': 'Ese correo ya tiene una cuenta. Inicia sesión.',
  'auth/weak-password': 'La contraseña debe tener al menos 6 caracteres.',
  'auth/too-many-requests': 'Demasiados intentos. Espera un momento y reintenta.',
  'auth/popup-closed-by-user': 'Se cerró la ventana de Google antes de terminar.',
  'auth/popup-blocked': 'El navegador bloqueó la ventana de Google. Permítela e inténtalo de nuevo.',
  'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase (Authentication → Settings → Authorized domains).',
  'auth/network-request-failed': 'No hay conexión. Inténtalo cuando vuelva internet.',
  'permission-denied': 'Firestore rechazó el acceso: revisa las reglas de seguridad del proyecto.',
  unavailable: 'No hay conexión con la nube. Se reintentará solo.',
}
export const friendlyError = (err) => ERRORS[err?.code] ?? `No se pudo completar la operación (${err?.code || err?.message || err}).`

export const cloudConfigured = isCloudConfigured
export const user = ref(null)
export const authReady = ref(!isCloudConfigured)
export const syncStatus = ref('idle') // idle | syncing | ok | error
export const syncError = ref('')
export const lastSyncAt = ref(null)
export const skippedKeys = ref([])
export const isSignedIn = computed(() => user.value !== null)

let services = null
let isBusy = () => false
let debounce = 0
let running = false
let again = false

const loadServices = async () => (services ??= await import('./services'))

export async function syncNow() {
  if (!user.value) return
  // Durante una grabación no se toca lo guardado: al terminar, la app escribe su propia copia.
  if (isBusy()) return
  if (running) {
    again = true
    return
  }
  running = true
  syncStatus.value = 'syncing'
  syncError.value = ''
  try {
    const svc = await loadServices()
    const report = await runSync({ storage: localStorage, remote: svc.remoteFor(user.value.uid), outbox, uid: user.value.uid })
    skippedKeys.value = report.skipped
    lastSyncAt.value = new Date()
    syncStatus.value = 'ok'
    // Las secciones de la app leyeron lo guardado al abrir: recargar es lo más simple y seguro.
    if (report.changedLocal) location.reload()
  } catch (err) {
    console.warn('[Nube] sincronización fallida:', err)
    syncStatus.value = 'error'
    syncError.value = friendlyError(err)
  } finally {
    running = false
    if (again) {
      again = false
      scheduleSync()
    }
  }
}

export function scheduleSync() {
  clearTimeout(debounce)
  debounce = setTimeout(syncNow, DEBOUNCE_MS)
}

/** Conecta la sesión. Se llama una vez, desde App. busy(): true mientras se está grabando. */
export async function connectCloud({ busy }) {
  isBusy = busy
  if (!isCloudConfigured) return
  let svc
  try {
    svc = await loadServices()
  } catch (err) {
    // Sin conexión y sin copia guardada: la app sigue funcionando, solo que sin cuenta por ahora.
    console.warn('[Nube] no se pudo cargar:', err)
    return
  }
  svc.onUserChanged(async (account) => {
    if (account && belongsToOtherUser(localStorage, account.uid)) {
      const replace = confirm(
        'Este navegador tiene datos de otro usuario. ¿Borrarlos de aquí para entrar con esta cuenta? Lo que ya estaba sincronizado sigue en la cuenta anterior.',
      )
      if (!replace) {
        await svc.logOut()
        return
      }
      clearSyncedData(localStorage)
    }
    user.value = account
    authReady.value = true
    if (account) syncNow()
  })
  setInterval(syncNow, SYNC_EVERY_MS)
  window.addEventListener('online', syncNow)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncNow()
  })
}

// Cada acción devuelve un mensaje de error para mostrar, o '' si salió bien.
async function attempt(action) {
  try {
    await action(await loadServices())
    return ''
  } catch (err) {
    return friendlyError(err)
  }
}
export const signInWithGoogle = () => attempt((svc) => svc.signInGoogle())
export const signInWithEmail = (email, password) => attempt((svc) => svc.signInEmail(email, password))
export const signUpWithEmail = (email, password) => attempt((svc) => svc.signUpEmail(email, password))
export const sendReset = (email) => attempt((svc) => svc.resetPassword(email))
export const signOutUser = () => attempt((svc) => svc.logOut())

/** Baja desde la nube las muestras completas de una sesión. Devuelve un error, o ''. */
export async function downloadSessionFromCloud(session) {
  if (!user.value) return 'Inicia sesión para descargarla.'
  try {
    const svc = await loadServices()
    const records = await svc.remoteFor(user.value.uid).getSamples(session.id)
    if (!records.length) return 'Esta sesión aún no tiene sus muestras en la nube.'
    downloadText(JSON.stringify(records), session.archivo || `sesion-keiser-${session.id}.json`)
    return ''
  } catch (err) {
    return friendlyError(err)
  }
}
