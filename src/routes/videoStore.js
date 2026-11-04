/**
 * Videos de las rutas. Los archivos no se copian al navegador (pueden pesar varios GB): se guarda
 * una referencia al archivo en IndexedDB, y Chrome pide permiso para volver a abrirlo.
 * Los ajustes de sincronización de cada ruta van en localStorage.
 */

const DB_NAME = 'keiser-video'
const STORE = 'handles'
const SETTINGS_KEY = 'keiser.videoSync'

// Archivos ya abiertos en esta visita: cambiar de vista no vuelve a pedirlos.
const session = new Map()

function withStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1)
    open.onupgradeneeded = () => open.result.createObjectStore(STORE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction(STORE, mode)
      const req = fn(tx.objectStore(STORE))
      tx.oncomplete = () => {
        db.close()
        resolve(req?.result)
      }
      tx.onerror = tx.onabort = () => {
        db.close()
        reject(tx.error)
      }
    }
  })
}

export const sessionVideo = (routeId) => session.get(routeId) ?? null
export const rememberSessionVideo = (routeId, file) => session.set(routeId, file)

export async function loadHandle(routeId) {
  try {
    return (await withStore('readonly', (s) => s.get(routeId))) ?? null
  } catch {
    return null
  }
}

export async function saveHandle(routeId, handle) {
  try {
    await withStore('readwrite', (s) => s.put(handle, routeId))
  } catch {
    /* sin IndexedDB: habrá que volver a elegir el video en la próxima visita */
  }
}

export function forgetVideo(routeId) {
  session.delete(routeId)
  withStore('readwrite', (s) => s.delete(routeId)).catch(() => {})
  const all = readSettings()
  delete all[routeId]
  writeSettings(all)
}

function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
  } catch {
    return {}
  }
}

function writeSettings(all) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(all))
  } catch {
    /* sin almacenamiento: los ajustes duran solo esta visita */
  }
}

/** { offset: segundos que se suman al tiempo del GPX, useTimes: usar los tiempos del GPX } */
export function loadVideoSync(routeId) {
  const s = readSettings()[routeId] ?? {}
  return { offset: Number(s.offset) || 0, useTimes: s.useTimes !== false }
}

export function saveVideoSync(routeId, sync) {
  writeSettings({ ...readSettings(), [routeId]: { offset: sync.offset, useTimes: sync.useTimes } })
}
