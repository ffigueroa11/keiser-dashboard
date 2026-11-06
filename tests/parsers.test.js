import { describe, expect, it } from 'vitest'
import { parseKeiserAdvertisement } from '../src/composables/useBike'
import { parseHeartRate } from '../src/composables/useHeartRate'

function keiserPacket({ type = 0, rpm = 70, hr = 0, watts = 150, kcal = 20, min = 1, sec = 5, km = 2.5, gear = 10, companyId = false }) {
  const bytes = new Uint8Array(17)
  const d = new DataView(bytes.buffer)
  bytes[0] = 6
  bytes[1] = 30
  bytes[2] = type
  bytes[3] = 1
  d.setUint16(4, rpm * 10, true)
  d.setUint16(6, hr * 10, true)
  d.setUint16(8, watts, true)
  d.setUint16(10, kcal, true)
  bytes[12] = min
  bytes[13] = sec
  d.setUint16(14, 0x8000 | Math.round(km * 10), true)
  bytes[16] = gear
  return companyId ? new DataView(new Uint8Array([0x02, 0x01, ...bytes]).buffer) : d
}

describe('parseKeiserAdvertisement', () => {
  it('lee todos los campos en tiempo real', () => {
    expect(parseKeiserAdvertisement(keiserPacket({ hr: 120 }))).toMatchObject({
      realtime: true,
      rpm: 70,
      heartRate: 120,
      watts: 150,
      calories: 20,
      consoleSeconds: 65,
      distanceKm: 2.5,
      gear: 10,
    })
  })

  it('descarta el Company ID si viene delante', () => {
    expect(parseKeiserAdvertisement(keiserPacket({ companyId: true })).watts).toBe(150)
  })

  it('reconoce los paquetes de resumen', () => {
    expect(parseKeiserAdvertisement(keiserPacket({ type: 130 })).realtime).toBe(false)
  })

  it('convierte millas a kilómetros', () => {
    const packet = keiserPacket({})
    packet.setUint16(14, 100, true)
    expect(parseKeiserAdvertisement(packet).distanceKm).toBeCloseTo(16.09, 2)
  })

  it('rechaza paquetes demasiado cortos', () => {
    expect(parseKeiserAdvertisement(new DataView(new ArrayBuffer(5)))).toBeNull()
  })
})

describe('parseHeartRate', () => {
  it('lee pulso de 8 y de 16 bits', () => {
    expect(parseHeartRate(new DataView(new Uint8Array([0, 110]).buffer)).bpm).toBe(110)
    expect(parseHeartRate(new DataView(new Uint8Array([1, 44, 1]).buffer)).bpm).toBe(300)
  })

  it('informa contacto con la piel solo si el sensor lo envía', () => {
    expect(parseHeartRate(new DataView(new Uint8Array([0, 90]).buffer)).contact).toBeNull()
    expect(parseHeartRate(new DataView(new Uint8Array([4, 90]).buffer)).contact).toBe(false)
    expect(parseHeartRate(new DataView(new Uint8Array([6, 90]).buffer)).contact).toBe(true)
  })
})
