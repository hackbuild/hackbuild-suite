// The motion-match document kind (design 3.11), the built in clip set and
// the run trace. A session keeps the overlay switches and the tuning (the
// feature weights and the search parameters), saved as `.hbmm.json`; body
// files are never in it. The clip set is made in code by
// `ClipSet.addSynthetic` of `@hackbuild/motion-match`: no clip file ships
// and nothing downloads. Framework free and three free.
import type { DocKind } from '../workspace/kinds.ts'

export const MM_KIND = 'motion-match.session'

export interface BuiltinClip {
  name: string
  /** Speed at the start, m/s. */
  speed: number
  speedEnd?: number
  /** rad/s, positive turns to the body's left. */
  turnRate?: number
  strides?: number
}

/** Ten clips: idle, steady gaits, arcs, turns in place, starts, stops and speed changes (proposed). */
export const BUILTIN_CLIPS: BuiltinClip[] = [
  { name: 'idle', speed: 0, strides: 2 },
  { name: 'walk', speed: 1.2, strides: 3 },
  { name: 'jog', speed: 2.2, strides: 3 },
  { name: 'arc left', speed: 1.2, turnRate: 0.8, strides: 3 },
  { name: 'arc right', speed: 1.2, turnRate: -0.8, strides: 3 },
  { name: 'turn left', speed: 0, turnRate: 2.4, strides: 2 },
  { name: 'turn right', speed: 0, turnRate: -2.4, strides: 2 },
  { name: 'start', speed: 0, speedEnd: 1.2, strides: 3 },
  { name: 'stop', speed: 1.2, speedEnd: 0, strides: 3 },
  { name: 'speed up', speed: 1.2, speedEnd: 2.2, strides: 3 },
]

/** The copy when a clip set is too small to match well. */
export const fewClipsLine = (n: number): string | null => (n < 3 ? `the clip set has ${n} clip${n === 1 ? '' : 's'}. matching needs more to look right.` : null)

export interface MmBody {
  /** Draw the desired trajectory. */
  trajectory: boolean
  /** Draw the matched frame's own future trajectory. */
  candidate: boolean
  /** Clips switched off in the inspector, by name. */
  off: string[]
}

export const newMmBody = (): MmBody => ({ trajectory: true, candidate: true, off: [] })

export function checkMm(raw: unknown): string | null {
  const b = raw as Partial<MmBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (typeof b.trajectory !== 'boolean' || typeof b.candidate !== 'boolean') return 'trajectory and candidate are on or off.'
  if (!Array.isArray(b.off) || !b.off.every((n) => typeof n === 'string')) return 'off is a list of clip names.'
  return null
}

export const mmKind: DocKind<MmBody> = {
  kind: MM_KIND,
  tool: 'motion-match',
  label: 'motion match',
  ext: '.hbmm.json',
  version: 1,
  create: newMmBody,
  check: checkMm,
}

export interface TraceRow {
  t: number
  clip: string
  frame: number
  cost: number
  jumped: boolean
  speed: number
  turnRate: number
}

/** The run trace as csv, one row a frame (P-SAVE-10). */
export function traceCsv(rows: readonly TraceRow[]): string {
  const f = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : '')
  return ['t,clip,frame,cost,jumped,speed,turn_rate', ...rows.map((r) => [f(r.t, 3), JSON.stringify(r.clip), r.frame.toFixed(1), f(r.cost, 4), r.jumped ? 1 : 0, f(r.speed, 3), f(r.turnRate, 3)].join(','))].join('\n') + '\n'
}

export interface Root2 { x: number; z: number; yaw: number }

/** `b` in `a`'s frame, the way the matcher reads a future root (yaw 0 faces +z). */
export function relative(a: Root2, b: Root2): Root2 {
  const s = Math.sin(a.yaw)
  const c = Math.cos(a.yaw)
  const dx = b.x - a.x
  const dz = b.z - a.z
  return { x: c * dx - s * dz, z: s * dx + c * dz, yaw: b.yaw - a.yaw }
}

/** A point given in `a`'s frame, in the world. */
export function toWorld(a: Root2, x: number, z: number): { x: number; z: number } {
  const s = Math.sin(a.yaw)
  const c = Math.cos(a.yaw)
  return { x: a.x + c * x + s * z, z: a.z - s * x + c * z }
}

/** Least squares `y = a x + b`; a flat `x` gives a 0 and the mean of `y`. */
export function fitLine(xs: ArrayLike<number>, ys: ArrayLike<number>): { a: number; b: number } {
  const n = xs.length
  let mx = 0
  let my = 0
  for (let i = 0; i < n; i++) { mx += xs[i]!; my += ys[i]! }
  mx /= n || 1
  my /= n || 1
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) { const dx = xs[i]! - mx; sxy += dx * (ys[i]! - my); sxx += dx * dx }
  const a = sxx > 1e-12 ? sxy / sxx : 0
  return { a, b: my - a * mx }
}
