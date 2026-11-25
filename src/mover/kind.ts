// The mover world document (design 3.12) and what the tool builds from it:
// the colliders of `@hackbuild/mover`, the footprints its steerer reads, the
// meshes the room draws and a path round the walls. A world keeps every
// box, cylinder and wall, where the body starts and the goal, saved as
// `.hbworld.json`. Framework free and three free.
import { STEP_UP, box, cyl, nearest, wallBox, type Collider, type Footprint } from '@hackbuild/mover'
import type { DocKind } from '../workspace/kinds.ts'
import { clampRoom, seededLayout, type PropDef } from '../agents/props.ts'

export const MOVER_KIND = 'mover.world'

export const ITEM_KINDS = ['box', 'cylinder', 'wall'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

/** A thing in the world. `w` runs along x and `d` along z before the turn; a cylinder reads `w` as its diameter. */
export interface WorldItem {
  label: string
  kind: ItemKind
  x: number
  z: number
  w: number
  d: number
  h: number
  /** Quarter turns about the vertical: 0 or 1 (a turned wall runs along z). */
  turn: 0 | 1
}

export interface Spot {
  x: number
  z: number
}

export interface MoverBody {
  items: WorldItem[]
  start: Spot
  goal: Spot | null
}

export const newMoverBody = (): MoverBody => ({ items: [], start: { x: 0, z: 0 }, goal: null })

/** Sizes a new thing takes, meters (proposed: a crate, a post, a partition). */
export const SIZES: Record<ItemKind, { w: number; d: number; h: number }> = {
  box: { w: 0.6, d: 0.6, h: 0.6 },
  cylinder: { w: 0.5, d: 0.5, h: 0.9 },
  wall: { w: 2.4, d: 0.2, h: 1.2 },
}

/** The body: a capsule this wide and tall (inferred for the mannequin). */
export const BODY_R = 0.28
export const BODY_H = 1.7
/** Room half side, meters: the room props' 4 plus a meter of floor. */
export const HALF = 5

const COLORS: Record<ItemKind, string> = { box: '#3b82f6', cylinder: '#e0457b', wall: '#8a8f98' }

export const MOVER_COPY = {
  empty: 'click the floor to set a goal. pick box, cylinder or wall to place one.',
  inWall: 'the goal is inside a wall. click open floor.',
  noWay: 'no way to the goal. move a wall or click open floor.',
}

export function checkMover(raw: unknown): string | null {
  const b = raw as Partial<MoverBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!Array.isArray(b.items)) return 'items is not a list.'
  for (const t of b.items) {
    if (!t || !(ITEM_KINDS as readonly string[]).includes(String(t.kind))) return `${String(t?.kind)} is not one of ${ITEM_KINDS.join(', ')}.`
    if (![t.x, t.z].every(Number.isFinite) || Math.abs(t.x) > HALF || Math.abs(t.z) > HALF) return `${t.label} stands off the floor.`
    if (![t.w, t.d, t.h].every((v) => typeof v === 'number' && v > 0 && v <= 6)) return `${t.label} has a size that is not between 0 and 6 m.`
    if (t.turn !== 0 && t.turn !== 1) return `${t.label} turn is 0 or 1.`
  }
  if (!b.start || ![b.start.x, b.start.z].every(Number.isFinite)) return 'the start has no spot.'
  if (b.goal !== null && (!b.goal || ![b.goal.x, b.goal.z].every(Number.isFinite))) return 'the goal is not a spot.'
  return null
}

export const moverKind: DocKind<MoverBody> = {
  kind: MOVER_KIND,
  tool: 'mover',
  label: 'world',
  ext: '.hbworld.json',
  version: 1,
  create: newMoverBody,
  check: checkMover,
}

const r2 = (v: number) => Math.round(v * 100) / 100
/** Width on x and depth on z after the turn. */
export const extent = (t: WorldItem) => (t.turn ? { w: t.d, d: t.w } : { w: t.w, d: t.d })

/** A new thing of a kind at a spot, labelled after the ones before it. */
export function newItem(items: readonly WorldItem[], kind: ItemKind, x: number, z: number, turn: 0 | 1 = 0, size = SIZES[kind]): WorldItem {
  let n = 1
  while (items.some((t) => t.label === `${kind} ${n}`)) n++
  const t: WorldItem = { label: `${kind} ${n}`, kind, x: 0, z: 0, w: r2(size.w), d: r2(size.d), h: r2(size.h), turn }
  // the whole thing stays on the floor
  const e = extent(t)
  t.x = r2(Math.max(-(HALF - e.w / 2), Math.min(HALF - e.w / 2, clampRoom(x))))
  t.z = r2(Math.max(-(HALF - e.d / 2), Math.min(HALF - e.d / 2, clampRoom(z))))
  return t
}

/** The seeded world: two walls, a box and a cylinder, clear of the start. */
export function seededWorld(rng: () => number): MoverBody {
  const kinds: ItemKind[] = ['wall', 'wall', 'box', 'cylinder']
  const spots = seededLayout(rng, kinds.map((k, i) => `${k} ${i}`))
  const items: WorldItem[] = []
  kinds.forEach((k, i) => items.push(newItem(items, k, spots[i]!.x, spots[i]!.z, rng() < 0.5 ? 0 : 1)))
  return { items, start: { x: 0, z: 0 }, goal: null }
}

/** Mesh sizes for the room: a wall and a box are boxes, a cylinder a cylinder. */
export function itemDef(t: WorldItem): PropDef {
  return { label: t.label, kind: 'furniture', shape: t.kind === 'cylinder' ? 'cyl' : 'box', w: t.w, h: t.h, d: t.kind === 'cylinder' ? t.w : t.d, color: COLORS[t.kind] }
}

/** The floor, the four sides of the room and every thing, as `@hackbuild/mover` colliders. */
export function collidersOf(items: readonly WorldItem[]): Collider[] {
  const out: Collider[] = [box(0, 0, 0, 2 * HALF + 2, 2 * HALF + 2, 0.5)]
  const side = 2 * HALF + 0.4
  out.push(wallBox(0, HALF + 0.1, side, 0.2, 0, 2), wallBox(0, -HALF - 0.1, side, 0.2, 0, 2), wallBox(HALF + 0.1, 0, 0.2, side, 0, 2), wallBox(-HALF - 0.1, 0, 0.2, side, 0, 2))
  for (const t of items) {
    const e = extent(t)
    const c = t.kind === 'wall' ? wallBox(t.x, t.z, e.w, e.d, 0, t.h) : t.kind === 'cylinder' ? cyl(t.x, t.h, t.z, t.w / 2, t.h) : box(t.x, t.h, t.z, e.w, e.d, t.h)
    c.id = t.label
    out.push(c)
  }
  return out
}

/** True when the body can step onto it (`STEP_UP`): no footprint, the world carries the body over. */
export const stepOver = (t: WorldItem) => t.kind !== 'wall' && t.h <= STEP_UP

/**
 * Footprints the steerer keeps clear of: a cylinder is a circle, a box or a
 * wall a capsule along its long side wide enough for the corners.
 */
export function footprintsOf(items: readonly WorldItem[]): Footprint[] {
  return items.filter((t) => !stepOver(t)).map((t) => {
    if (t.kind === 'cylinder') return { id: t.label, parts: [{ x: t.x, z: t.z, r: t.w / 2 }] }
    const e = extent(t)
    const long = Math.max(e.w, e.d)
    const short = Math.min(e.w, e.d)
    const half = Math.max(0, long / 2 - short / 2)
    const r = (short / 2) * Math.SQRT2
    return e.w >= e.d
      ? { id: t.label, parts: [{ ax: t.x - half, az: t.z, bx: t.x + half, bz: t.z, r }] }
      : { id: t.label, parts: [{ ax: t.x, az: t.z - half, bx: t.x, bz: t.z + half, r }] }
  })
}

/** Surface distance from a spot to the nearest footprint; Infinity with none. */
export function clearance(fps: readonly Footprint[], x: number, z: number): number {
  let best = Infinity
  for (const f of fps) best = Math.min(best, nearest(f, x, z).dist)
  return best
}

/** The thing a spot is inside, by its exact box or circle, or null. */
export function inside(items: readonly WorldItem[], x: number, z: number, pad = 0): WorldItem | null {
  for (const t of items) {
    if (stepOver(t)) continue
    if (t.kind === 'cylinder') { if (Math.hypot(x - t.x, z - t.z) < t.w / 2 + pad) return t; continue }
    const e = extent(t)
    if (Math.abs(x - t.x) < e.w / 2 + pad && Math.abs(z - t.z) < e.d / 2 + pad) return t
  }
  return null
}

/** The steer state as the rack reads it, one row a field. */
export interface SteerRead {
  mode: string
  why: string
  speed: number
  waypoint: string
  stalls: number
  unreachable: boolean
  grounded: boolean
  hitWall: boolean
  x: number
  z: number
}

export function steerRows(s: SteerRead): { label: string; value: string }[] {
  return [
    { label: 'mode', value: s.mode },
    { label: 'why', value: s.why || 'no goal' },
    { label: 'speed', value: `${s.speed.toFixed(2)} m/s` },
    { label: 'waypoint', value: s.waypoint },
    { label: 'stalls', value: String(s.stalls) },
    { label: 'unreachable', value: s.unreachable ? 'yes' : 'no' },
    { label: 'on the ground', value: s.grounded ? 'yes' : 'no' },
    { label: 'against a wall', value: s.hitWall ? 'yes' : 'no' },
    { label: 'at', value: `${s.x.toFixed(2)}, ${s.z.toFixed(2)} m` },
  ]
}

/** The steer trace as csv: time, spot, mode and why. */
export function traceCsv(rows: readonly { t: number; x: number; z: number; mode: string; why: string }[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return ['t,x,z,mode,why', ...rows.map((r) => [r.t.toFixed(3), r.x.toFixed(3), r.z.toFixed(3), r.mode, q(r.why)].join(','))].join('\n') + '\n'
}
