/**
 * Postura del ciclista virtual, compartida por la vista 2D y la 3D.
 * Coordenadas laterales en centímetros: suelo en y = 0, y hacia arriba es negativo (como SVG),
 * eje pedalier cerca del origen. La vista 3D las convierte a metros con y hacia arriba.
 */

export const lerp = (a, b, t) => a + (b - a) * t
const lerpP = (p, q, t) => ({ x: lerp(p.x, q.x, t), y: lerp(p.y, q.y, t) })
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}
const deg = (d) => (d * Math.PI) / 180

// Cinemática inversa de dos segmentos (muslo-pierna, brazo-antebrazo).
function joint(a, b, l1, l2, pick) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const d = Math.min(Math.max(Math.hypot(dx, dy), 1e-3), l1 + l2 - 0.01)
  const base = Math.atan2(dy, dx)
  const k = Math.acos(Math.min(1, (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d)))
  const c1 = { x: a.x + l1 * Math.cos(base + k), y: a.y + l1 * Math.sin(base + k) }
  const c2 = { x: a.x + l1 * Math.cos(base - k), y: a.y + l1 * Math.sin(base - k) }
  return pick(c1, c2)
}
const kneeForward = (a, b) => (a.x > b.x ? a : b)
const elbowDown = (a, b) => (a.y > b.y ? a : b)

// Geometría de la bicicleta.
export const BB = { x: 0, y: -28 }
export const REAR = { x: -50, y: -34 }
export const FRONT = { x: 52, y: -34 }
export const SEAT = { x: -12, y: -70 }
export const HEAD_TUBE = { x: 38, y: -70 }
export const BARS = { x: 46, y: -78 }
export const WHEEL_RADIUS_CM = 33

/**
 * @param crank ángulo de la biela (rad)
 * @param e esfuerzo suavizado 0-1 (lo fija la marcha)
 * @param pedaling si hay cadencia
 */
export function computePose(crank, e, pedaling) {
  const stand = pedaling ? smooth(0.62, 0.85, e) : 0 // de pie en marchas altas
  const pedalR = { x: BB.x + 10 * Math.cos(crank), y: BB.y + 10 * Math.sin(crank) }
  const pedalL = { x: BB.x - 10 * Math.cos(crank), y: BB.y - 10 * Math.sin(crank) }

  const hip = lerpP({ x: -14, y: -78 }, { x: 8, y: -84 }, stand)
  hip.y += stand * 2.5 * Math.sin(2 * crank) // balanceo al pedalear de pie
  // Inclinación del torso: relajado → agachado y tenso con la marcha.
  const lean = deg(pedaling ? lerp(48 + 16 * e, 58, stand) : 38)
  const shoulder = { x: hip.x + 34 * Math.sin(lean), y: hip.y - 34 * Math.cos(lean) }
  const neck = lean + deg(10 + 18 * e) // la cabeza cae con el esfuerzo
  const head = { x: shoulder.x + 10 * Math.sin(neck), y: shoulder.y - 10 * Math.cos(neck) }

  return {
    stand,
    pedalR,
    pedalL,
    hip,
    shoulder,
    head,
    kneeR: joint(hip, pedalR, 34, 34, kneeForward),
    kneeL: joint(hip, pedalL, 34, 34, kneeForward),
    elbow: joint(shoulder, BARS, 18, 18, elbowDown),
    // Gesto: boca más abierta con más esfuerzo.
    mouth: 0.5 + 2.5 * e,
  }
}
