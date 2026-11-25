// The camera rigs of `@hackbuild/cameras` on the walking stage: follow,
// orbit, first person and group drive the stage camera; split draws two
// viewports with the renderer's own scissor (no addon), one follow camera
// for each target; shake adds a seeded offset that decays. The rig takes
// over the stage camera by wrapping this renderer's render for the stage
// camera only, so the eye and every other render target pass through.
// Core three classes only.
import {
  CylinderGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, Raycaster, SphereGeometry, Vector2, Vector3,
  type Camera, type Object3D, type Scene, type WebGLRenderer,
} from 'three'
import { FirstPerson, Follow, Group, Orbit, Shake, splitViewports, type V3 } from '@hackbuild/cameras'
import type { Rng } from '@hackbuild/organic'
import type { AvatarStage } from '@hackbuild/avatar-host/three'
import { Room } from '../agents/scene.ts'
import type { Placed } from '../agents/props.ts'
import type { Rig } from './kind.ts'

export { screenOf } from '../agents/scene.ts'

/** Height the group frames each target at, meters (inferred, the chest). */
const CHEST = 0.9

export class CameraRig {
  rig: Rig = 'follow'
  split = false
  second = true
  /** Viewports drawn by the last frame of the stage camera. */
  drawn = 0
  /** Shake offset of the last frame, meters. */
  offset: V3 = { x: 0, y: 0, z: 0 }
  readonly room: Room
  readonly friend: Mesh
  readonly follow: Follow
  readonly orbit: Orbit
  readonly fp: FirstPerson
  readonly group: Group
  shake: Shake
  private cam2 = new PerspectiveCamera(50, 1, 0.05, 200)
  private follow2: Follow
  private ray = new Raycaster()
  private v = new Vector3()
  private size = new Vector2()
  private last = 0
  private base: WebGLRenderer['render']
  private stage: AvatarStage
  private target2: V3 = { x: 0, y: 0, z: 0 }
  private heading2 = 0
  private snap = true

  constructor(stage: AvatarStage, things: readonly Placed[], rng: Rng, tone: string) {
    this.stage = stage
    const cam = stage.camera
    this.room = new Room(stage.scene, things)
    this.friend = new Mesh(new CylinderGeometry(0.25, 0.25, 1.7, 16), new MeshStandardMaterial({ color: tone, roughness: 0.6 }))
    const nose = new Mesh(new SphereGeometry(0.08, 12, 8), new MeshStandardMaterial({ color: '#111111' }))
    nose.position.set(0, 0.6, 0.24)
    this.friend.add(nose)
    this.friend.name = 'second target'
    stage.scene.add(this.friend)
    const clear = (from: V3, dir: V3, max: number) => {
      this.ray.set(new Vector3(from.x, from.y, from.z), new Vector3(dir.x, dir.y, dir.z).normalize())
      this.ray.far = max
      const hit = this.ray.intersectObjects([...this.room.meshes.values()], false)[0]
      return hit ? hit.distance : max
    }
    this.follow = new Follow(cam, { distance: 3.6, pitch: 0.32, lookHeight: 1.1, clear })
    this.follow2 = new Follow(this.cam2, { distance: 3.6, pitch: 0.32, lookHeight: 0.8, clear })
    this.orbit = new Orbit(cam, 0.6, 0.45, 6, { x: 0, y: 1, z: 0 }, { minPitch: -0.2, maxPitch: 1.45, minDist: 1.2, maxDist: 16 })
    const head = stage.body?.avatar.bones.head ?? null
    this.fp = new FirstPerson(cam, head)
    this.group = new Group(cam, { pitch: 0.7, pad: 1.4, minDistance: 3, maxDistance: 20 })
    this.shake = new Shake(rng)
    stage.controls.enabled = false
    const r = stage.renderer
    this.base = r.render.bind(r)
    this.last = stage.loop.time
    r.render = (scene: Object3D, camera: Camera) => {
      if (camera !== stage.camera || r.getRenderTarget() !== null) return this.base(scene, camera)
      this.draw(scene as Scene)
    }
  }

  /** A fresh shake stream and a snap of every rig, for a restart. */
  restart(things: readonly Placed[], rng: Rng) {
    this.room.set(things)
    this.shake = new Shake(rng)
    this.snap = true
  }

  /** The second target on the floor. */
  place2(x: number, z: number, heading: number) {
    this.target2 = { x, y: 0, z }
    this.heading2 = heading
    this.friend.position.set(x, 0.85, z)
    this.friend.rotation.y = heading
    this.friend.visible = this.second
  }

  kick(amount: number) {
    this.shake.kick(amount, 1)
    this.stage.loop.invalidate()
  }

  private draw(scene: Scene) {
    const st = this.stage
    const t = st.loop.time
    const dt = Math.min(0.1, Math.max(0, t - this.last))
    this.last = t
    const cam = st.camera
    const r = st.renderer
    const root = st.body?.avatar.root
    const p: V3 = root ? { x: root.position.x, y: 0, z: root.position.z } : { x: 0, y: 0, z: 0 }
    const heading = root?.rotation.y ?? 0
    const snap = this.snap
    this.snap = false
    this.offset = this.shake.step(dt)
    r.getSize(this.size)
    const W = this.size.x
    const H = this.size.y
    if (this.split && this.second) {
      const vps = splitViewports(2, W, H)
      this.follow.update(p, heading, dt, snap)
      this.follow2.update(this.target2, this.heading2, dt, snap)
      const cams = [cam, this.cam2]
      vps.forEach((vp, i) => {
        const c = cams[i]!
        c.position.x += this.offset.x
        c.position.y += this.offset.y
        c.position.z += this.offset.z
        c.aspect = vp.w / Math.max(1, vp.h)
        c.updateProjectionMatrix()
        r.setViewport(vp.x, vp.yGl, vp.w, vp.h)
        r.setScissor(vp.x, vp.yGl, vp.w, vp.h)
        r.setScissorTest(true)
        this.base(scene, c)
      })
      r.setScissorTest(false)
      r.setViewport(0, 0, W, H)
      cam.aspect = W / Math.max(1, H)
      cam.updateProjectionMatrix()
      this.drawn = 2
      if (this.stats) this.stats()
      return
    }
    if (cam.aspect !== W / Math.max(1, H)) { cam.aspect = W / Math.max(1, H); cam.updateProjectionMatrix() }
    if (this.rig === 'follow') this.follow.update(p, heading, dt, snap)
    else if (this.rig === 'orbit') {
      this.orbit.target = { x: p.x, y: 1, z: p.z }
      this.orbit.apply()
    } else if (this.rig === 'first person') {
      const eye = st.body ? st.body.eyePosition(this.v) : this.v.set(p.x, 1.6, p.z)
      this.fp.place({ x: eye.x, y: eye.y - this.fp.up, z: eye.z }, heading, -0.12)
    } else {
      const pts: V3[] = [{ x: p.x, y: CHEST, z: p.z }]
      if (this.second) pts.push({ x: this.target2.x, y: CHEST, z: this.target2.z })
      this.group.update(pts, dt, snap)
    }
    cam.position.x += this.offset.x
    cam.position.y += this.offset.y
    cam.position.z += this.offset.z
    if (this.rig === 'first person') this.fp.render(() => this.base(scene, cam))
    else this.base(scene, cam)
    this.drawn = 1
    if (this.stats) this.stats()
  }

  /** Called after each drawn frame of the stage camera. */
  stats: (() => void) | null = null

  dispose() {
    this.stage.renderer.render = this.base
    this.stage.controls.enabled = true
    this.room.dispose()
    this.friend.removeFromParent()
    this.friend.traverse((o) => {
      const m = o as Mesh
      if (!m.isMesh) return
      m.geometry.dispose()
      ;(m.material as MeshStandardMaterial).dispose()
    })
  }
}
