/**
 * Copia de seguridad de lo guardado en el navegador (historial, plan, rutas, cuerpo y ajustes).
 * Las claves de servicios no se incluyen, para que el archivo se pueda guardar sin exponerlas, y la
 * sesión en curso tiene su propia recuperación.
 */
const PREFIX = 'keiser.'
const EXCLUDED = new Set(['keiser.imageryKeys', 'keiser.youtubeKey', 'keiser.sesionEnCurso'])
const APP = 'keiser-dashboard'

export function createBackup(storage = localStorage, now = new Date()) {
  const datos = {}
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key.startsWith(PREFIX) && !EXCLUDED.has(key)) datos[key] = storage.getItem(key)
  }
  return { app: APP, version: 1, fecha: now.toISOString(), datos }
}

/** Restaura una copia. Lanza un Error con un mensaje para mostrar; devuelve las claves restauradas. */
export function restoreBackup(backup, storage = localStorage) {
  const datos = backup?.datos
  if (backup?.app !== APP || !datos || typeof datos !== 'object') {
    throw new Error('El archivo no es una copia de seguridad de esta app.')
  }
  const entries = Object.entries(datos).filter(
    ([key, value]) => key.startsWith(PREFIX) && !EXCLUDED.has(key) && typeof value === 'string',
  )
  if (!entries.length) throw new Error('La copia de seguridad está vacía.')
  for (const [key, value] of entries) storage.setItem(key, value)
  return entries.length
}
