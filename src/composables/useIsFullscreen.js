import { onBeforeUnmount, onMounted, ref } from 'vue'

/** true mientras el elemento de `target` (un ref) está en pantalla completa. */
export function useIsFullscreen(target) {
  const isFullscreen = ref(false)
  const update = () => {
    isFullscreen.value = !!target.value && document.fullscreenElement === target.value
  }
  onMounted(() => document.addEventListener('fullscreenchange', update))
  onBeforeUnmount(() => document.removeEventListener('fullscreenchange', update))
  return isFullscreen
}
