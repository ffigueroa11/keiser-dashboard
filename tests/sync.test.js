import { describe, expect, it } from 'vitest'
import {
  META_KEY,
  SESSIONS_KEY,
  belongsToOtherUser,
  chunkSamples,
  clearSyncedData,
  hashText,
  joinSamples,
  loadMeta,
  mergeValues,
  runSync,
} from '../src/cloud/syncCore'

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i],
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    dump: () => Object.fromEntries(map),
  }
}

/** Nube falsa compartida entre equipos. */
function fakeCloud() {
  const values = new Map()
  const sessions = new Map()
  const samples = new Map()
  let clock = 1000
  return {
    values,
    sessions,
    samples,
    async getValues() {
      return [...values.entries()].map(([key, v]) => ({ key, ...v }))
    },
    async setValue(key, valor, version) {
      values.set(key, { valor, version })
    },
    async listSessions(since) {
      return [...sessions.entries()].filter(([, s]) => s.actualizado > since).map(([id, s]) => ({ id, ...s }))
    },
    async setSession(id, resumen) {
      sessions.set(id, { resumen, eliminada: false, actualizado: ++clock })
    },
    async deleteSession(id) {
      samples.delete(id)
      sessions.set(id, { eliminada: true, actualizado: ++clock })
    },
    async putSamples(id, chunks) {
      samples.set(id, chunks)
    },
  }
}

function fakeOutbox(items = []) {
  const list = [...items]
  return {
    all: async () => [...list],
    remove: async (id) => list.splice(list.findIndex((x) => x.id === id), 1),
    size: () => list.length,
  }
}

const session = (id, fecha = '2026-11-05T12:00:00Z') => ({ id, fecha, wattsPromedio: 100 })
const sync = (storage, remote, outbox = fakeOutbox(), uid = 'u1') => runSync({ storage, remote, outbox, uid })

describe('valores', () => {
  it('sube lo local y otro equipo lo recibe', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ 'keiser.plan': '{"sound":true}', 'keiser.pulsoMax': '185' })
    expect((await sync(a, cloud)).pushed).toBe(2)

    const b = memoryStorage()
    const report = await sync(b, cloud)
    expect(report.changedLocal).toBe(true)
    expect(b.getItem('keiser.pulsoMax')).toBe('185')
    expect(report.pushed).toBe(0)
  })

  it('una segunda pasada no hace nada', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ 'keiser.pulsoMax': '185', [SESSIONS_KEY]: JSON.stringify([session('1')]) })
    await sync(a, cloud)
    expect(await sync(a, cloud)).toMatchObject({ pushed: 0, changedLocal: false })
  })

  it('un cambio local se sube y el otro equipo lo adopta', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ 'keiser.pulsoMax': '185' })
    const b = memoryStorage()
    await sync(a, cloud)
    await sync(b, cloud)
    a.setItem('keiser.pulsoMax', '180')
    await sync(a, cloud)
    expect((await sync(b, cloud)).changedLocal).toBe(true)
    expect(b.getItem('keiser.pulsoMax')).toBe('180')
    expect(await sync(a, cloud)).toMatchObject({ pushed: 0, changedLocal: false })
  })

  it('nunca sube claves de servicios, cachés ni la sesión en curso', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({
      'keiser.youtubeKey': 'secreto',
      'keiser.imageryKeys': 'secreto',
      'keiser.videoPool': 'cache',
      'keiser.sesionEnCurso': 'x',
      otra: 'no',
      'keiser.plan': '{}',
    })
    await sync(a, cloud)
    expect([...cloud.values.keys()]).toEqual(['keiser.plan'])
  })

  it('no sube valores demasiado grandes y lo informa', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ 'keiser.routes': 'x'.repeat(950 * 1024) })
    expect((await sync(a, cloud)).skipped).toEqual(['keiser.routes'])
    expect(cloud.values.size).toBe(0)
  })

  it('junta los cambios simultáneos del plan y de cintura y peso', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ 'keiser.cuerpo': JSON.stringify([{ fecha: '2026-11-01', cinturaCm: 97 }]) })
    const b = memoryStorage()
    await sync(a, cloud)
    await sync(b, cloud)
    a.setItem('keiser.cuerpo', JSON.stringify([{ fecha: '2026-11-01', cinturaCm: 97 }, { fecha: '2026-11-02', cinturaCm: 96 }]))
    b.setItem('keiser.cuerpo', JSON.stringify([{ fecha: '2026-11-01', cinturaCm: 97 }, { fecha: '2026-11-03', cinturaCm: 95 }]))
    await sync(a, cloud)
    await sync(b, cloud)
    await sync(a, cloud)
    const fechas = (s) => JSON.parse(s.getItem('keiser.cuerpo')).map((e) => e.fecha)
    expect(fechas(a)).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
    expect(fechas(b)).toEqual(fechas(a))
  })

  it('mergeValues conserva sesiones del plan de ambos lados', () => {
    const local = JSON.stringify({ levels: 'L', completed: { a: 1 } })
    const remote = JSON.stringify({ levels: 'R', lastTest: 5, completed: { b: 2 } })
    expect(JSON.parse(mergeValues('keiser.plan', local, remote))).toEqual({ levels: 'L', lastTest: 5, completed: { a: 1, b: 2 } })
    expect(mergeValues('keiser.pulsoMax', '180', '190')).toBe('180')
    expect(mergeValues('keiser.plan', 'roto', remote)).toBe('roto')
  })
})

describe('sesiones', () => {
  it('une las sesiones de dos equipos, en orden', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ [SESSIONS_KEY]: JSON.stringify([session('1', '2026-11-01T12:00:00Z')]) })
    const b = memoryStorage({ [SESSIONS_KEY]: JSON.stringify([session('2', '2026-11-02T12:00:00Z')]) })
    await sync(a, cloud)
    await sync(b, cloud)
    await sync(a, cloud)
    const ids = (s) => JSON.parse(s.getItem(SESSIONS_KEY)).map((x) => x.id)
    expect(ids(a)).toEqual(['2', '1'])
    expect(ids(b)).toEqual(['2', '1'])
  })

  it('un equipo nuevo recibe todo', async () => {
    const cloud = fakeCloud()
    await sync(memoryStorage({ [SESSIONS_KEY]: JSON.stringify([session('1')]) }), cloud)
    const fresh = memoryStorage()
    expect((await sync(fresh, cloud)).changedLocal).toBe(true)
    expect(JSON.parse(fresh.getItem(SESSIONS_KEY))).toHaveLength(1)
  })

  it('borrar en un equipo la borra en la nube y en el otro, con sus muestras', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ [SESSIONS_KEY]: JSON.stringify([session('1'), session('2')]) })
    const b = memoryStorage()
    await sync(a, cloud, fakeOutbox([{ id: '1', records: [{ watts: 1 }] }]))
    await sync(b, cloud)
    a.setItem(SESSIONS_KEY, JSON.stringify([session('2')]))
    await sync(a, cloud)
    expect(cloud.samples.has('1')).toBe(false)
    expect(cloud.sessions.get('1').eliminada).toBe(true)
    await sync(b, cloud)
    expect(JSON.parse(b.getItem(SESSIONS_KEY)).map((x) => x.id)).toEqual(['2'])
    // Y no reaparece en el equipo que la borró.
    await sync(a, cloud)
    expect(JSON.parse(a.getItem(SESSIONS_KEY)).map((x) => x.id)).toEqual(['2'])
  })

  it('un historial ilegible no borra nada en la nube', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ [SESSIONS_KEY]: JSON.stringify([session('1')]) })
    await sync(a, cloud)
    a.setItem(SESSIONS_KEY, '{roto')
    await sync(a, cloud)
    expect(cloud.sessions.get('1').eliminada).toBe(false)
    expect(a.getItem(SESSIONS_KEY)).toBe('{roto')
  })

  it('una sesión actualizada al reimportarla se vuelve a subir', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ [SESSIONS_KEY]: JSON.stringify([session('1')]) })
    await sync(a, cloud)
    a.setItem(SESSIONS_KEY, JSON.stringify([{ ...session('1'), mejores: { 60: 150 } }]))
    expect((await sync(a, cloud)).pushed).toBe(1)
    expect(cloud.sessions.get('1').resumen.mejores[60]).toBe(150)
  })
})

describe('muestras', () => {
  it('sube la cola y solo entonces la vacía', async () => {
    const cloud = fakeCloud()
    const outbox = fakeOutbox([{ id: '1', records: [{ watts: 1 }, { watts: 2 }] }])
    expect((await sync(memoryStorage(), cloud, outbox)).samples).toBe(1)
    expect(outbox.size()).toBe(0)
    expect(joinSamples(cloud.samples.get('1'))).toEqual([{ watts: 1 }, { watts: 2 }])
  })

  it('si falla la red, la cola se conserva y lo avanzado queda registrado', async () => {
    const cloud = fakeCloud()
    cloud.putSamples = async () => {
      throw new Error('sin red')
    }
    const outbox = fakeOutbox([{ id: '1', records: [{ watts: 1 }] }])
    const a = memoryStorage({ 'keiser.pulsoMax': '185' })
    await expect(sync(a, cloud, outbox)).rejects.toThrow('sin red')
    expect(outbox.size()).toBe(1)
    expect(loadMeta(a).values['keiser.pulsoMax'].hash).toBe(hashText('185'))
  })

  it('divide sesiones largas en trozos que caben en un documento', () => {
    const records = Array.from({ length: 7200 }, (_, i) => ({ timestamp: '2026-11-05T12:00:00.000Z', watts: 150, rpm: 80, tiempoBici: i, marcha: 14, calorias: 300, distanciaKm: 12.34, pulso: 130, paquetes: 1000, reinicios: 0, plan: 's10-1' }))
    const chunks = chunkSamples(records)
    expect(chunks).toHaveLength(3)
    expect(Math.max(...chunks.map((c) => c.length))).toBeLessThan(1024 * 1024)
    expect(joinSamples(chunks)).toHaveLength(7200)
  })
})

describe('cambio de usuario', () => {
  it('detecta datos de otra cuenta y limpia solo lo sincronizado', async () => {
    const cloud = fakeCloud()
    const a = memoryStorage({ 'keiser.plan': '{}', 'keiser.youtubeKey': 'mia', otra: '1', [SESSIONS_KEY]: '[]' })
    expect(belongsToOtherUser(a, 'u2')).toBe(false)
    await sync(a, cloud, fakeOutbox(), 'u1')
    expect(belongsToOtherUser(a, 'u1')).toBe(false)
    expect(belongsToOtherUser(a, 'u2')).toBe(true)
    clearSyncedData(a)
    expect(a.dump()).toEqual({ 'keiser.youtubeKey': 'mia', otra: '1' })
    expect(a.getItem(META_KEY)).toBeNull()
  })
})
