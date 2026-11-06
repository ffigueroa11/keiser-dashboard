import { describe, expect, it } from 'vitest'
import { createPulseFilter, zoneFor, zoneRanges } from '../src/heartZones'
import { WEEK_MINIMUM, mondayOf, weekDays, weekStatus } from '../src/training/week'

describe('createPulseFilter', () => {
  const run = (values, start = 0) => {
    const filter = createPulseFilter()
    return values.map((v, i) => filter.next(v, start + i * 1000))
  }

  it('no entrega pulso hasta tener 30 s seguidos', () => {
    const out = run(Array(32).fill(100))
    expect(out[29]).toBeNull()
    expect(out[30]).toBe(100)
  })

  it('ignora un pico aislado y acepta un cambio confirmado', () => {
    const steady = Array(31).fill(118)
    expect(run([...steady, 225, 119]).slice(-2)).toEqual([118, 119])
    expect(run([...steady, 90, 90]).slice(-2)).toEqual([118, 90])
  })

  it('un corte de 10 s reinicia la espera, uno de 9 s no', () => {
    const filter = createPulseFilter()
    for (let s = 0; s <= 30; s++) filter.next(100, s * 1000)
    expect(filter.next(100, 39000)).toBe(100)
    expect(filter.next(100, 49000)).toBeNull()
  })
})

describe('zonas de pulso', () => {
  it('la tabla coincide con el cálculo para todo pulso máximo', () => {
    for (let max = 100; max <= 230; max++) {
      for (const zone of zoneRanges(max).slice(1)) {
        expect(zoneFor(zone.lo, max).n).toBe(zone.n)
        expect(zoneFor(zone.lo - 1, max).n).toBe(zone.n - 1)
      }
    }
  })
})

describe('semana', () => {
  const friday = new Date(2026, 10, 6, 12)
  const day = (d) => new Date(2026, 10, d, 12).toISOString()

  it('la semana parte el lunes', () => {
    expect(mondayOf(friday).getDate()).toBe(2)
    expect(mondayOf(new Date(2026, 10, 8, 23)).getDate()).toBe(2)
  })

  it('cuenta un día una sola vez y muestra el fin de semana solo si se pedaleó', () => {
    const base = weekDays([day(2), new Date(2026, 10, 2, 20).toISOString()], friday)
    expect(base.filter((d) => d.done)).toHaveLength(1)
    expect(base).toHaveLength(5)
    expect(weekDays([day(7)], friday)).toHaveLength(6)
  })

  it('no cuenta días de otra semana', () => {
    expect(weekDays([day(1), day(9)], friday).filter((d) => d.done)).toHaveLength(0)
  })

  it('da el mensaje de cada estado', () => {
    expect(weekStatus(0).title).toBe('Te faltan 3 sesiones para completar el mínimo')
    expect(weekStatus(WEEK_MINIMUM - 1).title).toBe('Te falta 1 sesión para completar el mínimo')
    expect(weekStatus(WEEK_MINIMUM).tone).toBe('minimo')
    expect(weekStatus(4).title).toBe('¡Felicidades! Superaste el mínimo')
    expect(weekStatus(5).title).toBe('¡Semana completa!')
    expect(weekStatus(7).tone).toBe('completa')
  })
})
