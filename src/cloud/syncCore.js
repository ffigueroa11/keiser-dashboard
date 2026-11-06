/**
 * Sincronización entre el navegador y la nube. La app sigue funcionando solo con el navegador: esto
 * compara ambos lados y copia lo que cambió. No conoce Firebase: recibe `remote` (ver services.js),
 * lo que permite probarlo sin red.
 */
export const META_KEY = 'keiser.syncMeta'
export const SESSIONS_KEY = 'keiser.sessions'
const PREFIX = 'keiser.'
// No viajan: claves de servicios, cachés y estado propio de este navegador.
const LOCAL_ONLY = new Set([META_KEY, SESSIONS_KEY, 'keiser.sesionEnCurso', 'keiser.imageryKeys', 'keiser.youtubeKey', 'keiser.videoPool'])
export const MAX_VALUE_CHARS = 900 * 1024 // Firestore admite documentos de hasta 1 MiB
export const SAMPLES_PER_CHUNK = 3000

const isSyncedKey = (key) => key.startsWith(PREFIX) && !LOCAL_ONLY.has(key)

/** Huella corta para detectar cambios sin guardar una copia del valor. */
export function hashText(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) | 0
  return `${text.length}:${hash}`
}

function parse(text, fallback) {
  try {
    return JSON.parse(text) ?? fallback
  } catch {
    return fallback
  }
}

export function loadMeta(storage) {
  const meta = parse(storage.getItem(META_KEY), {})
  return { uid: null, values: {}, sessions: {}, lastPull: 0, ...meta }
}

export function saveMeta(storage, meta) {
  storage.setItem(META_KEY, JSON.stringify(meta))
}

const byKey = (list, key) => Object.fromEntries(list.map((item) => [item[key], item]))

/** Si ambos lados cambiaron, junta lo que se puede juntar; si no, gana este navegador. */
export function mergeValues(key, local, remote) {
  const a = parse(local, null)
  const b = parse(remote, null)
  if (a === null || b === null) return local
  if (key === 'keiser.cuerpo' && Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(Object.values({ ...byKey(b, 'fecha'), ...byKey(a, 'fecha') }).sort((x, y) => x.fecha.localeCompare(y.fecha)))
  }
  if (key === 'keiser.routes' && Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(Object.values({ ...byKey(b, 'id'), ...byKey(a, 'id') }))
  }
  if (key === 'keiser.plan' && typeof a === 'object' && typeof b === 'object') {
    return JSON.stringify({ ...b, ...a, completed: { ...b.completed, ...a.completed } })
  }
  if (key === 'keiser.routeResults' && typeof a === 'object' && typeof b === 'object') {
    const merged = { ...b, ...a }
    for (const route of Object.keys(b)) {
      if (a[route]) merged[route] = Object.values({ ...byKey(b[route], 'fecha'), ...byKey(a[route], 'fecha') })
    }
    return JSON.stringify(merged)
  }
  return local
}

async function syncValues(storage, remote, meta, report) {
  const remoteValues = byKey(await remote.getValues(), 'key')
  const localKeys = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (isSyncedKey(key)) localKeys.push(key)
  }
  const keys = new Set([...localKeys, ...Object.keys(remoteValues).filter(isSyncedKey)])

  for (const key of keys) {
    const local = storage.getItem(key)
    const rem = remoteValues[key]
    const known = meta.values[key]
    const localChanged = local !== null && hashText(local) !== known?.hash
    const remoteChanged = !!rem && rem.version !== known?.version
    let value = local
    let version = known?.version ?? null

    if (rem && remoteChanged && !localChanged) {
      value = rem.valor
      version = rem.version
    } else if (rem && remoteChanged && localChanged) {
      value = mergeValues(key, local, rem.valor)
      version = rem.version
      if (value !== rem.valor) version = null
    } else if (localChanged) {
      version = null // hay que subirlo
    } else {
      continue
    }

    if (value !== local) {
      storage.setItem(key, value)
      report.changedLocal = true
    }
    if (version === null) {
      if (value.length > MAX_VALUE_CHARS) {
        report.skipped.push(key)
        continue
      }
      version = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
      await remote.setValue(key, value, version)
      report.pushed++
    }
    meta.values[key] = { hash: hashText(value), version }
  }
}

async function syncSessions(storage, remote, meta, report) {
  const raw = storage.getItem(SESSIONS_KEY)
  const parsed = raw === null ? [] : parse(raw, null)
  // Con el historial ilegible no se decide nada: podría interpretarse como sesiones borradas.
  if (!Array.isArray(parsed)) return
  const local = new Map(parsed.map((s) => [s.id, s]))
  let changed = false

  for (const doc of await remote.listSessions(meta.lastPull)) {
    meta.lastPull = Math.max(meta.lastPull, doc.actualizado)
    if (doc.eliminada) {
      if (local.delete(doc.id)) changed = true
      delete meta.sessions[doc.id]
    } else if (!local.has(doc.id) && !meta.sessions[doc.id]) {
      local.set(doc.id, doc.resumen)
      meta.sessions[doc.id] = hashText(JSON.stringify(doc.resumen))
      changed = true
    }
  }

  // Lo que se conocía y ya no está aquí, se borró en este navegador.
  for (const id of Object.keys(meta.sessions)) {
    if (!local.has(id)) {
      await remote.deleteSession(id)
      delete meta.sessions[id]
      report.pushed++
    }
  }

  for (const [id, session] of local) {
    const hash = hashText(JSON.stringify(session))
    if (meta.sessions[id] !== hash) {
      await remote.setSession(id, session)
      meta.sessions[id] = hash
      report.pushed++
    }
  }

  if (changed) {
    const list = [...local.values()].sort((a, b) => Date.parse(b.fecha) - Date.parse(a.fecha))
    storage.setItem(SESSIONS_KEY, JSON.stringify(list))
    report.changedLocal = true
  }
}

/** Divide las muestras en trozos que caben en un documento de Firestore. */
export function chunkSamples(records, size = SAMPLES_PER_CHUNK) {
  const chunks = []
  for (let i = 0; i < records.length; i += size) chunks.push(JSON.stringify(records.slice(i, i + size)))
  return chunks
}

export const joinSamples = (chunks) => chunks.flatMap((chunk) => JSON.parse(chunk))

async function syncSamples(remote, outbox, report) {
  for (const { id, records } of await outbox.all()) {
    await remote.putSamples(id, chunkSamples(records))
    await outbox.remove(id)
    report.samples++
  }
}

/** Una pasada completa. Devuelve qué pasó; changedLocal indica que hay que recargar la app. */
export async function runSync({ storage, remote, outbox, uid }) {
  const meta = loadMeta(storage)
  meta.uid = uid
  const report = { changedLocal: false, pushed: 0, samples: 0, skipped: [] }
  try {
    await syncValues(storage, remote, meta, report)
    await syncSessions(storage, remote, meta, report)
    await syncSamples(remote, outbox, report)
  } finally {
    // Lo avanzado queda registrado aunque la conexión se corte a mitad de camino.
    saveMeta(storage, meta)
  }
  return report
}

/** true si lo guardado en este navegador pertenece a otro usuario. */
export function belongsToOtherUser(storage, uid) {
  const owner = loadMeta(storage).uid
  return !!owner && owner !== uid
}

/** Borra los datos sincronizados de este navegador, para que entre otro usuario. */
export function clearSyncedData(storage) {
  const keys = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (isSyncedKey(key) || key === SESSIONS_KEY || key === META_KEY) keys.push(key)
  }
  for (const key of keys) storage.removeItem(key)
}
