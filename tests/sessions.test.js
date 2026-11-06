import { beforeEach, describe, expect, it } from 'vitest'
import { buildSeries, buildSummary, isSessionData, withoutFalsePulse } from '../src/composables/useSession'
import { analyzeSession, bestEfforts, bestMarks, efficiencyOf, marksOf, weeklySummaries } from '../src/sessions/analysis'
import { sessionToTcx, tcxFileName } from '../src/sessions/tcx'
import { createBackup, restoreBackup } from '../src/sessions/backup'
import { addBodyEntry, bodyChange, bodyLog, removeBodyEntry } from '../src/sessions/bodyLog'

const START = Date.parse('2026-11-05T12:00:00Z')

function records(count, fn = () => ({})) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(START + i * 1000).toISOString(),
    watts: 100,
    rpm: 70,
    ...fn(i),
  }))
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    get length() {
      return map.size
    },
    key: (i) => [...map.keys()][i],
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, v),
  }
}

describe('resumen de sesión', () => {
  it('toma tiempo, kcal y km de la consola', () => {
    const data = records(600, (i) => ({ tiempoBici: 900 + i, calorias: 50 + i, distanciaKm: 5 + i / 100 }))
    expect(buildSummary(data, START, 600, 'x.json')).toMatchObject({ duracionSeg: 1499, calorias: 649, distanciaKm: 10.99, muestras: 600 })
  })

  it('guarda marcas, sesión del plan y datos de señal', () => {
    const data = records(400, (i) => ({ watts: i >= 100 && i < 400 ? 200 : 100, plan: 's1-1', paquetes: 10 + i, reinicios: i > 200 ? 2 : 0 }))
    const summary = buildSummary(data, START, 400, 'x.json')
    expect(summary.mejores).toEqual({ 60: 200, 300: 200, 1200: null })
    expect(summary.plan).toBe('s1-1')
    expect(summary.senal).toEqual({ paquetes: 399, reinicios: 2 })
  })

  it('reduce la serie sin perder el pulso', () => {
    const serie = buildSeries(records(1200, () => ({ pulso: 120 })))
    expect(serie.paso).toBe(4)
    expect(serie.pulso).toHaveLength(300)
    expect(serie.pulso[0]).toBe(120)
  })

  it('limpia lecturas falsas de pulso del arranque', () => {
    const data = records(100, (i) => (i < 3 ? { pulso: 32 } : i < 40 ? {} : { pulso: 105 }))
    const clean = withoutFalsePulse(data)
    expect(clean.slice(0, 3).every((r) => r.pulso === undefined)).toBe(true)
    expect(clean.filter((r) => r.pulso !== undefined).every((r) => r.pulso === 105)).toBe(true)
  })

  it('valida archivos de sesión', () => {
    expect(isSessionData(records(2))).toBe(true)
    expect(isSessionData([])).toBe(false)
    expect(isSessionData({ a: 1 })).toBe(false)
    expect(isSessionData([{ timestamp: 'no', watts: 1, rpm: 1 }])).toBe(false)
  })
})

describe('análisis', () => {
  it('calcula la mejor ventana de potencia', () => {
    const data = records(120, (i) => ({ watts: i < 60 ? 100 : 180 }))
    expect(bestEfforts(data)[60]).toBe(180)
    expect(bestEfforts(data)[300]).toBeNull()
  })

  const ride = (over) => ({
    id: over.fecha,
    duracionSeg: 1800,
    muestras: 1800,
    wattsPromedio: 100,
    rpmPromedio: 60,
    pulsoPromedio: 110,
    calorias: 200,
    distanciaKm: 12,
    serie: { paso: 6, watts: Array(300).fill(100), rpm: Array(300).fill(60), pulso: Array(300).fill(110), marcha: [] },
    ...over,
  })

  it('aproxima marcas de sesiones antiguas con su serie', () => {
    expect(marksOf(ride({ fecha: '2026-11-01T12:00:00Z' }))[300]).toBe(100)
  })

  it('elige la mejor marca entre sesiones', () => {
    const list = [ride({ fecha: '2026-11-01T12:00:00Z', mejores: { 60: 150, 300: 120, 1200: 100 } }), ride({ fecha: '2026-11-02T12:00:00Z', mejores: { 60: 140, 300: 130, 1200: null } })]
    const best = bestMarks(list)
    expect(best[60].value).toBe(150)
    expect(best[300].value).toBe(130)
    expect(best[1200].value).toBe(100)
  })

  it('calcula vatios por latido', () => {
    expect(efficiencyOf({ wattsPromedio: 91, pulsoPromedio: 105 })).toBe(0.87)
    expect(efficiencyOf({ wattsPromedio: 91, pulsoPromedio: null })).toBeNull()
  })

  it('describe la sesión y detecta marcas nuevas', () => {
    const older = ride({ fecha: '2026-11-01T12:00:00Z', mejores: { 60: 110, 300: 105, 1200: 100 } })
    const session = ride({ fecha: '2026-11-02T12:00:00Z', wattsPromedio: 110, mejores: { 60: 120, 300: 115, 1200: 110 }, senal: { paquetes: 700, reinicios: 2 } })
    const notes = analyzeSession(session, [older, session]).join(' ')
    expect(notes).toContain('Cadencia promedio 60 rpm')
    expect(notes).toContain('Nueva mejor marca de 20 min: 110 W')
    expect(notes).toContain('10 W más que tu última sesión')
    expect(notes).toContain('estable')
    expect(notes).toContain('se reinició 2 veces')
  })

  it('avisa si se grabó menos que el tiempo de la consola', () => {
    const notes = analyzeSession(ride({ fecha: '2026-11-02T12:00:00Z', duracionSeg: 2394, muestras: 1525 }), [])
    expect(notes[0]).toContain('25 de 40 min')
  })

  it('resume las semanas contando sesiones de 15 min o más', () => {
    const now = new Date(2026, 10, 6, 12)
    const list = [
      ride({ fecha: new Date(2026, 10, 4, 12).toISOString() }),
      ride({ fecha: new Date(2026, 10, 5, 12).toISOString() }),
      ride({ fecha: new Date(2026, 10, 6, 8).toISOString(), muestras: 300 }),
      ride({ fecha: new Date(2026, 9, 28, 12).toISOString() }),
    ]
    const weeks = weeklySummaries(list, [new Date(2026, 10, 6, 9).toISOString()], now)
    expect(weeks).toHaveLength(8)
    expect(weeks[7]).toMatchObject({ dias: 3, sesiones: 2, minutos: 60, kcal: 400, km: 24, estado: 'Mínimo' })
    expect(weeks[6]).toMatchObject({ dias: 1, estado: 'Bajo el mínimo' })
  })
})

describe('TCX', () => {
  it('genera actividad con potencia, cadencia, pulso y distancia desde el inicio de la grabación', () => {
    const xml = sessionToTcx(records(3, (i) => ({ distanciaKm: 10 + i / 100, calorias: 50 + i, pulso: 100 + i })))
    expect(xml).toContain('<Activity Sport="Biking">')
    expect(xml).toContain('<TotalTimeSeconds>2</TotalTimeSeconds>')
    expect(xml).toContain('<DistanceMeters>20</DistanceMeters>')
    expect(xml).toContain('<Calories>2</Calories>')
    expect(xml).toContain('<MaximumHeartRateBpm><Value>102</Value></MaximumHeartRateBpm>')
    expect(xml).toContain('<ns3:Watts>100</ns3:Watts>')
    expect(xml).toContain('<Cadence>70</Cadence>')
    expect(xml.match(/<Trackpoint>/g)).toHaveLength(3)
  })

  it('funciona con archivos antiguos sin distancia ni pulso', () => {
    const xml = sessionToTcx(records(2))
    expect(xml).toContain('<DistanceMeters>0</DistanceMeters>')
    expect(xml).not.toContain('HeartRateBpm')
  })

  it('nombra el archivo', () => {
    expect(tcxFileName('sesion-keiser-20261106-0835.json')).toBe('sesion-keiser-20261106-0835.tcx')
  })
})

describe('copia de seguridad', () => {
  it('incluye los datos y excluye claves y sesión en curso', () => {
    const storage = memoryStorage({
      'keiser.sessions': '[1]',
      'keiser.plan': '{}',
      'keiser.youtubeKey': 'secreto',
      'keiser.imageryKeys': 'secreto',
      'keiser.sesionEnCurso': 'x',
      otra: 'no',
    })
    const backup = createBackup(storage)
    expect(Object.keys(backup.datos).sort()).toEqual(['keiser.plan', 'keiser.sessions'])
    expect(JSON.stringify(backup)).not.toContain('secreto')
  })

  it('restaura y mantiene lo que la copia no trae', () => {
    const target = memoryStorage({ 'keiser.youtubeKey': 'mia' })
    const count = restoreBackup({ app: 'keiser-dashboard', datos: { 'keiser.plan': '{"a":1}', 'keiser.youtubeKey': 'ajena', otra: 'x' } }, target)
    expect(count).toBe(1)
    expect(target.getItem('keiser.plan')).toBe('{"a":1}')
    expect(target.getItem('keiser.youtubeKey')).toBe('mia')
    expect(target.getItem('otra')).toBeNull()
  })

  it('rechaza otros archivos', () => {
    expect(() => restoreBackup([{ watts: 1 }], memoryStorage())).toThrow('no es una copia')
    expect(() => restoreBackup({ app: 'keiser-dashboard', datos: {} }, memoryStorage())).toThrow('vacía')
  })
})

describe('cintura y peso', () => {
  beforeEach(() => {
    bodyLog.value = []
  })

  it('guarda, reemplaza por fecha y ordena', () => {
    expect(addBodyEntry({ fecha: '2026-11-08', cinturaCm: '95', pesoKg: '' })).toBe('')
    expect(addBodyEntry({ fecha: '2026-11-01', cinturaCm: 97.5, pesoKg: 88 })).toBe('')
    expect(addBodyEntry({ fecha: '2026-11-08', cinturaCm: 94, pesoKg: 87 })).toBe('')
    expect(bodyLog.value.map((e) => e.fecha)).toEqual(['2026-11-01', '2026-11-08'])
    expect(bodyChange(bodyLog.value, 'cinturaCm')).toBe(-3.5)
    removeBodyEntry('2026-11-01')
    expect(bodyChange(bodyLog.value, 'cinturaCm')).toBeNull()
  })

  it('rechaza datos imposibles', () => {
    expect(addBodyEntry({ fecha: '', cinturaCm: 90, pesoKg: 80 })).toContain('fecha')
    expect(addBodyEntry({ fecha: '2026-11-01', cinturaCm: '', pesoKg: '' })).toContain('Ingresa')
    expect(addBodyEntry({ fecha: '2026-11-01', cinturaCm: 5, pesoKg: 80 })).toContain('cintura')
    expect(addBodyEntry({ fecha: '2026-11-01', cinturaCm: 90, pesoKg: 900 })).toContain('peso')
    expect(bodyLog.value).toHaveLength(0)
  })
})
