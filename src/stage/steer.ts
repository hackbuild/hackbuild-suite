// The pad as a locomotion command: the stick points where the body should
// head, camera relative like the walking stage, and its length is the share
// of top speed. Backends that turn at a rate (the gait oscillator, the
// motion matcher) get a turn rate toward that heading instead of a snap.
// Core three only.
import { Vector3, type Camera } from 'three'
import type { Move } from './walk'

export interface Command {
  /** Forward speed, m/s. */
  speed: number
  /** Turn rate, rad/s, positive turns toward +x from +z. */
  turnRate: number
  /** Heading the stick asks for, radians; null with the stick at rest. */
  heading: number | null
}

const UP = new Vector3(0, 1, 0)
const fwd = new Vector3()
const right = new Vector3()
const step = new Vector3()

/** The signed shortest turn from `a` to `b`, radians. */
export const angleTo = (a: number, b: number) => Math.atan2(Math.sin(b - a), Math.cos(b - a))

/**
 * A speed and turn rate from the pad. `yaw` is the body's heading now
 * (0 faces +z); `top` the speed at full stick; `turnMax` caps the turn rate.
 * The speed eases off while the body is facing away from the stick.
 */
export function padCommand(camera: Camera, move: Move, yaw: number, top: number, turnMax = 2.5): Command {
  camera.getWorldDirection(fwd)
  fwd.y = 0
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1)
  fwd.normalize()
  right.crossVectors(fwd, UP).normalize()
  step.copy(fwd).multiplyScalar(-move.y).addScaledVector(right, move.x)
  const amount = Math.min(1, step.length())
  if (amount < 0.05) return { speed: 0, turnRate: 0, heading: null }
  const heading = Math.atan2(step.x, step.z)
  const off = angleTo(yaw, heading)
  const turnRate = Math.max(-turnMax, Math.min(turnMax, off * 3))
  const facing = Math.max(0, Math.cos(off))
  return { speed: top * amount * facing, turnRate, heading }
}
