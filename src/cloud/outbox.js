import { isCloudConfigured } from './config'

/** Muestras por subir a la nube. Viven en IndexedDB hasta lograrlo, aunque no haya conexión. */
const DB_NAME = 'keiser-nube'
const STORE = 'muestras'

function open() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function run(mode, action) {
  const db = await open()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    tx.oncomplete = () => {
      db.close()
      resolve(request.result)
    }
    tx.onerror = () => reject(tx.error)
  })
}

export const outbox = {
  all: () => run('readonly', (store) => store.getAll()),
  remove: (id) => run('readwrite', (store) => store.delete(id)),
}

/** Deja una sesión lista para subir. Un error aquí no debe afectar la grabación. */
export async function queueSamples(id, records) {
  if (!isCloudConfigured) return
  try {
    // Los registros de la grabación son reactivos: IndexedDB necesita objetos simples.
    await run('readwrite', (store) => store.put({ id, records: JSON.parse(JSON.stringify(records)) }))
  } catch (err) {
    console.warn('[Nube] no se pudo dejar la sesión en cola:', err)
  }
}
