/**
 * Temporizador que sigue a tiempo con la pestaña en segundo plano: el navegador frena setInterval en
 * las páginas ocultas, pero no en un Worker. Sin Worker disponible usa setInterval. Devuelve stop().
 */
export function createTicker(callback, ms) {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    const id = setInterval(callback, ms)
    return () => clearInterval(id)
  }
  try {
    const url = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${ms})`], { type: 'text/javascript' }))
    const worker = new Worker(url)
    URL.revokeObjectURL(url)
    worker.onmessage = () => callback()
    return () => worker.terminate()
  } catch {
    const id = setInterval(callback, ms)
    return () => clearInterval(id)
  }
}
