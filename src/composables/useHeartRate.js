import { ref, computed, onBeforeUnmount } from 'vue'
import { createPulseFilter } from '../heartZones'

// Servicio estándar Bluetooth SIG "Heart Rate". Lo exponen las bandas de pecho y también el
// Apple Watch a través de apps como HeartCast, HR Broadcast, HeartBLE o Echo, que lo anuncian
// como un sensor de pulso común (desde el reloj o desde el iPhone).
const HEART_RATE_SERVICE = 0x180d
const HEART_RATE_MEASUREMENT = 0x2a37

// Sin mediciones durante este tiempo, el pulso se muestra vacío en vez de quedar congelado.
const STALE_MS = 5000
// El reloj o el iPhone pueden cortar la conexión un momento (pantalla bloqueada, app en segundo
// plano): se reintenta antes de darla por perdida.
const RECONNECT_ATTEMPTS = 5
const RECONNECT_DELAY_MS = 2000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Heart Rate Measurement (0x2A37) → { bpm, contact }
 * [0] flags: bit 0 = pulso en uint16 (si no, uint8); bit 2 = informa contacto con la piel,
 * bit 1 = hay contacto. contact es null si el sensor no lo informa.
 */
export function parseHeartRate(dv) {
  const flags = dv.getUint8(0)
  const bpm = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1)
  const contact = flags & 0x04 ? !!(flags & 0x02) : null
  return { bpm, contact }
}

function friendlyError(err) {
  switch (err?.name) {
    case 'NotFoundError':
      return 'No se eligió ningún sensor de pulso. Abre la app que transmite el pulso (por ejemplo HeartCast) en el Apple Watch y el iPhone, inicia el entrenamiento y vuelve a intentarlo.'
    case 'SecurityError':
      return 'El navegador bloqueó Bluetooth. La app debe abrirse desde http://localhost o https://.'
    case 'NotAllowedError':
      return 'Permiso de Bluetooth denegado. Revisa los permisos del sitio en el navegador.'
    case 'NetworkError':
      return 'No se pudo conectar con el sensor de pulso. Verifica que la transmisión siga activa y acerca el equipo.'
    case 'NotSupportedError':
      return 'El dispositivo elegido no expone el servicio de pulso (Heart Rate).'
    default:
      return `Error del sensor de pulso: ${err?.message || err}`
  }
}

/**
 * Pulso en vivo desde cualquier sensor Bluetooth estándar (Apple Watch vía app de transmisión,
 * banda de pecho, etc.). Funciona en paralelo con la conexión de la bicicleta.
 */
export function useHeartRate() {
  const bpm = ref(null)
  /** 'idle' | 'connecting' | 'bluetooth' | 'reconnecting' | 'simulator' */
  const mode = ref('idle')
  const deviceName = ref('')
  const error = ref('')
  // false si el sensor informa que no toca la piel (reloj suelto); null si no lo informa.
  const contact = ref(null)

  const isBluetoothSupported = typeof navigator !== 'undefined' && !!navigator.bluetooth
  const isActive = computed(() => mode.value !== 'idle')

  let device = null
  let characteristic = null
  let staleTimer = null
  let simTimer = null
  let lastDataAt = 0
  let stopping = false
  let pulseFilter = createPulseFilter()

  function onMeasurement(event) {
    const d = parseHeartRate(event.target.value)
    lastDataAt = Date.now()
    contact.value = d.contact
    bpm.value = d.contact === false || d.bpm === 0 ? null : pulseFilter.next(d.bpm)
  }

  function cleanupCharacteristic() {
    if (!characteristic) return
    characteristic.removeEventListener('characteristicvaluechanged', onMeasurement)
    characteristic.stopNotifications?.().catch(() => {})
    characteristic = null
  }

  async function subscribe() {
    cleanupCharacteristic() // por si un intento anterior quedó a medias
    const server = await device.gatt.connect()
    let service
    try {
      service = await server.getPrimaryService(HEART_RATE_SERVICE)
    } catch {
      throw Object.assign(new Error('Sin servicio Heart Rate'), { name: 'NotSupportedError' })
    }
    characteristic = await service.getCharacteristic(HEART_RATE_MEASUREMENT)
    characteristic.addEventListener('characteristicvaluechanged', onMeasurement)
    await characteristic.startNotifications()
    lastDataAt = Date.now()
  }

  function startStaleWatchdog() {
    clearInterval(staleTimer)
    staleTimer = setInterval(() => {
      if (mode.value === 'bluetooth' && Date.now() - lastDataAt > STALE_MS) bpm.value = null
    }, 1000)
  }

  async function onDisconnected() {
    cleanupCharacteristic()
    bpm.value = null
    if (stopping || !device) return
    mode.value = 'reconnecting'
    for (let i = 0; i < RECONNECT_ATTEMPTS; i++) {
      await sleep(RECONNECT_DELAY_MS)
      if (stopping || !device) return
      try {
        await subscribe()
        mode.value = 'bluetooth'
        console.info('[Pulso] reconectado')
        return
      } catch (err) {
        console.warn(`[Pulso] reintento ${i + 1} falló:`, err)
      }
    }
    disconnect()
    error.value =
      'Se perdió la conexión con el sensor de pulso. Revisa que la transmisión siga activa en el Apple Watch/iPhone y vuelve a conectar.'
  }

  async function connect() {
    error.value = ''
    if (!isBluetoothSupported) {
      error.value = 'Este navegador no soporta Web Bluetooth. Usa Google Chrome o Microsoft Edge en escritorio.'
      return
    }
    disconnect()
    stopping = false
    pulseFilter = createPulseFilter()
    mode.value = 'connecting'
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [HEART_RATE_SERVICE] }],
      })
      deviceName.value = device.name || 'Sensor de pulso'
      console.info('[Pulso] Dispositivo elegido:', { name: device.name, id: device.id })
      device.addEventListener('gattserverdisconnected', onDisconnected)
      await subscribe()
      mode.value = 'bluetooth'
      startStaleWatchdog()
    } catch (err) {
      console.error(err)
      const message = friendlyError(err)
      disconnect()
      error.value = message
    }
  }

  /** Pulso de prueba que sigue a la potencia, para usar junto al simulador de la bicicleta. */
  function startSimulator(wattsRef) {
    disconnect()
    stopping = false
    error.value = ''
    mode.value = 'simulator'
    deviceName.value = 'Simulador'
    let hr = 95
    simTimer = setInterval(() => {
      const target = 70 + (wattsRef?.value ?? 0) * 0.45
      hr += (target - hr) * 0.08 + (Math.random() - 0.5) * 2
      bpm.value = Math.round(hr)
    }, 1000)
  }

  function disconnect() {
    stopping = true
    clearInterval(staleTimer)
    clearInterval(simTimer)
    simTimer = null
    if (device) {
      device.removeEventListener('gattserverdisconnected', onDisconnected)
      cleanupCharacteristic()
      if (device.gatt?.connected) device.gatt.disconnect()
      device = null
    }
    mode.value = 'idle'
    deviceName.value = ''
    bpm.value = null
    contact.value = null
  }

  onBeforeUnmount(disconnect)

  return {
    bpm,
    mode,
    deviceName,
    error,
    contact,
    isActive,
    isBluetoothSupported,
    connect,
    startSimulator,
    disconnect,
  }
}
