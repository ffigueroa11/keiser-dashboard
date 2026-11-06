import { onBeforeUnmount, watch } from 'vue'

/** Mantiene la pantalla encendida mientras `active` sea true. Sin soporte, no hace nada. */
export function useWakeLock(active) {
  let lock = null

  async function acquire() {
    if (lock || !active.value || document.visibilityState !== 'visible' || !navigator.wakeLock) return
    try {
      lock = await navigator.wakeLock.request('screen')
      lock.addEventListener('release', () => (lock = null))
    } catch {
      /* el navegador puede negarlo, por ejemplo con poca batería */
    }
  }

  function release() {
    lock?.release().catch(() => {})
    lock = null
  }

  // El navegador lo suelta al ocultar la pestaña: se vuelve a pedir al regresar.
  document.addEventListener('visibilitychange', acquire)
  watch(active, (on) => (on ? acquire() : release()), { immediate: true })

  onBeforeUnmount(() => {
    document.removeEventListener('visibilitychange', acquire)
    release()
  })
}
