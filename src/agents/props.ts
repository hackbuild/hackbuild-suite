// The small built in room of the agents tools (senses, drives): furniture
// and props made in code, no model file. A layout is a list of labels on
// the floor, seeded so a restart with the same seed puts every thing back.
// Framework free and three free; positions come from the injected stream
// only, no trig, so a layout is the same on every engine.

export type PropKind = 'prop' | 'furniture'
export type PropShape = 'box' | 'cyl' | 'ball'

export interface PropDef {
  label: string
  kind: PropKind
  shape: PropShape
  /** Width, height, depth in meters (a cylinder and a ball read width as the diameter). */
  w: number
  h: number
  d: number
  /** Fallback colour; the view tints from the theme where it can. */
  color: string
  /** The thing gives off a scent the nose can follow. */
  scent?: boolean
}

export const PROPS: readonly PropDef[] = [
  { label: 'shelf', kind: 'furniture', shape: 'box', w: 0.9, h: 1.4, d: 0.35, color: '#b9925a' },
  { label: 'table', kind: 'furniture', shape: 'box', w: 1, h: 0.72, d: 0.6, color: '#8c6a43' },
  { label: 'chair', kind: 'furniture', shape: 'box', w: 0.45, h: 0.9, d: 0.45, color: '#5d7b8c' },
  { label: 'bed', kind: 'furniture', shape: 'box', w: 0.9, h: 0.25, d: 0.6, color: '#7a6fa8' },
  { label: 'door', kind: 'furniture', shape: 'box', w: 0.9, h: 2, d: 0.08, color: '#6b4b2e' },
  { label: 'mug', kind: 'prop', shape: 'cyl', w: 0.1, h: 0.12, d: 0.1, color: '#e0457b' },
  { label: 'ball', kind: 'prop', shape: 'ball', w: 0.22, h: 0.22, d: 0.22, color: '#f2c230' },
  { label: 'box', kind: 'prop', shape: 'box', w: 0.3, h: 0.3, d: 0.3, color: '#3b82f6' },
  { label: 'bowl', kind: 'prop', shape: 'cyl', w: 0.25, h: 0.08, d: 0.25, color: '#5fbf6a', scent: true },
]

export const propDef = (label: string): PropDef | undefined => PROPS.find((p) => p.label === label)

/** A thing on the floor, meters; the agent starts at the origin facing +z. */
export interface Placed {
  label: string
  x: number
  z: number
  /** Turn about the vertical, radians; none for the room props. */
  turn?: number
}

/** Size a sighting reads: the largest side, meters. */
export const sizeOf = (d: PropDef) => Math.max(d.w, d.h, d.d)

/** The things stay inside this square half side, meters (inside the stage reach of 5). */
export const ROOM = 4

const r2 = (v: number) => Math.round(v * 100) / 100

/**
 * Seeded spots for the labels: a draw in the room square, kept 1.2 m from
 * the start and 0.9 m from the things placed before it. After 40 tries a
 * thing takes its last draw.
 */
export function seededLayout(rng: () => number, labels: readonly string[]): Placed[] {
  const out: Placed[] = []
  for (const label of labels) {
    let x = 0
    let z = 0
    for (let i = 0; i < 40; i++) {
      x = r2(-ROOM + 2 * ROOM * rng())
      z = r2(-ROOM + 2 * ROOM * rng())
      if (x * x + z * z < 1.44) continue
      if (out.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < 0.81)) continue
      break
    }
    out.push({ label, x, z })
  }
  return out
}

/** Keeps a spot inside the room square. */
export const clampRoom = (v: number) => r2(Math.max(-ROOM, Math.min(ROOM, v)))

/** FNV-1a over a string, 8 hex digits: the trace hash of the agents tools. */
export function fnv(s: string, h = 0x811c9dc5): number {
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}
export const hex8 = (h: number) => h.toString(16).padStart(8, '0')
