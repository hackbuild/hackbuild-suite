// The senses document kind (design 3.12) and the words the tool says. A
// session keeps where every thing stands, the eye settings and what is fed
// to a brain, saved as `.hbsenses.json`. The lines follow the room
// original's mind tab: "shelf (36 deg right, 0.3 m)" in view and "mug (last
// seen near the shelf, 12 s ago)" for beliefs. Framework free and three free.
import type { DocKind } from '../workspace/kinds.ts'
import { PROPS, propDef, type Placed } from '../agents/props.ts'

export const SENSES_KIND = 'senses.session'

export const FEEDS = ['nothing', 'three clearances', 'clearances and an 8 by 5 grid'] as const
export type Feed = (typeof FEEDS)[number]

export const INSETS = ['what it sees', 'depth', 'detector', 'hidden'] as const
export type InsetMode = (typeof INSETS)[number]

/** The things of the senses room, in placing order. */
export const SENSE_THINGS = ['shelf', 'table', 'chair', 'mug', 'ball', 'box', 'bowl'] as const

export interface SensesBody {
  things: Placed[]
  /** Vertical field of view of the eye, degrees. */
  fov: number
  /** Sense passes a second. */
  rate: number
  /** Pixels of the eye frame a thing must cover to be seen. */
  floor: number
  feed: Feed
  inset: InsetMode
}

export const newSensesBody = (): SensesBody => ({ things: [], fov: 74, rate: 4, floor: 4, feed: 'three clearances', inset: 'what it sees' })

export function checkSenses(raw: unknown): string | null {
  const b = raw as Partial<SensesBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!Array.isArray(b.things)) return 'things is not a list.'
  for (const t of b.things) {
    if (!t || !propDef(String(t.label))) return `${String(t?.label)} is not one of ${PROPS.map((p) => p.label).join(', ')}.`
    if (!Number.isFinite(t.x) || !Number.isFinite(t.z)) return `${t.label} has no spot on the floor.`
  }
  if (typeof b.fov !== 'number' || !(b.fov >= 50 && b.fov <= 110)) return 'field of view is degrees between 50 and 110.'
  if (typeof b.rate !== 'number' || !(b.rate >= 1 && b.rate <= 10)) return 'sense rate is between 1 and 10 a second.'
  if (typeof b.floor !== 'number' || !(b.floor >= 1 && b.floor <= 40)) return 'detector floor is pixels between 1 and 40.'
  if (!(FEEDS as readonly string[]).includes(String(b.feed))) return `feed ${String(b.feed)} is not one of ${FEEDS.join(', ')}.`
  if (!(INSETS as readonly string[]).includes(String(b.inset))) return `inset ${String(b.inset)} is not one of ${INSETS.join(', ')}.`
  return null
}

export const sensesKind: DocKind<SensesBody> = {
  kind: SENSES_KIND,
  tool: 'senses',
  label: 'senses',
  ext: '.hbsenses.json',
  version: 1,
  create: newSensesBody,
  check: checkSenses,
}

/** Bearing words as the room original says them: ahead inside 12 degrees. */
export function bearingWords(deg: number): string {
  const d = Math.round(deg)
  return Math.abs(d) < 12 ? 'ahead' : d > 0 ? `${d} deg right` : `${-d} deg left`
}

/**
 * Degrees right of where the agent faces, for a thing at dx, dz from the
 * eye; yaw 0 faces +z, so the agent's right is -x. Display only: atan2
 * differs in its last digit between engines, so this never enters a hash.
 */
export function bearingDeg(dx: number, dz: number, yaw: number): number {
  const s = Math.sin(yaw)
  const c = Math.cos(yaw)
  const ahead = dx * s + dz * c
  const right = -dx * c + dz * s
  return (Math.atan2(right, ahead) * 180) / Math.PI
}

export const inViewLine = (label: string, deg: number, dist: number) => `${label} (${bearingWords(deg)}, ${dist.toFixed(1)} m)`

/** The furniture nearest a spot within 1.5 m, for the "last seen near" words. */
export function nearestFurniture(things: readonly Placed[], x: number, z: number, self: string): string | null {
  let best: string | null = null
  let bd = 2.25
  for (const t of things) {
    if (t.label === self || propDef(t.label)?.kind !== 'furniture') continue
    const d = (t.x - x) ** 2 + (t.z - z) ** 2
    if (d < bd) { bd = d; best = t.label }
  }
  return best
}

export function seenEarlierLine(label: string, near: string | null, ago: number, confidence: number): string {
  const where = near ? `near the ${near}` : 'on the floor'
  return `${label} (last seen ${where}, ${Math.max(0, Math.round(ago))} s ago, confidence ${confidence.toFixed(2)})`
}

/** Height of the eye over the floor, meters, and its pitch down (proposed). */
export const EYE_Y = 1.55
export const EYE_PITCH = -0.42
/** Depth range of the eye, meters (vendor default 12). */
export const FAR = 12

/** The vertical angle of a depth row, radians, row 0 at the top. Display only. */
const rowAngle = (r: number, h: number, vfovDeg: number) => EYE_PITCH + Math.atan((1 - (2 * (r + 0.5)) / h) * Math.tan((vfovDeg * Math.PI) / 360))

/**
 * What the depth says, as the original fed it to a brain: three
 * clearances (left, ahead, right thirds) and an 8 by 5 grid of the nearest
 * depth per cell, meters. Floor pixels (a ray end under 4 cm) do not
 * count; a cell that sees only floor or nothing reads the far range.
 */
export function depthFeed(depth: ArrayLike<number>, w: number, h: number, vfovDeg: number): { left: number; ahead: number; right: number; grid: number[][] } {
  const grid = Array.from({ length: 5 }, () => new Array<number>(8).fill(FAR))
  const zones = [FAR, FAR, FAR]
  for (let r = 0; r < h; r++) {
    const s = Math.sin(rowAngle(r, h, vfovDeg))
    const gr = Math.min(4, Math.floor((r * 5) / h))
    for (let c = 0; c < w; c++) {
      const d = depth[r * w + c]!
      if (!(d > 0) || d >= FAR * 0.999 || EYE_Y + d * s < 0.04) continue
      const gc = Math.min(7, Math.floor((c * 8) / w))
      if (d < grid[gr]![gc]!) grid[gr]![gc] = d
      const z = Math.min(2, Math.floor((c * 3) / w))
      if (d < zones[z]!) zones[z] = d
    }
  }
  return { left: zones[0]!, ahead: zones[1]!, right: zones[2]!, grid }
}

/** The text a brain would get for the feed choice, and its cost in tokens (inferred, 4 characters a token). */
export function feedText(feed: Feed, f: ReturnType<typeof depthFeed> | null, seen: readonly string[]): { text: string; tokens: number } {
  const lines = [`I SEE NOW: ${seen.length ? seen.join('; ') : 'nothing in view'}`]
  if (f && feed !== 'nothing') lines.push(`CLEAR: left ${f.left.toFixed(1)} m, ahead ${f.ahead.toFixed(1)} m, right ${f.right.toFixed(1)} m`)
  if (f && feed === 'clearances and an 8 by 5 grid') {
    lines.push('DEPTH GRID (m, top row first):')
    for (const row of f.grid) lines.push(row.map((v) => v.toFixed(1).padStart(4)).join(' '))
  }
  const text = lines.join('\n')
  return { text, tokens: Math.ceil(text.length / 4) }
}

/** The sense feed as csv: one row per event. */
export function feedCsv(rows: readonly { t: number; kind: string; text: string }[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  return ['t,kind,text', ...rows.map((r) => `${r.t.toFixed(2)},${r.kind},${q(r.text)}`)].join('\n') + '\n'
}
