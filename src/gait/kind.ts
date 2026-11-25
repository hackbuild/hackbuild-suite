// The gait document kind (design 3.11) and the baked clip. A session keeps
// the gait chip, the ground and the tuning (top speed, stride, slope), saved
// as `.hbgait.json`; body files are never in it. A run bakes into a clip
// file: every bone's local rotation per frame by bone name, the shape the
// avatar tool reads, plus the root track and the foot contacts.
// Framework free and three free.
import type { DocKind } from '../workspace/kinds.ts'
import { CLIP_FORMAT, type ClipFile } from '../avatar/pose.ts'

export const GAIT_KIND = 'gait.session'

/** The gait chips: auto leaves the speed to the pad and the tune drawer. */
export const GAIT_CHIPS = ['auto', 'walk', 'pace', 'trot', 'canter', 'gallop'] as const
export type GaitChip = (typeof GAIT_CHIPS)[number]

export const TERRAINS = ['flat', 'slope', 'bumps'] as const
export type Terrain = (typeof TERRAINS)[number]

export interface GaitBody {
  gait: GaitChip
  terrain: Terrain
  /** Seconds of the run the bake keeps. */
  bake: number
}

export const newGaitBody = (): GaitBody => ({ gait: 'auto', terrain: 'flat', bake: 6 })

export function checkGait(raw: unknown): string | null {
  const b = raw as Partial<GaitBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!(GAIT_CHIPS as readonly string[]).includes(String(b.gait))) return `gait ${String(b.gait)} is not one of ${GAIT_CHIPS.join(', ')}.`
  if (!(TERRAINS as readonly string[]).includes(String(b.terrain))) return `ground ${String(b.terrain)} is not flat, slope or bumps.`
  if (typeof b.bake !== 'number' || !(b.bake >= 1 && b.bake <= 30)) return 'bake is seconds between 1 and 30.'
  return null
}

export const gaitKind: DocKind<GaitBody> = {
  kind: GAIT_KIND,
  tool: 'gait',
  label: 'gait',
  ext: '.hbgait.json',
  version: 1,
  create: newGaitBody,
  check: checkGait,
}

/**
 * Froude bands the library picks gaits by (vendor thresholds: pace 0.12,
 * trot 0.42, canter 1.5, gallop from 2.6 times canter; `@hackbuild/gait`
 * froude.rs). A chip sets the top speed to the middle of its band for a leg
 * length (computed); pace shares the band under 0.42 with trot and needs the
 * pace bias.
 */
const FROUDE_MID: Record<Exclude<GaitChip, 'auto'>, number> = { walk: 0.06, pace: 0.25, trot: 0.8, canter: 2.4, gallop: 5.5 }
export const chipSpeed = (chip: Exclude<GaitChip, 'auto'>, legLength: number) => Math.sqrt(FROUDE_MID[chip] * 9.81 * legLength)

/** Half width of the slope's ridge along z, meters (proposed). */
export const RIDGE = 3

/** Ground height at a spot, meters, for the ground chip and a slope in degrees: the slope is a ridge across x, up and down again. */
export function groundAt(terrain: Terrain, slopeDeg: number, x: number, z: number): number {
  if (terrain === 'slope') return Math.tan((slopeDeg * Math.PI) / 180) * Math.max(0, RIDGE - Math.abs(z))
  if (terrain === 'bumps') return 0.05 + 0.04 * Math.sin(x * 2.1) * Math.cos(z * 1.7) + 0.02 * Math.sin(z * 3.3 + 1)
  return 0
}

/** A baked run: the avatar tool's clip file plus the root track and the contacts. */
export interface BakedClip extends ClipFile {
  source: string
  /** frames * 4: x, y, z, yaw. */
  root: number[]
  /** Foot or leg names, the order of the contacts. */
  feet: string[]
  /** frames * feet, 1 planted, 0 in the air. */
  contacts: number[]
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5

export function bakedClip(name: string, source: string, fps: number, bones: readonly string[], rotations: ArrayLike<number>, root: ArrayLike<number>, feet: readonly string[], contacts: ArrayLike<number>): BakedClip {
  const frames = Math.round(root.length / 4)
  return {
    format: CLIP_FORMAT, version: 1, name, fps, frames, loop: false, bones: [...bones],
    rotations: Array.from(rotations, r5), source, root: Array.from(root, r5), feet: [...feet], contacts: Array.from(contacts, (c) => (c ? 1 : 0)),
  }
}
