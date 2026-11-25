// What the motion-match tool does with three.js: a clip set made in code,
// a matcher over it, and the matched pose on the body on the stage (the
// mannequin, or a dropped humanoid): the root follows the matcher, the hips
// take the clip's height and sway, and the legs reach the clip's feet with
// two bone ik. The desired trajectory and the matched frame's own future
// trajectory draw on the floor, feet in contact as discs. Per clip costs are
// worked out in the page from the matcher's feature rows: the query is the
// current frame's pose features plus the desired trajectory, normalized by
// a line fit of the database's own trajectory features. Core three only.
import { BufferGeometry, CircleGeometry, Float32BufferAttribute, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3, type Object3D } from 'three'
import { load as loadMm, ClipSet, DEFAULT_CONFIG, DEFAULT_PARAMS, MotionMatcher, type MatchConfig, type MatchFrame, type MatcherParams } from '@hackbuild/motion-match'
import { load as loadIk } from '@hackbuild/ik'
import { solveTwoBone } from '@hackbuild/ik/three'
import type { AvatarStage } from '@hackbuild/avatar-host/three'
import { BUILTIN_CLIPS, fitLine, relative, toWorld, type BuiltinClip, type Root2 } from './kind.ts'

export const ready = async (): Promise<void> => { await Promise.all([loadMm(), loadIk()]) }

export const FPS = 30
/** Hip height of the synthetic clips, meters (vendor: synth.rs). */
const CLIP_HIPS = 0.9
const UP = new Vector3(0, 1, 0)

export interface Candidate {
  clip: string
  /** Frame of the clip's cheapest frame. */
  frame: number
  /** Its cost against the query, computed in the page. */
  cost: number
}

export interface Colors { want: string; match: string; contact: string }

export interface Tuning {
  weights: MatchConfig['weights']
  params: MatcherParams
}

export const defaultTuning = (): Tuning => ({ weights: { ...DEFAULT_CONFIG.weights }, params: { ...DEFAULT_PARAMS } })

interface Db {
  set: ClipSet
  mm: MotionMatcher
  clips: BuiltinClip[]
  frames: number[]
  starts: number[]
  roots: Root2[][]
  rows: Float64Array
  dims: number
  /** Offset of the trajectory dims in a row. */
  o: number
  nt: number
  searchable: Uint8Array
  /** Normalization of each trajectory dim: norm = a raw + b. */
  fit: { a: number; b: number }[]
}

function buildDb(clips: BuiltinClip[], t: Tuning): Db {
  const set = new ClipSet(FPS)
  for (const c of clips) set.addSynthetic({ speed: c.speed, speedEnd: c.speedEnd, turnRate: c.turnRate ?? 0, strides: c.strides ?? 3 })
  const mm = new MotionMatcher(set, { config: { weights: t.weights }, params: t.params, capabilities: { turnInPlace: true } })
  const frames = set.frames()
  const starts: number[] = []
  let acc = 0
  for (const n of frames) { starts.push(acc); acc += n }
  const dims = mm.dims
  const rows = new Float64Array(acc * dims)
  for (let i = 0; i < acc; i++) rows.set(mm.featureRow(i), i * dims)
  const feet = mm.core.feet
  const o = 6 * feet + 3
  const trajTimes = DEFAULT_CONFIG.trajTimes
  const nt = trajTimes.length
  const df = trajTimes.map((s) => Math.max(1, Math.round(s * FPS)))
  const maxF = Math.max(...df)
  const roots: Root2[][] = []
  const searchable = new Uint8Array(acc)
  const xs: number[][] = Array.from({ length: 4 * nt }, () => [])
  const ys: number[][] = Array.from({ length: 4 * nt }, () => [])
  clips.forEach((c, k) => {
    const n = frames[k]!
    const d = set.core.clipData(k)
    const r: Root2[] = []
    for (let f = 0; f < n; f++) r.push({ x: d[f * 3]!, z: d[f * 3 + 1]!, yaw: d[f * 3 + 2]! })
    roots.push(r)
    // every synthetic clip here loops when its speed holds, as addSynthetic decides
    const looped = c.speedEnd === undefined || c.speedEnd === c.speed
    for (let f = 0; f < n; f++) {
      searchable[starts[k]! + f] = looped || f + maxF < n ? 1 : 0
      if (f + maxF >= n) continue
      df.forEach((j, ti) => {
        const l = relative(r[f]!, r[f + j]!)
        const raw = [l.x, l.z, Math.sin(l.yaw), Math.cos(l.yaw)]
        const dimsAt = [2 * ti, 2 * ti + 1, 2 * nt + 2 * ti, 2 * nt + 2 * ti + 1]
        dimsAt.forEach((dd, q) => { xs[dd]!.push(raw[q]!); ys[dd]!.push(rows[(starts[k]! + f) * dims + o + dd]!) })
      })
    }
  })
  const fit = xs.map((x, d) => fitLine(x, ys[d]!))
  return { set, mm, clips, frames, starts, roots, rows, dims, o, nt, searchable, fit }
}

export class MatchRig {
  db: Db | null = null
  last: MatchFrame | null = null
  want: Float64Array = new Float64Array(0)
  contacts: boolean[] = [true, true]
  private bones: Partial<Record<string, Object3D>> = {}
  private hipsRest = new Quaternion()
  private hipScale = 1
  private ankleY = 0.06
  private readonly wantLine: Line
  private readonly matchLine: Line
  private readonly discs: Mesh[] = []
  private readonly dots: Mesh[] = []
  private readonly mats: MeshBasicMaterial[] = []
  private readonly tmp = new Vector3()
  private readonly tmp2 = new Vector3()
  private readonly q = new Quaternion()
  showWant = true
  showMatch = true

  constructor(private readonly stage: AvatarStage, colors: Colors) {
    const line = (c: string) => {
      const g = new BufferGeometry()
      g.setAttribute('position', new Float32BufferAttribute(new Float32Array(12), 3))
      const l = new Line(g, new LineBasicMaterial({ color: c, depthTest: false, transparent: true }))
      l.renderOrder = 997
      l.frustumCulled = false
      stage.scene.add(l)
      return l
    }
    this.wantLine = line(colors.want)
    this.matchLine = line(colors.match)
    const dotGeo = new SphereGeometry(0.03, 12, 8)
    for (const c of [colors.want, colors.match]) {
      const m = new MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.9 })
      this.mats.push(m)
      for (let i = 0; i < 3; i++) {
        const d = new Mesh(dotGeo, m)
        d.renderOrder = 998
        stage.scene.add(d)
        this.dots.push(d)
      }
    }
    const disc = new CircleGeometry(0.05, 20)
    disc.rotateX(-Math.PI / 2)
    const dm = new MeshBasicMaterial({ color: colors.contact, transparent: true, opacity: 0.85, depthWrite: false })
    this.mats.push(dm)
    for (let i = 0; i < 2; i++) {
      const d = new Mesh(disc, dm)
      d.renderOrder = 996
      stage.scene.add(d)
      this.discs.push(d)
    }
  }

  /** Builds the database from the clips that are on, and a fresh matcher. */
  build(clips: BuiltinClip[], t: Tuning): void {
    this.db?.mm.dispose()
    this.db?.set.dispose()
    this.db = clips.length ? buildDb(clips, t) : null
    this.last = null
  }

  /** Takes the body on the stage: its leg bones, the hips rest and height. */
  setBody(): void {
    const b = this.stage.body
    this.bones = (b?.avatar.bones ?? {}) as Partial<Record<string, Object3D>>
    const root = b?.avatar.root
    if (!root) return
    root.position.set(0, 0, 0)
    root.rotation.set(0, 0, 0)
    root.updateMatrixWorld(true)
    const hips = this.bones.hips
    if (hips) {
      this.hipsRest.copy(hips.quaternion)
      this.hipScale = hips.getWorldPosition(this.tmp).y / CLIP_HIPS || 1
    }
    const foot = this.bones.leftFoot
    this.ankleY = foot ? foot.getWorldPosition(this.tmp).y : 0.06
  }

  /** One frame toward a speed and turn rate. */
  step(dt: number, speed: number, turnRate: number): MatchFrame | null {
    const db = this.db
    if (!db || dt <= 0) return this.last
    this.want = db.mm.trajectory(speed, turnRate)
    const f = db.mm.step(dt, this.want)
    this.last = f
    this.contacts = db.mm.motorState().contacts
    this.pose(f)
    this.overlays(f)
    return f
  }

  private pose(f: MatchFrame): void {
    const root = this.stage.body?.avatar.root
    const hips = this.bones.hips
    if (!root || !hips) return
    const p = this.db!.mm.pose()
    root.position.set(f.x, 0, f.z)
    root.rotation.set(0, f.yaw, 0)
    root.updateMatrixWorld(true)
    const at = (x: number, y: number, z: number, out: Vector3) => out.set(x, y, z).applyAxisAngle(UP, f.yaw).add(this.tmp2.set(f.x, 0, f.z))
    if (hips.parent) {
      at(p.hips[0], p.hips[1] * this.hipScale, p.hips[2], this.tmp)
      hips.position.copy(hips.parent.worldToLocal(this.tmp))
    }
    this.q.fromArray(p.rotations, 0)
    hips.quaternion.copy(this.hipsRest).premultiply(this.q)
    hips.updateMatrixWorld(true)
    const pole = new Vector3(0, 0, 1).applyAxisAngle(UP, f.yaw)
    ;(['left', 'right'] as const).forEach((side, k) => {
      const a = this.bones[`${side}UpperLeg`]
      const b = this.bones[`${side}LowerLeg`]
      const c = this.bones[`${side}Foot`]
      const ft = p.feet[k]
      if (!a || !b || !c || !ft) return
      const target = at(ft[0], ft[1] + this.ankleY, ft[2], new Vector3())
      solveTwoBone(a, b, c, target, pole)
      const d = this.discs[k]!
      d.visible = !!this.contacts[k]
      d.position.set(target.x, 0.004, target.z)
    })
    root.updateMatrixWorld(true)
  }

  /** World points of a local trajectory (x z per time) from the current root. */
  private points(local: ArrayLike<number>, f: MatchFrame): Vector3[] {
    const r = { x: f.x, z: f.z, yaw: f.yaw }
    const out = [new Vector3(f.x, 0.01, f.z)]
    for (let t = 0; t < this.db!.nt; t++) {
      const w = toWorld(r, local[2 * t]!, local[2 * t + 1]!)
      out.push(new Vector3(w.x, 0.01, w.z))
    }
    return out
  }

  /** The matched frame's own future trajectory, read back from its feature row. */
  matchedTrajectory(): number[] {
    const db = this.db!
    const row = db.rows.subarray(this.index() * db.dims + db.o)
    return Array.from({ length: 2 * db.nt }, (_, d) => (db.fit[d]!.a ? (row[d]! - db.fit[d]!.b) / db.fit[d]!.a : 0))
  }

  private overlays(f: MatchFrame): void {
    const set = (l: Line, pts: Vector3[], on: boolean, dots: Mesh[]) => {
      const a = l.geometry.attributes.position as Float32BufferAttribute
      pts.forEach((p, i) => a.setXYZ(i, p.x, p.y, p.z))
      a.needsUpdate = true
      l.visible = on
      dots.forEach((d, i) => { d.visible = on; d.position.copy(pts[i + 1]!) })
    }
    set(this.wantLine, this.points(this.want, f), this.showWant, this.dots.slice(0, 3))
    set(this.matchLine, this.points(this.matchedTrajectory(), f), this.showMatch, this.dots.slice(3))
  }

  /** Global index of the current frame. */
  index(): number {
    const db = this.db!
    const f = this.last
    if (!f) return 0
    const n = db.frames[f.clip]!
    return db.starts[f.clip]! + (((Math.floor(f.frame) % n) + n) % n)
  }

  /** The query the matcher searches with now: pose features of the current frame, then the desired trajectory. */
  query(): Float64Array {
    const db = this.db!
    const q = new Float64Array(db.dims)
    q.set(db.rows.subarray(this.index() * db.dims, this.index() * db.dims + db.o))
    for (let d = 0; d < 4 * db.nt; d++) q[db.o + d] = db.fit[d]!.a * (this.want[d] ?? 0) + db.fit[d]!.b
    return q
  }

  /** Each clip's cheapest frame against the query, computed here; and the matcher's own brute search of the same query. */
  candidates(): { list: Candidate[]; brute: { index: number; cost: number }; best: number } {
    const db = this.db!
    const q = this.query()
    let best = Infinity
    const list = db.clips.map((c, k) => {
      let cost = Infinity
      let frame = 0
      for (let f = 0; f < db.frames[k]!; f++) {
        const i = db.starts[k]! + f
        if (!db.searchable[i]) continue
        let s = 0
        for (let d = 0; d < db.dims; d++) { const e = db.rows[i * db.dims + d]! - q[d]!; s += e * e }
        if (s < cost) { cost = s; frame = f }
      }
      best = Math.min(best, cost)
      return { clip: c.name, frame, cost }
    })
    return { list, brute: db.mm.search(q, true), best }
  }

  clipName(i: number): string {
    return this.db?.clips[i]?.name ?? 'none'
  }

  dispose(): void {
    this.db?.mm.dispose()
    this.db?.set.dispose()
    this.db = null
    for (const o of [this.wantLine, this.matchLine, ...this.dots, ...this.discs]) o.removeFromParent()
    this.wantLine.geometry.dispose()
    this.matchLine.geometry.dispose()
    ;(this.wantLine.material as LineBasicMaterial).dispose()
    ;(this.matchLine.material as LineBasicMaterial).dispose()
    this.dots[0]?.geometry.dispose()
    this.discs[0]?.geometry.dispose()
    for (const m of this.mats) m.dispose()
  }
}

export { BUILTIN_CLIPS }
