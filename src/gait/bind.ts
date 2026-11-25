// What the gait tool does with three.js: a built in quadruped made in code
// (bones and boxes, no model file), or a dropped body whose four legs
// `@hackbuild/rig` finds by name; the oscillator, body springs, tail and
// ears of `@hackbuild/gait` drive it each frame over a ground made in code.
// Feet on the ground show as discs; the run bakes into a clip. Only core
// three classes, no addon. The view imports this module on mount, so three
// and the gait core stay out of the route chunk.
import {
  BoxGeometry, CircleGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, PlaneGeometry, Vector3,
  Bone, type Object3D,
} from 'three'
import { load as loadGait, BodyDynamics, Ears, QuadrupedGait, TailWag, type BodyPose, type GaitState, type Rng } from '@hackbuild/gait'
import { driveQuadruped, measureQuadruped, type QuadrupedNames, type QuadrupedRig } from '@hackbuild/gait/three'
import { load as loadRig, limbChains, type RigNodeInput } from '@hackbuild/rig'
import { groundAt, type Terrain } from './kind.ts'

export const ready = async (): Promise<void> => { await Promise.all([loadGait(), loadRig()]) }

export const LEGS = ['LF', 'RF', 'LH', 'RH'] as const

/** The built in dog's bone names, the layout `@hackbuild/gait` tests drive. */
export const DOG_NAMES: QuadrupedNames = {
  hips: 'hips',
  spine: ['spine2', 'chest'],
  tail: ['tail1', 'tail3', 'tail_03'],
  legs: {
    LF: { up: 'frontUpr.L', mid: 'frontLeg.L_03', end: 'frontHorselink.L', toes: ['frontToe.L'] },
    RF: { up: 'frontUpr.R', mid: 'frontLeg.R_03', end: 'frontHorselink.R', toes: ['frontToe.R'] },
    LH: { up: 'rearUpr.L', mid: 'rearLwr.L', end: 'rearHorselink.L', toes: ['rearFoot.L', 'rearToe.L'] },
    RH: { up: 'rearUpr.R', mid: 'rearLwr.R', end: 'rearHorselink.R', toes: ['rearFoot.R', 'rearToe.R'] },
  },
}

/** A dog of bones and boxes, facing +z at the origin; about 0.78 m nose to tail (computed from the bone offsets). */
export function buildDog(color: string): Group {
  const root = new Group()
  root.name = 'built in dog'
  const bone = (name: string, parent: Object3D, p: [number, number, number]) => {
    const b = new Bone()
    b.name = name
    b.position.set(...p)
    parent.add(b)
    return b
  }
  const hips = bone('hips', root, [0, 0.38, 0])
  const spine = bone('spine2', hips, [0, 0, 0.1])
  const chest = bone('chest', spine, [0, 0, 0.12])
  const neck = bone('neck1', chest, [0, 0.08, 0.05])
  const head = bone('head', neck, [0, 0.08, 0.06])
  for (const [s, x] of [['L', 0.09], ['R', -0.09]] as const) {
    const fu = bone(`frontUpr.${s}`, chest, [x, 0, 0])
    const fm = bone(`frontLeg.${s}_03`, fu, [0, -0.18, -0.08])
    const fe = bone(`frontHorselink.${s}`, fm, [0, -0.16, 0.08])
    bone(`frontToe.${s}`, fe, [0, -0.02, 0.03])
    const ru = bone(`rearUpr.${s}`, hips, [x, 0, -0.2])
    const rm = bone(`rearLwr.${s}`, ru, [0, -0.17, 0.07])
    const re = bone(`rearHorselink.${s}`, rm, [0, -0.15, -0.08])
    const rf = bone(`rearFoot.${s}`, re, [0, -0.02, 0.01])
    bone(`rearToe.${s}`, rf, [0, -0.02, 0.03])
  }
  const t1 = bone('tail1', hips, [0, 0.02, -0.25])
  const t2 = bone('tail3', t1, [0, 0, -0.08])
  bone('tail_03', t2, [0, 0, -0.08])

  const mat = new MeshStandardMaterial({ color, roughness: 0.7 })
  const Z = new Vector3(0, 0, 1)
  const width = (from: string, to: string): [number, number] => {
    if (from === 'hips' && to === 'spine2') return [0.17, 0.15]
    if (from === 'spine2' && to === 'chest') return [0.18, 0.16]
    if (from === 'hips' && to.startsWith('rearUpr')) return [0.07, 0.12]
    if (from === 'chest' && to.startsWith('frontUpr')) return [0.06, 0.1]
    if (from.startsWith('tail') || to.startsWith('tail')) return [0.03, 0.03]
    if (from === 'chest' || from === 'neck1') return [0.07, 0.07]
    return [0.04, 0.04]
  }
  root.traverse((o) => {
    if (!(o instanceof Bone)) return
    for (const c of o.children) {
      if (!(c instanceof Bone)) continue
      const len = c.position.length()
      if (len < 1e-4) continue
      const [w, h] = width(o.name, c.name)
      const m = new Mesh(new BoxGeometry(w, h, len), mat)
      m.position.copy(c.position).multiplyScalar(0.5)
      m.quaternion.setFromUnitVectors(Z, c.position.clone().normalize())
      o.add(m)
    }
  })
  const skull = new Mesh(new BoxGeometry(0.11, 0.1, 0.18), mat)
  skull.position.set(0, 0.02, 0.05)
  head.add(skull)
  for (const x of [0.04, -0.04]) {
    const ear = new Mesh(new BoxGeometry(0.03, 0.07, 0.015), mat)
    ear.position.set(x, 0.08, 0)
    head.add(ear)
  }
  return root
}

/** Bones of a dropped body as rig nodes, in traversal order. */
function nodesOf(root: Object3D): { nodes: RigNodeInput[]; objs: Object3D[] } {
  const objs: Object3D[] = []
  root.traverse((o) => { if ((o as Bone).isBone) objs.push(o) })
  const index = new Map(objs.map((o, i) => [o, i]))
  return { objs, nodes: objs.map((o) => ({ name: o.name, parent: o.parent && index.has(o.parent) ? index.get(o.parent)! : null })) }
}

export interface MapReport {
  /** Legs found, of four. */
  legs: number
  tail: number
  ears: number
  bones: number
  names: QuadrupedNames | null
  missing: string[]
}

/** Four legs, the tail and the ears of a dropped body by bone name. */
export function mapQuadruped(root: Object3D): MapReport {
  const { nodes, objs } = nodesOf(root)
  const chains = nodes.length ? limbChains(nodes) : []
  const by = new Map(chains.map((c) => [c.name, c]))
  const nm = (i: number) => objs[i]!.name
  const missing: string[] = []
  const legs = {} as QuadrupedNames['legs']
  for (const id of LEGS) {
    const c = by.get(id)
    if (!c || c.bones.length < 3) { missing.push(id); continue }
    const [up, mid, end, ...toes] = c.bones.map(nm)
    legs[id] = { up: up!, mid: mid!, end: end!, toes }
  }
  const tail = by.get('tail')?.bones.map(nm) ?? []
  const ears = [by.get('earL'), by.get('earR')].filter((c) => c?.bones.length).map((c) => nm(c!.bones[0]!))
  const spine = by.get('spine')?.bones.map(nm) ?? []
  const hind = by.get('LH')
  const hipsObj = hind ? objs[hind.bones[0]!]!.parent : null
  const ok = missing.length === 0 && !!hipsObj?.name
  return {
    legs: 4 - missing.length, tail: tail.length, ears: ears.length, bones: nodes.length, missing,
    names: ok ? { hips: hipsObj!.name, legs, spine: spine.filter((n) => n !== hipsObj!.name), tail, ears: ears.length === 2 ? [ears[0]!, ears[1]!] : undefined } : null,
  }
}

export interface Colors { stance: string; swing: string; ground: string }

export interface Frame {
  state: GaitState
  body: BodyPose
  speed: number
  turnRate: number
  missed: number[]
}

/** Contact rows kept for the footfall strip. */
export const STRIP = 120
/** Bake rate, frames a second (proposed). */
export const BAKE_FPS = 30

export class GaitRig {
  readonly dog: Group
  rig: QuadrupedRig | null = null
  pose = { x: 0, z: 0, yaw: 0 }
  last: Frame | null = null
  /** Newest last: one flag per leg. */
  readonly strip: boolean[][] = []
  terrain: Terrain = 'flat'
  slope = 10
  /** Stride scale: above 1 takes longer, slower steps at the same speed. */
  stride = 1
  paceBias = 0
  private gait: QuadrupedGait | null = null
  private bodyDyn: BodyDynamics | null = null
  private tail: TailWag | null = null
  private ears: Ears | null = null
  private rng: Rng = Math.random
  private readonly ground: Mesh
  private readonly discs: Mesh[] = []
  private readonly discMat: MeshBasicMaterial
  private bakeT = 0
  private bakeRot: number[] = []
  private bakeRoot: number[] = []
  private bakeContacts: number[] = []
  private bakeBones: Object3D[] = []
  bakeSeconds = 6

  constructor(private readonly scene: Object3D, colors: Colors, dogColor: string) {
    this.dog = buildDog(dogColor)
    scene.add(this.dog)
    const g = new PlaneGeometry(12, 12, 96, 96)
    g.rotateX(-Math.PI / 2)
    this.ground = new Mesh(g, new MeshStandardMaterial({ color: colors.ground, roughness: 0.95 }))
    this.ground.name = 'gait ground'
    scene.add(this.ground)
    this.discMat = new MeshBasicMaterial({ color: colors.stance, transparent: true, opacity: 0.85, depthWrite: false })
    const dg = new CircleGeometry(0.035, 20)
    dg.rotateX(-Math.PI / 2)
    for (let i = 0; i < 4; i++) {
      const d = new Mesh(dg, this.discMat)
      d.name = `contact ${LEGS[i]}`
      d.renderOrder = 998
      scene.add(d)
      this.discs.push(d)
    }
    this.setGround('flat', 10)
  }

  heightAt = (x: number, z: number) => groundAt(this.terrain, this.slope, x, z)

  setGround(t: Terrain, slope: number): void {
    this.terrain = t
    this.slope = slope
    const pos = this.ground.geometry.attributes.position!
    for (let i = 0; i < pos.count; i++) pos.setY(i, this.heightAt(pos.getX(i), pos.getZ(i)) + 0.002)
    pos.needsUpdate = true
    this.ground.geometry.computeVertexNormals()
    this.ground.visible = t !== 'flat'
  }

  /** Drives a body: the built in dog, or a dropped one by its mapped names. Throws with words. */
  setRig(root: Object3D, names: QuadrupedNames): void {
    const p = root.position.clone()
    const q = root.quaternion.clone()
    root.position.set(0, 0, 0)
    root.quaternion.identity()
    root.updateMatrixWorld(true)
    try {
      this.rig = measureQuadruped(root, names)
    } finally {
      root.position.copy(p)
      root.quaternion.copy(q)
    }
    this.bakeBones = [...this.rig.rest.keys()].filter((o) => (o as Bone).isBone)
    this.dog.visible = root === this.dog
    this.restart(this.rng)
  }

  restart(rng: Rng): void {
    this.rng = rng
    const r = this.rig
    if (!r) return
    this.gait?.dispose()
    this.bodyDyn?.dispose()
    this.tail?.dispose()
    this.ears?.dispose()
    this.gait = new QuadrupedGait(r.specs, r.legLength, { ground: this.heightAt, rng, paceBias: this.paceBias })
    this.bodyDyn = new BodyDynamics(r.geometry, rng)
    this.tail = new TailWag(Math.max(1, r.tail.length), 0.06, rng)
    this.ears = new Ears()
    this.pose = { x: 0, z: 0, yaw: 0 }
    this.gait.reset(0, 0, 0)
    this.strip.length = 0
    this.clearBake()
  }

  clearBake(): void {
    this.bakeT = 0
    this.bakeRot = []
    this.bakeRoot = []
    this.bakeContacts = []
  }

  get legLength(): number {
    return this.rig?.legLength ?? 0.38
  }

  /** One frame at a speed and turn rate. */
  step(dt: number, speed: number, turnRate: number): Frame | null {
    const r = this.rig
    const g = this.gait
    const b = this.bodyDyn
    if (!r || !g || !b || dt <= 0) return this.last
    const p = this.pose
    p.yaw += turnRate * dt
    p.x += Math.sin(p.yaw) * speed * dt
    p.z += Math.cos(p.yaw) * speed * dt
    // the oscillator runs on a clock slowed by the stride scale; the body
    // covers the same ground, so each step is longer and planted feet hold
    const c = 1 / this.stride
    const cmd = { speed, turnRate }
    const s = g.update(dt * c, p, { speed: speed / c, turnRate: turnRate / c })
    const under = g.nominal(p.x, p.z, p.yaw).map(([x, z]) => this.heightAt(x, z))
    const body = b.update(dt, s, cmd, under)
    g.setOffsets(body.legOffsets)
    const tail = this.tail!.update(dt, { modeWeights: [1, 2, 1, 1, 0, 0, 0, 1], arousal: 0.4, turnRate })
    const ears = this.ears!.update(dt, 0.4, 0, turnRate, 0, s.standing ? 0 : 0.3)
    const missed = driveQuadruped(r, p, s, body, { tail, ears })
    s.feet.forEach((f, i) => {
      const d = this.discs[i]!
      d.visible = f.stance
      d.position.set(f.x, this.heightAt(f.x, f.z) + 0.004, f.z)
    })
    this.strip.push(s.feet.map((f) => f.stance))
    if (this.strip.length > STRIP) this.strip.shift()
    this.bake(dt, s)
    this.last = { state: s, body, speed, turnRate, missed }
    return this.last
  }

  private bake(dt: number, s: GaitState): void {
    this.bakeT += dt
    if (this.bakeT < 1 / BAKE_FPS && this.bakeRoot.length) return
    this.bakeT = 0
    const root = this.rig!.root
    for (const o of this.bakeBones) this.bakeRot.push(o.quaternion.x, o.quaternion.y, o.quaternion.z, o.quaternion.w)
    this.bakeRoot.push(root.position.x, root.position.y, root.position.z, this.pose.yaw)
    for (const f of s.feet) this.bakeContacts.push(f.stance ? 1 : 0)
    const max = Math.round(this.bakeSeconds * BAKE_FPS)
    const over = this.bakeRoot.length / 4 - max
    if (over > 0) {
      this.bakeRot.splice(0, over * this.bakeBones.length * 4)
      this.bakeRoot.splice(0, over * 4)
      this.bakeContacts.splice(0, over * 4)
    }
  }

  /** The baked run so far: bone names, rotations, root track and contacts. */
  baked(): { bones: string[]; rotations: number[]; root: number[]; contacts: number[]; frames: number } {
    return { bones: this.bakeBones.map((o) => o.name), rotations: [...this.bakeRot], root: [...this.bakeRoot], contacts: [...this.bakeContacts], frames: this.bakeRoot.length / 4 }
  }

  dispose(): void {
    this.gait?.dispose()
    this.bodyDyn?.dispose()
    this.tail?.dispose()
    this.ears?.dispose()
    this.dog.removeFromParent()
    this.ground.removeFromParent()
    this.ground.geometry.dispose()
    ;(this.ground.material as MeshStandardMaterial).dispose()
    for (const d of this.discs) d.removeFromParent()
    this.discs[0]?.geometry.dispose()
    this.discMat.dispose()
    this.dog.traverse((o) => { if (o instanceof Mesh) o.geometry.dispose() })
  }
}
