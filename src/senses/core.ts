// What the senses tool asks of `@hackbuild/senses` without three.js: the
// percept memory (range by size, memory that drifts with the square root
// of age), looming, and the scent plume with a two nostril sniffer. The
// field of view cone and the detector floor arrive as occlusion: a thing
// outside the cone, or under the floor in the eye's pixel count, is not
// seen. The hashed state is labels, flags, times and distances only;
// bearings (atan2) stay out of it.
import { load, Looming, OdourField, PerceptMemory, Sniffer, type Rng } from '@hackbuild/senses'
import { fnv, hex8, propDef, sizeOf, type Placed } from '../agents/props.ts'
import { EYE_Y, nearestFurniture } from './kind.ts'

export const ready = (): Promise<void> => load()

export type SenseKind = 'see' | 'lost' | 'look' | 'loom' | 'scent'
export interface SenseEvent {
  id: number
  t: number
  kind: SenseKind
  label: string
  text: string
}

export interface AgentPose {
  x: number
  z: number
  /** Facing, radians, 0 faces +z. */
  yaw: number
}

export interface Percept {
  label: string
  visible: boolean
  dist: number
  salience: number
  /** Seconds of sense time it was last seen, or null. */
  seen: number | null
  confidence: number
  /** Where memory puts it now, meters. */
  rx: number
  rz: number
}

/** A whiff counts when the sniffed concentration passes this (proposed). */
const WHIFF = 0.02

export class SenseCore {
  readonly events: SenseEvent[] = []
  percepts: Percept[] = []
  hash = 0x811c9dc5
  whiff = 0
  private mem: PerceptMemory
  private loom = new Looming()
  private field: OdourField
  private nose: Sniffer
  private was = new Map<string, boolean>()
  private sniffing = false
  private n = 0

  things: Placed[]

  constructor(rng: Rng, things: Placed[]) {
    this.things = things
    // a full sphere: the cone is the caller's, by occlusion
    this.mem = new PerceptMemory({ rng, halfFov: Math.PI })
    this.field = new OdourField({ rng, size: 12, cells: 48 })
    this.nose = new Sniffer({ rng })
  }

  private log(t: number, kind: SenseKind, label: string, text: string) {
    const e = { id: ++this.n, t, kind, label, text }
    this.events.push(e)
    if (this.events.length > 400) this.events.shift()
    this.hash = fnv(`${t.toFixed(3)}|${kind}|${label}|${text};`, this.hash)
    return e
  }

  /** Records a fixation the saliency pass made; the eye is three side. */
  look(t: number, label: string) {
    this.log(t, 'look', label, `looks at the ${label}`)
  }

  /**
   * One sense pass. `inCone` and `pixels` come from the eye (or a
   * geometric stand in); a thing under `floor` pixels is not seen.
   */
  sense(t: number, a: AgentPose, inCone: (p: Placed) => boolean, pixels: Map<string, number> | null, floor: number): SenseEvent[] {
    const out: SenseEvent[] = []
    const eye = { x: a.x, y: EYE_Y, z: a.z }
    this.percepts = this.things.map((p, i) => {
      const d = propDef(p.label)!
      const occluded = !inCone(p) || (pixels !== null && (pixels.get(p.label) ?? 0) < floor)
      const s = this.mem.sense(i, eye, a.yaw, { pos: { x: p.x, y: d.h / 2, z: p.z }, size: sizeOf(d), occluded, fixed: d.kind === 'furniture' }, 1, t)
      const was = this.was.get(p.label) ?? false
      if (s.visible && !was) out.push(this.log(t, 'see', p.label, `sees the ${p.label} at ${s.dist.toFixed(1)} m`))
      if (!s.visible && was) out.push(this.log(t, 'lost', p.label, `lost sight of the ${p.label}`))
      this.was.set(p.label, s.visible)
      if (s.visible) {
        const tau = this.loom.observe(i, sizeOf(d), s.dist, t)
        if (tau !== null) out.push(this.log(t, 'loom', p.label, `the ${p.label} looms, contact in ${tau.toFixed(2)} s`))
      } else this.loom.forget(i)
      const r = s.seen === null ? null : this.mem.recall(i, t)
      return { label: p.label, visible: s.visible, dist: s.dist, salience: s.salience, seen: s.seen, confidence: s.confidence, rx: r?.pos.x ?? p.x, rz: r?.pos.z ?? p.z }
    })
    return out
  }

  /** The plume and the nose for dt seconds; returns a scent event on a new whiff. */
  smell(dt: number, t: number, a: AgentPose): SenseEvent | null {
    const src = this.things.map((p, i) => ({ p, i })).filter(({ p }) => propDef(p.label)?.scent)
    this.field.step(dt, src.map(({ p, i }) => ({ id: i, x: p.x, z: p.z, strength: 1 })))
    const s = Math.sin(a.yaw)
    const c = Math.cos(a.yaw)
    const nose = { x: a.x + s * 0.12, z: a.z + c * 0.12 }
    this.nose.tick(this.field, dt, t, true, nose, { x: c * 0.02, z: -s * 0.02 })
    const st = this.nose.state()
    this.whiff = st.conc
    const on = st.conc > WHIFF
    let e: SenseEvent | null = null
    if (on && !this.sniffing && src.length) e = this.log(t, 'scent', src[0]!.p.label, `smells the ${src[0]!.p.label}, ${st.conc.toFixed(3)}`)
    this.sniffing = on
    return e
  }

  puffs(): Float64Array {
    return this.field.puffs()
  }
  wind() {
    return this.field.wind()
  }

  /** Things not in view that memory still holds, newest first. */
  seenEarlier(t: number): { label: string; near: string | null; ago: number; confidence: number; drift: number }[] {
    return this.percepts
      .filter((p) => !p.visible && p.seen !== null && propDef(p.label)?.kind === 'prop')
      .map((p) => {
        const real = this.things.find((x) => x.label === p.label)!
        return { label: p.label, near: nearestFurniture(this.things, p.rx, p.rz, p.label), ago: t - p.seen!, confidence: p.confidence, drift: Math.hypot(p.rx - real.x, p.rz - real.z) }
      })
      .sort((a, b) => a.ago - b.ago)
  }

  get hashHex() {
    return hex8(this.hash)
  }

  dispose() {
    this.mem.free()
    this.loom.free()
    this.field.free()
    this.nose.free()
  }
}

/** A geometric cone for a run with no eye (the tests): inside the half angle, by a dot product. */
export function coneTest(a: AgentPose, halfRad: number): (p: Placed) => boolean {
  const fx = Math.sin(a.yaw)
  const fz = Math.cos(a.yaw)
  const c = Math.cos(halfRad)
  return (p) => {
    const dx = p.x - a.x
    const dz = p.z - a.z
    const l = Math.hypot(dx, dz)
    return l > 1e-6 && (dx * fx + dz * fz) / l >= c
  }
}
