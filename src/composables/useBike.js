import { ref, reactive, computed, onBeforeUnmount } from 'vue'

// UUIDs estándar Bluetooth SIG
const CYCLING_POWER_SERVICE = 0x1818
const CYCLING_POWER_MEASUREMENT = 0x2a63
const CSC_SERVICE = 0x1816
const CSC_MEASUREMENT = 0x2a5b
const FTMS_SERVICE = 0x1826
const INDOOR_BIKE_DATA = 0x2ad2
// Las Keiser M Series no aceptan conexiones GATT: transmiten sus datos en anuncios BLE
// con "manufacturer data" bajo este Company ID.
const KEISER_COMPANY_ID = 0x0102
const KEISER_NAME = /^(M3|Keiser)/i

// Si no llegan datos en este tiempo, se asume que el usuario dejó de pedalear.
const STALE_MS = 3000
// Con anuncios BLE, Windows recibe un paquete cada ~2 s con huecos de hasta ~6 s, y la Keiser
// ya informa 0 rpm al dejar de pedalear: se mantiene el último valor y solo se pone a 0 si la
// señal se pierde de verdad.
const BROADCAST_STALE_MS = 15000
// Sin paquetes durante este tiempo se reinicia la escucha de anuncios (ver listenToBroadcast). Debe
// superar los huecos normales: reiniciar durante uno de ellos corta la recepción sin necesidad.
const RESTART_AFTER_MS = 8000

/**
 * Calcula RPM a partir de "Cumulative Crank Revolutions" (uint16) y
 * "Last Crank Event Time" (uint16, unidades de 1/1024 s), manejando el desborde.
 */
export function createCadenceCalculator() {
  let prev = null
  let lastRpm = 0
  let lastChangeAt = 0

  return function update(revs, eventTime, now = Date.now()) {
    if (!prev) {
      prev = { revs, eventTime }
      lastChangeAt = now
      return 0
    }
    const dRevs = (revs - prev.revs + 0x10000) % 0x10000
    const dTime = (eventTime - prev.eventTime + 0x10000) % 0x10000

    if (dRevs === 0 || dTime === 0) {
      // La bici repite la última medición mientras no hay un nuevo evento de biela.
      if (now - lastChangeAt > STALE_MS) lastRpm = 0
      return lastRpm
    }

    prev = { revs, eventTime }
    lastChangeAt = now
    lastRpm = Math.round((dRevs * 60 * 1024) / dTime)
    return lastRpm
  }
}

/** Cycling Power Measurement (0x2A63) → { watts, crank? } */
export function parseCyclingPower(dv) {
  const flags = dv.getUint16(0, true)
  const watts = dv.getInt16(2, true)
  let offset = 4
  if (flags & 0x0001) offset += 1 // Pedal Power Balance
  if (flags & 0x0004) offset += 2 // Accumulated Torque
  if (flags & 0x0010) offset += 6 // Wheel Revolution Data
  let crank = null
  if (flags & 0x0020 && dv.byteLength >= offset + 4) {
    crank = { revs: dv.getUint16(offset, true), eventTime: dv.getUint16(offset + 2, true) }
  }
  return { watts: Math.max(0, watts), crank }
}

/** CSC Measurement (0x2A5B) → { crank? } */
export function parseCsc(dv) {
  const flags = dv.getUint8(0)
  let offset = 1
  if (flags & 0x01) offset += 6 // Wheel Revolution Data
  if (flags & 0x02 && dv.byteLength >= offset + 4) {
    return { crank: { revs: dv.getUint16(offset, true), eventTime: dv.getUint16(offset + 2, true) } }
  }
  return { crank: null }
}

/** FTMS Indoor Bike Data (0x2AD2) → { watts?, rpm? } */
export function parseIndoorBikeData(dv) {
  const flags = dv.getUint16(0, true)
  let offset = 2
  const out = {}
  if (!(flags & 0x0001)) offset += 2 // Instantaneous Speed (presente si "More Data" = 0)
  if (flags & 0x0002) offset += 2 // Average Speed
  if (flags & 0x0004) {
    out.rpm = Math.round(dv.getUint16(offset, true) / 2) // resolución 0.5 rpm
    offset += 2
  }
  if (flags & 0x0008) offset += 2 // Average Cadence
  if (flags & 0x0010) offset += 3 // Total Distance
  if (flags & 0x0020) offset += 2 // Resistance Level
  if (flags & 0x0040) out.watts = Math.max(0, dv.getInt16(offset, true))
  return out
}

/**
 * Anuncio BLE de Keiser M Series (manufacturer data, sin el Company ID):
 * [0] versión mayor, [1] versión menor, [2] tipo de dato (0 = tiempo real, 128-227 = resumen),
 * [3] ID de equipo, [4-5] cadencia (0.1 rpm), [6-7] pulso (0.1 bpm), [8-9] potencia (W),
 * [10-11] calorías, [12] minutos, [13] segundos (tiempo de la consola),
 * [14-15] distancia en décimas (bit 15: 1 = km, 0 = millas), [16] marcha 1-24 (firmware 6.30+).
 * Algunos navegadores entregan los bytes con el Company ID (02 01) delante; se descarta si aparece.
 */
export function parseKeiserAdvertisement(dv) {
  let o = 0
  if (dv.byteLength >= 2 && dv.getUint8(0) === 0x02 && dv.getUint8(1) === 0x01) o = 2
  if (dv.byteLength < o + 10) return null
  const dataType = dv.getUint8(o + 2)
  return {
    version: `${dv.getUint8(o)}.${dv.getUint8(o + 1)}`,
    realtime: dataType < 128,
    equipmentId: dv.getUint8(o + 3),
    rpm: Math.round(dv.getUint16(o + 4, true) / 10),
    watts: dv.getUint16(o + 8, true),
    calories: dv.getUint16(o + 10, true),
    consoleSeconds: dv.byteLength >= o + 14 ? dv.getUint8(o + 12) * 60 + dv.getUint8(o + 13) : null,
    distanceKm: dv.byteLength >= o + 16 ? keiserDistanceKm(dv.getUint16(o + 14, true)) : null,
    gear: dv.byteLength >= o + 17 ? dv.getUint8(o + 16) : null,
  }
}

function keiserDistanceKm(raw) {
  const value = (raw & 0x7fff) / 10
  const km = raw & 0x8000 ? value : value * 1.609344
  return Math.round(km * 100) / 100
}

const toHex = (dv) =>
  Array.from(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength), (b) => b.toString(16).padStart(2, '0')).join(' ')

function friendlyBluetoothError(err) {
  switch (err?.name) {
    case 'AdvertisementsUnsupported':
      return 'La Keiser M3i no acepta conexiones: transmite sus datos por anuncios BLE, y este navegador no permite leerlos todavía. Abre chrome://flags (o edge://flags), activa "Experimental Web Platform features" y "Use the new permissions backend for Web Bluetooth", reinicia el navegador y vuelve a conectar.' +
        (err.message ? ` (Detalle: ${err.message})` : '')
    case 'NotFoundError':
      return 'Emparejamiento cancelado o no se encontró ninguna bicicleta compatible. Verifica que la Keiser esté encendida (pedalea para despertarla) y vuelve a intentarlo.'
    case 'SecurityError':
      return 'El navegador bloqueó Bluetooth. La app debe abrirse desde http://localhost o https://.'
    case 'NotAllowedError':
      return 'Permiso de Bluetooth denegado. Revisa los permisos del sitio en el navegador.'
    case 'NetworkError':
      return 'No se pudo establecer la conexión GATT. Acércate a la bicicleta y reintenta.'
    case 'NotSupportedError':
      return 'El dispositivo no expone las características requeridas (Cycling Power / CSC / FTMS).'
    default:
      return `Error de Bluetooth: ${err?.message || err}`
  }
}

export function useBike() {
  const watts = ref(0)
  const rpm = ref(0)
  /** 'idle' | 'connecting' | 'bluetooth' | 'simulator' */
  const mode = ref('idle')
  const deviceName = ref('')
  const sources = ref([])
  const error = ref('')
  // Último anuncio Keiser en hexadecimal, útil para verificar el formato con la bici real.
  const rawPacket = ref('')
  // Tiempo que marca la consola Keiser (solo en modo anuncios BLE).
  const consoleSeconds = ref(null)
  // Datos acumulados de la consola y marcha (resistencia); null si la fuente no los envía.
  const gear = ref(null)
  const calories = ref(null)
  const distanceKm = ref(null)

  const isBluetoothSupported = typeof navigator !== 'undefined' && !!navigator.bluetooth
  const isLive = computed(() => mode.value === 'bluetooth' || mode.value === 'simulator')

  let device = null
  let simTimer = null
  let staleTimer = null
  let lastDataAt = 0
  let stopBroadcast = null
  let noDataTimer = null
  let healthTimer = null
  let lastPacketAt = 0 // último anuncio (o último reinicio de la escucha)
  const subscriptions = []
  // Diagnóstico de la señal de la bici (modo anuncios BLE).
  const bleStats = reactive({ packets: 0, restarts: 0, lastPacketAt: 0, silentSec: null })

  function markData() {
    lastDataAt = Date.now()
  }

  function startStaleWatchdog(staleMs) {
    clearInterval(staleTimer)
    staleTimer = setInterval(() => {
      if (mode.value === 'bluetooth' && Date.now() - lastDataAt > staleMs) {
        watts.value = 0
        rpm.value = 0
      }
    }, 1000)
  }

  async function subscribe(server, serviceUuid, charUuid, handler) {
    let service
    try {
      service = await server.getPrimaryService(serviceUuid)
    } catch {
      return false // el servicio no existe en este dispositivo
    }
    const characteristic = await service.getCharacteristic(charUuid)
    const listener = (e) => {
      markData()
      handler(e.target.value)
    }
    characteristic.addEventListener('characteristicvaluechanged', listener)
    await characteristic.startNotifications()
    subscriptions.push({ characteristic, listener })
    return true
  }

  async function listenToBroadcast(dev) {
    if (typeof dev.watchAdvertisements !== 'function') {
      throw Object.assign(new Error(''), { name: 'AdvertisementsUnsupported' })
    }
    const handler = (event) => {
      const dv = event.manufacturerData?.get(KEISER_COMPANY_ID)
      if (!dv) return
      lastPacketAt = Date.now()
      bleStats.lastPacketAt = lastPacketAt
      bleStats.packets++
      rawPacket.value = toHex(dv)
      const d = parseKeiserAdvertisement(dv)
      // Fuera de tiempo real (resumen post-sesión) no se marca dato: el watchdog lleva a 0.
      if (!d || !d.realtime) return
      markData()
      watts.value = d.watts
      rpm.value = d.rpm
      consoleSeconds.value = d.consoleSeconds
      calories.value = d.calories
      distanceKm.value = d.distanceKm
      gear.value = d.gear
    }
    let abort = null
    const startWatch = async () => {
      abort?.abort()
      abort = new AbortController()
      await dev.watchAdvertisements({ signal: abort.signal })
    }
    dev.addEventListener('advertisementreceived', handler)
    try {
      await startWatch()
    } catch (err) {
      dev.removeEventListener('advertisementreceived', handler)
      throw Object.assign(new Error(err?.message || String(err)), { name: 'AdvertisementsUnsupported' })
    }
    lastPacketAt = Date.now()

    // Algunos sistemas (por ejemplo Chrome en macOS) dejan de entregar anuncios al rato aunque la
    // bici siga emitiendo: si pasan RESTART_AFTER_MS sin paquetes, se reinicia la escucha.
    let restarting = false
    const restart = async () => {
      if (restarting || !stopBroadcast) return
      restarting = true
      try {
        abort?.abort()
        await new Promise((r) => setTimeout(r, 300))
        await startWatch()
        bleStats.restarts++
        console.info('[BLE] escucha de anuncios reiniciada')
      } catch (err) {
        console.warn('[BLE] no se pudo reiniciar la escucha:', err)
      } finally {
        restarting = false
        lastPacketAt = Date.now() // espera otro intervalo antes de reintentar
      }
    }
    clearInterval(healthTimer)
    healthTimer = setInterval(() => {
      bleStats.silentSec = bleStats.lastPacketAt ? Math.floor((Date.now() - bleStats.lastPacketAt) / 1000) : null
      if (Date.now() - lastPacketAt > RESTART_AFTER_MS) restart()
    }, 1000)
    // Al volver a la pestaña, Chrome puede haber pausado la escucha: se reanuda de inmediato.
    const onVisible = () => {
      if (document.visibilityState === 'visible') restart()
    }
    document.addEventListener('visibilitychange', onVisible)

    stopBroadcast = () => {
      clearInterval(healthTimer)
      document.removeEventListener('visibilitychange', onVisible)
      dev.removeEventListener('advertisementreceived', handler)
      abort?.abort()
      stopBroadcast = null
    }
    sources.value = ['Keiser M Series (anuncios BLE)']

    clearTimeout(noDataTimer)
    noDataTimer = setTimeout(() => {
      if (mode.value === 'bluetooth' && !rawPacket.value) {
        error.value =
          'Escuchando a la bicicleta, pero no llegan anuncios. Pedalea para despertar la consola y acércate al equipo. Si sigue igual, quita "M3" de los dispositivos emparejados de Windows y reconecta.'
      }
    }, 10000)
  }

  async function connectGatt(dev) {
    const server = await dev.gatt.connect()
    const cadenceFromCsc = createCadenceCalculator()
    const cadenceFromPower = createCadenceCalculator()
    const found = []

    const hasCsc = await subscribe(server, CSC_SERVICE, CSC_MEASUREMENT, (dv) => {
      const { crank } = parseCsc(dv)
      if (crank) rpm.value = cadenceFromCsc(crank.revs, crank.eventTime)
    })
    if (hasCsc) found.push('Cycling Speed & Cadence')

    const hasPower = await subscribe(server, CYCLING_POWER_SERVICE, CYCLING_POWER_MEASUREMENT, (dv) => {
      const { watts: w, crank } = parseCyclingPower(dv)
      watts.value = w
      // Si no hay servicio CSC, la cadencia puede venir en los datos de biela del servicio de potencia.
      if (!hasCsc && crank) rpm.value = cadenceFromPower(crank.revs, crank.eventTime)
    })
    if (hasPower) found.push('Cycling Power')

    // Respaldo: Fitness Machine Service (Indoor Bike Data) trae potencia y cadencia directamente.
    if (!hasPower || !hasCsc) {
      const hasFtms = await subscribe(server, FTMS_SERVICE, INDOOR_BIKE_DATA, (dv) => {
        const d = parseIndoorBikeData(dv)
        if (!hasPower && d.watts !== undefined) watts.value = d.watts
        if (!hasCsc && d.rpm !== undefined) rpm.value = d.rpm
      })
      if (hasFtms) found.push('Fitness Machine')
    }

    if (found.length === 0) {
      dev.gatt.disconnect()
      throw Object.assign(new Error('Sin servicios compatibles'), { name: 'NotSupportedError' })
    }
    sources.value = found
  }

  function onDisconnected() {
    cleanupSubscriptions()
    clearInterval(staleTimer)
    if (mode.value === 'bluetooth') {
      error.value = 'Se perdió la conexión con la bicicleta.'
      mode.value = 'idle'
    }
    watts.value = 0
    rpm.value = 0
  }

  function cleanupSubscriptions() {
    for (const { characteristic, listener } of subscriptions) {
      characteristic.removeEventListener('characteristicvaluechanged', listener)
      characteristic.stopNotifications?.().catch(() => {})
    }
    subscriptions.length = 0
  }

  async function connect() {
    error.value = ''
    if (!isBluetoothSupported) {
      error.value =
        'Este navegador no soporta Web Bluetooth. Usa Google Chrome o Microsoft Edge en escritorio (o Chrome en Android).'
      return
    }
    stopSimulator()
    mode.value = 'connecting'

    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [
          { services: [CYCLING_POWER_SERVICE] },
          { services: [CSC_SERVICE] },
          { services: [FTMS_SERVICE] },
          { namePrefix: 'M3' },
          { namePrefix: 'Keiser' },
        ],
        optionalServices: [CYCLING_POWER_SERVICE, CSC_SERVICE, FTMS_SERVICE],
        optionalManufacturerData: [KEISER_COMPANY_ID],
      })
      deviceName.value = device.name || 'Bicicleta BLE'
      rawPacket.value = ''

      console.info('[BLE] Dispositivo elegido:', { name: device.name, id: device.id })

      if (KEISER_NAME.test(device.name || '')) {
        await listenToBroadcast(device)
      } else {
        try {
          device.addEventListener('gattserverdisconnected', onDisconnected)
          await connectGatt(device)
        } catch (gattErr) {
          // Windows puede no informar el nombre de la Keiser; si no acepta GATT, se prueba con sus anuncios.
          console.warn('[BLE] GATT falló, probando anuncios BLE:', gattErr)
          device.removeEventListener('gattserverdisconnected', onDisconnected)
          cleanupSubscriptions()
          if (device.gatt?.connected) device.gatt.disconnect()
          await listenToBroadcast(device)
        }
      }

      mode.value = 'bluetooth'
      markData()
      startStaleWatchdog(stopBroadcast ? BROADCAST_STALE_MS : STALE_MS)
    } catch (err) {
      console.error(err)
      stopBroadcast?.()
      cleanupSubscriptions()
      if (device?.gatt?.connected) device.gatt.disconnect()
      device = null
      mode.value = 'idle'
      error.value = friendlyBluetoothError(err)
    }
  }

  function startSimulator() {
    disconnect()
    error.value = ''
    mode.value = 'simulator'
    deviceName.value = 'Simulador'
    sources.value = ['Datos aleatorios']
    let r = 75
    let g = 12
    let secs = 0
    let kcal = 0
    let km = 0
    const tick = () => {
      // Imita la consola Keiser: reloj, marcha que cambia cada tanto y acumulados.
      consoleSeconds.value = secs++
      if (Math.random() < 0.06) g = Math.min(20, Math.max(6, g + Math.round((Math.random() - 0.5) * 8)))
      r = Math.min(90, Math.max(60, r + (Math.random() - 0.5) * 8))
      // La potencia sigue a marcha × cadencia, acotada a 100-250 W.
      const w = Math.min(250, Math.max(100, g * r * 0.2 + (Math.random() - 0.5) * 12))
      watts.value = Math.round(w)
      rpm.value = Math.round(r)
      gear.value = g
      kcal += w / 1000 // ~1 kcal por kJ de trabajo mecánico
      km += (r / 60) * 0.0065
      calories.value = Math.floor(kcal)
      distanceKm.value = Math.round(km * 100) / 100
    }
    tick()
    simTimer = setInterval(tick, 1000)
  }

  function stopSimulator() {
    if (simTimer) {
      clearInterval(simTimer)
      simTimer = null
    }
  }

  function disconnect() {
    stopSimulator()
    clearInterval(staleTimer)
    clearTimeout(noDataTimer)
    stopBroadcast?.()
    rawPacket.value = ''
    consoleSeconds.value = null
    clearInterval(healthTimer)
    Object.assign(bleStats, { packets: 0, restarts: 0, lastPacketAt: 0, silentSec: null })
    gear.value = null
    calories.value = null
    distanceKm.value = null
    if (device) {
      device.removeEventListener('gattserverdisconnected', onDisconnected)
      cleanupSubscriptions()
      if (device.gatt?.connected) device.gatt.disconnect()
      device = null
    }
    mode.value = 'idle'
    deviceName.value = ''
    sources.value = []
    watts.value = 0
    rpm.value = 0
  }

  onBeforeUnmount(disconnect)

  return {
    watts,
    rpm,
    mode,
    deviceName,
    sources,
    error,
    rawPacket,
    bleStats,
    consoleSeconds,
    gear,
    calories,
    distanceKm,
    isLive,
    isBluetoothSupported,
    connect,
    startSimulator,
    disconnect,
  }
}
