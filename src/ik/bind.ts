// What the ik tool does with three.js: targets on the stage for both hands,
// both feet, the hips and the look, dragged by touch or mouse; after the
// body's own pose each frame the hips move to their target, planted feet
// hold through a foot lock, arms and legs solve toward their targets with
// the chosen solver, and the neck and head turn to the look target. Only
// core three classes the stage already uses: the drag ray is worked out by
// hand, no addon. The view imports this module on mount, so three.js and
// the ik core stay out of the route chunk.
import { Mesh, MeshBasicMaterial, Quaternion, SphereGeometry, Vector3, type Object3D } from 'three'
import { load as loadIk, pelvisDrop } from '@hackbuild/ik'
import { FootLock, lookAtChain, solveChain, solveTwoBone } from '@hackbuild/ik/three'
import type { AvatarStage } from '@hackbuild/avatar-host/three'
import { TARGETS, type IkBody, type Solver, type TargetId, type Vec3 } from './kind.ts'

export const ready = (): Promise<void> => loadIk()

interface Limb {
  target: TargetId
  bones: [string, string, string]
  pole: Vector3
}
const LIMBS: Limb[] = [
  { target: 'leftHand', bones: ['leftUpperArm', 'leftLowerArm', 'leftHand'], pole: new Vector3(0, -0.4, -1) },
  { target: 'rightHand', bones: ['rightUpperArm', 'rightLowerArm', 'rightHand'], pole: new Vector3(0, -0.4, -1) },
  { target: 'leftFoot', bones: ['leftUpperLeg', 'leftLowerLeg', 'leftFoot'], pole: new Vector3(0, 0, 1) },
  { target: 'rightFoot', bones: ['rightUpperLeg', 'rightLowerLeg', 'rightFoot'], pole: new Vector3(0, 0, 1) },
]
const isFoot = (id: TargetId) => id === 'leftFoot' || id === 'rightFoot'

export interface ChainInfo {
  /** Root joint to target, meters. */
  dist: number
  /** Bone lengths summed, meters. */
  reach: number
  /** End joint to target after the solve, meters. */
  error: number
}

export interface Colors { pinned: string; free: string; look: string }

interface Target {
  pos: Vector3
  pinned: boolean
  marker: Mesh
}

const v = (a: Vector3): Vec3 => [a.x, a.y, a.z]

export class IkRig {
  readonly targets = new Map<TargetId, Target>()
  readonly info = new Map<TargetId, ChainInfo>()
  opts: Pick<IkBody, 'solver' | 'plant' | 'look'> = { solver: 'two bone', plant: true, look: true }
  selected: TargetId = 'leftHand'
  dragging: TargetId | null = null
  /** Set when a drag ends; the view saves the targets then. */
  onDrop: ((id: TargetId) => void) | null = null
  private locks: Record<'leftFoot' | 'rightFoot', FootLock> = { leftFoot: new FootLock(), rightFoot: new FootLock() }
  private bones: Partial<Record<string, Object3D>> = {}
  private ankleY = 0
  private prevYaw = 0
  private fresh = true
  private readonly mats: Record<'pinned' | 'free' | 'look', MeshBasicMaterial>
  private readonly geo = new SphereGeometry(0.035, 16, 12)
  private readonly tmp = new Vector3()
  private readonly tmp2 = new Vector3()
  private readonly q = new Quaternion()
  private readonly off: () => void

  constructor(private readonly stage: AvatarStage, colors: Colors, private readonly coarse: () => boolean) {
    const mat = (c: string) => new MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.9 })
    this.mats = { pinned: mat(colors.pinned), free: mat(colors.free), look: mat(colors.look) }
    for (const id of TARGETS) {
      const marker = new Mesh(this.geo, id === 'look' ? this.mats.look : this.mats.free)
      marker.name = `ik ${id}`
      marker.renderOrder = 999
      stage.scene.add(marker)
      this.targets.set(id, { pos: new Vector3(), pinned: false, marker })
    }
    this.off = this.listen()
  }

  /** Takes the body on the stage: its bones and the ankle height on the floor. */
  setBody(): void {
    const b = this.stage.body
    this.bones = (b?.avatar.bones ?? {}) as Partial<Record<string, Object3D>>
    b?.avatar.root.updateMatrixWorld(true)
    const foot = this.bones.leftFoot
    this.ankleY = foot ? foot.getWorldPosition(this.tmp).y : 0.06
    this.fresh = true
    for (const t of this.targets.values()) t.pinned = false
  }

  /** Puts saved targets back: a pinned target with a place holds it. */
  restore(saved: IkBody['targets']): void {
    for (const id of TARGETS) {
      const s = saved[id]
      const t = this.targets.get(id)!
      if (s.pos) t.pos.fromArray(s.pos)
      t.pinned = s.pinned && !!s.pos
    }
  }

  snapshot(): IkBody['targets'] {
    const out = {} as IkBody['targets']
    for (const id of TARGETS) {
      const t = this.targets.get(id)!
      out[id] = { pos: v(t.pos), pinned: t.pinned }
    }
    return out
  }

  pin(id: TargetId, on: boolean): void {
    this.targets.get(id)!.pinned = on
    this.stage.loop.invalidate()
  }

  /** Moves a target to a world point and pins it. */
  place(id: TargetId, p: Vector3 | Vec3): void {
    const t = this.targets.get(id)!
    if (Array.isArray(p)) t.pos.fromArray(p)
    else t.pos.copy(p)
    if (isFoot(id) && t.pos.y < this.ankleY) t.pos.y = this.ankleY
    t.pinned = true
    this.stage.loop.invalidate()
  }

  private bone(n: string) {
    return this.bones[n]
  }
  private world(n: string, out = new Vector3()) {
    return this.bone(n)?.getWorldPosition(out) ?? out.set(0, 0, 0)
  }

  /** One frame, after the body's pose. */
  solve(dt: number): void {
    const root = this.stage.body?.avatar.root
    const hips = this.bone('hips')
    if (!root || !hips) return
    root.updateMatrixWorld(true)
    root.getWorldQuaternion(this.q)
    const T = (id: TargetId) => this.targets.get(id)!

    // released targets start where the pose puts them
    if (this.fresh) {
      for (const l of LIMBS) if (!T(l.target).pinned) this.world(l.bones[2], T(l.target).pos)
      if (!T('hips').pinned) this.world('hips', T('hips').pos)
      if (!T('look').pinned) this.world('head', T('look').pos).add(this.tmp.set(0, 0.05, 0.6).applyQuaternion(this.q))
      this.fresh = false
    }

    // the hips, then down far enough that a planted foot stays in reach
    const ht = T('hips')
    if (ht.pinned && hips.parent) {
      hips.position.copy(hips.parent.worldToLocal(this.tmp.copy(ht.pos)))
      hips.updateMatrixWorld(true)
    }
    if (this.opts.plant) {
      let drop = 0
      for (const id of ['leftFoot', 'rightFoot'] as const) {
        const l = LIMBS.find((x) => x.target === id)!
        const reach = this.length(l) * 0.999
        const top = this.world(l.bones[0])
        drop = Math.max(drop, pelvisDrop(v(top), v(T(id).pos), reach))
      }
      if (drop > 0 && hips.parent) {
        const w = this.world('hips', this.tmp2).addScaledVector(this.tmp.set(0, 1, 0), -drop)
        hips.position.copy(hips.parent.worldToLocal(w))
        hips.updateMatrixWorld(true)
      }
    }
    if (!ht.pinned) this.world('hips', ht.pos)

    // the look: neck and head share the turn
    const neck = this.bone('neck')
    const head = this.bone('head')
    const body = this.stage.body
    if (body) body.gazeOn = !(this.opts.look && T('look').pinned)
    if (this.opts.look && T('look').pinned && head) {
      const chain = neck ? [neck, head] : [head]
      const r = lookAtChain(chain, neck ? [0.4, 0.6] : [1], T('look').pos, this.q, undefined, 1, this.prevYaw)
      this.prevYaw = r.yaw + r.bodyYaw
    }

    // limbs
    for (const l of LIMBS) {
      const t = T(l.target)
      const [a, b, c] = l.bones.map((n) => this.bone(n))
      if (!a || !b || !c) continue
      const foot = isFoot(l.target)
      if (foot && this.opts.plant) {
        if (!t.pinned) this.world(l.bones[2], t.pos)
        if (t.pos.y < this.ankleY + 0.002) t.pos.y = this.ankleY
        const lock = this.locks[l.target as 'leftFoot' | 'rightFoot']
        const contact = this.dragging === l.target ? 0 : t.pos.y - this.ankleY < 0.03 ? 1 : 0
        lock.update(dt, t.pos, contact)
      } else if (!t.pinned) {
        this.world(l.bones[2], t.pos)
        this.info.set(l.target, { dist: 0, reach: this.length(l), error: 0 })
        continue
      }
      this.limb(l, a, b, c, t.pos)
    }
    root.updateMatrixWorld(true)

    for (const l of LIMBS) {
      const t = T(l.target)
      const dist = this.world(l.bones[0]).distanceTo(t.pos)
      this.info.set(l.target, { dist, reach: this.length(l), error: this.world(l.bones[2]).distanceTo(t.pos) })
    }
    for (const [id, t] of this.targets) {
      t.marker.position.copy(t.pos)
      t.marker.material = id === 'look' ? this.mats.look : t.pinned ? this.mats.pinned : this.mats.free
      t.marker.scale.setScalar((id === this.selected ? 1.35 : 1) * (this.coarse() ? 1.3 : 1))
      t.marker.visible = id !== 'look' || this.opts.look
    }
  }

  private limb(l: Limb, a: Object3D, b: Object3D, c: Object3D, target: Vector3) {
    const s: Solver = this.opts.solver
    if (s === 'two bone') solveTwoBone(a, b, c, target, this.tmp.copy(l.pole).applyQuaternion(this.q))
    else solveChain([a, b, c], target, { method: s, iterations: 24 })
  }

  private length(l: Limb): number {
    const [a, b, c] = l.bones.map((n) => this.world(n))
    return a!.distanceTo(b!) + b!.distanceTo(c!)
  }

  /** Where a target shows on the page, client pixels. */
  screenOf(id: TargetId): { x: number; y: number } {
    const r = this.stage.canvas.getBoundingClientRect()
    const p = this.tmp.copy(this.targets.get(id)!.pos).project(this.stage.camera)
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height }
  }

  /** The nearest visible target within a finger's or a pointer's reach of a client point. */
  pick(x: number, y: number): TargetId | null {
    const radius = this.coarse() ? 30 : 18
    let best: TargetId | null = null
    let bestD = radius
    for (const [id, t] of this.targets) {
      if (!t.marker.visible) continue
      const s = this.screenOf(id)
      const d = Math.hypot(s.x - x, s.y - y)
      if (d < bestD) { bestD = d; best = id }
    }
    return best
  }

  /** The point under a client point on the plane facing the camera through `through`. */
  private onPlane(x: number, y: number, through: Vector3, out: Vector3): Vector3 | null {
    const cam = this.stage.camera
    const r = this.stage.canvas.getBoundingClientRect()
    const o = cam.getWorldPosition(this.tmp2)
    const d = this.tmp.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1, 0.5).unproject(cam).sub(o).normalize()
    const n = cam.getWorldDirection(new Vector3())
    const den = n.dot(d)
    if (Math.abs(den) < 1e-6) return null
    const s = n.dot(new Vector3().subVectors(through, o)) / den
    return s > 0 ? out.copy(o).addScaledVector(d, s) : null
  }

  /** Pointer drag: a press on a target takes it from the orbit controls. */
  private listen(): () => void {
    const host = this.stage.canvas.parentElement ?? this.stage.canvas
    const plane = new Vector3()
    const hit = new Vector3()
    let pointer = -1
    const down = (e: PointerEvent) => {
      if (pointer >= 0 || e.button > 0) return
      const id = this.pick(e.clientX, e.clientY)
      if (!id) return
      e.stopPropagation()
      e.preventDefault()
      pointer = e.pointerId
      this.dragging = id
      this.selected = id
      plane.copy(this.targets.get(id)!.pos)
      this.stage.controls.enabled = false
      this.stage.loop.invalidate()
    }
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointer || !this.dragging) return
      if (this.onPlane(e.clientX, e.clientY, plane, hit)) this.place(this.dragging, hit)
    }
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return
      const id = this.dragging
      pointer = -1
      this.dragging = null
      this.stage.controls.enabled = true
      this.stage.loop.invalidate()
      if (id) this.onDrop?.(id)
    }
    host.addEventListener('pointerdown', down, { capture: true })
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      host.removeEventListener('pointerdown', down, { capture: true })
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }

  /** Local rotations by human bone and the hips position, for the pose file. */
  pose(): { rotations: Record<string, number[]>; hips: number[] } {
    const rotations: Record<string, number[]> = {}
    for (const [n, b] of Object.entries(this.bones)) if (b) rotations[n] = b.quaternion.toArray()
    return { rotations, hips: this.bone('hips')?.position.toArray() ?? [0, 0, 0] }
  }

  /** A bone's world position, for the smoke and the rack. */
  where(n: string): Vec3 {
    return v(this.world(n))
  }

  dispose(): void {
    this.off()
    for (const t of this.targets.values()) t.marker.removeFromParent()
    this.geo.dispose()
    for (const m of Object.values(this.mats)) m.dispose()
    this.locks.leftFoot.dispose()
    this.locks.rightFoot.dispose()
  }
}
