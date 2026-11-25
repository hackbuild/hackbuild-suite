// The cameras document kind (design 3.12) and the words the tool says. A
// session keeps the rig, the split view, the second target, the shake and
// the orbit where the person left it, saved as `.hbcameras.json`. The
// moving targets walk seeded loops, so a seed replays the same shot.
// Framework free and three free.
import type { DocKind } from '../workspace/kinds.ts'
import { ROOM } from '../agents/props.ts'

export const CAMERAS_KIND = 'cameras.session'

export const RIGS = ['follow', 'orbit', 'first person', 'group'] as const
export type Rig = (typeof RIGS)[number]

export interface CamerasBody {
  rig: Rig
  split: boolean
  /** A second target walks the room: group frames both, split follows each. */
  second: boolean
  /** Shake kick, meters of trauma. */
  kick: number
  orbit: { yaw: number; pitch: number; dist: number }
}

export const newCamerasBody = (): CamerasBody => ({ rig: 'follow', split: false, second: true, kick: 0.25, orbit: { yaw: 0.6, pitch: 0.45, dist: 6 } })

export const CAMERAS_COPY = {
  empty: 'the body walks a seeded loop. take it with the pad, or pick a camera.',
  noSecond: 'no second target. split view needs two.',
}

export function checkCameras(raw: unknown): string | null {
  const b = raw as Partial<CamerasBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!(RIGS as readonly string[]).includes(String(b.rig))) return `rig ${String(b.rig)} is not one of ${RIGS.join(', ')}.`
  if (typeof b.split !== 'boolean' || typeof b.second !== 'boolean') return 'split and second are true or false.'
  if (typeof b.kick !== 'number' || !(b.kick > 0 && b.kick <= 2)) return 'the shake kick is meters between 0 and 2.'
  const o = b.orbit
  if (!o || ![o.yaw, o.pitch, o.dist].every(Number.isFinite) || o.dist <= 0) return 'the orbit has no yaw, pitch and distance.'
  return null
}

export const camerasKind: DocKind<CamerasBody> = {
  kind: CAMERAS_KIND,
  tool: 'cameras',
  label: 'cameras',
  ext: '.hbcameras.json',
  version: 1,
  create: newCamerasBody,
  check: checkCameras,
}

/** A seeded loop on the floor: waypoints drawn in the room square, walked in order. */
export function seededLoop(rng: () => number, n = 6): { x: number; z: number }[] {
  const r2 = (v: number) => Math.round(v * 100) / 100
  return Array.from({ length: n }, () => ({ x: r2((-1 + 2 * rng()) * (ROOM - 1)), z: r2((-1 + 2 * rng()) * (ROOM - 1)) }))
}

/** One walker on a loop: heads for the next waypoint at `speed`, turns there. */
export class Walker {
  x: number
  z: number
  heading = 0
  private i = 0
  readonly loop: { x: number; z: number }[]
  readonly speed: number
  constructor(loop: { x: number; z: number }[], speed: number) {
    this.loop = loop
    this.speed = speed
    this.x = loop[0]!.x
    this.z = loop[0]!.z
    this.i = 1 % loop.length
  }
  step(dt: number) {
    const p = this.loop[this.i]!
    const dx = p.x - this.x
    const dz = p.z - this.z
    const d = Math.hypot(dx, dz)
    const s = this.speed * dt
    if (d <= s) { this.x = p.x; this.z = p.z; this.i = (this.i + 1) % this.loop.length; return }
    this.x += (dx / d) * s
    this.z += (dz / d) * s
    this.heading = Math.atan2(dx, dz)
  }
}
