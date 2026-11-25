// What the senses tool does with three.js: the room, the eye of
// `@hackbuild/senses/three` (an ID pass for the detector, a depth pass for
// the grid and the clearances, a colour frame for saliency), and the marks
// on the stage: the field of view on the floor, the gaze to the fixation,
// the scent puffs. The view imports this module on mount, so three and the
// senses core stay out of the route chunk.
import {
  BufferAttribute, BufferGeometry, CircleGeometry, DoubleSide, Line, LineBasicMaterial, Mesh, MeshBasicMaterial, Points, PointsMaterial,
  RingGeometry, Vector3, type Object3D, type Scene, type WebGLRenderer,
} from 'three'
import { OccupancyGrid, Saliency, type Rng } from '@hackbuild/senses'
import { Eye, cameraFromThree, type EyePass, type Tracked } from '@hackbuild/senses/three'
import { Room } from '../agents/scene.ts'
import type { Placed } from '../agents/props.ts'
import { EYE_PITCH, EYE_Y, FAR, type InsetMode } from './kind.ts'
import type { AgentPose } from './core.ts'

export { ready, SenseCore } from './core.ts'
export { screenOf } from '../agents/scene.ts'

/** Eye buffers (vendor prototype sizes): ids 192 by 108, depth 96 by 54; saliency colour 160 by 90 (proposed). */
const IDW = 192
const IDH = 108
const SW = 160
const SH = 90
/** Grid cells a side and cell size: a 12 m square (proposed for the room of 8 m). */
export const GRID = 120
const CELL = 0.1
/** Radius of the field of view fan on the floor, meters (proposed). */
const FAN = 3
const MAX_PUFFS = 600

/**
 * Linear to sRGB bytes. The eye renders into a render target, where three
 * writes linear colour with no tone mapping, so the frame read back is dark
 * next to the stage; the inset encodes it for display. Saliency reads the
 * frame as rendered.
 */
const SRGB = Uint8Array.from({ length: 256 }, (_, i) => {
  const c = i / 255
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055))
})

export interface Colors { cone: string; gaze: string; puff: string }

export interface SensePass {
  pixels: Map<string, number>
  seen: EyePass['visible']
  depth: Float32Array
  dw: number
  dh: number
  fixation: { label: string | null; x: number; y: number; z: number } | null
}

/** Half the horizontal field, radians, for a vertical fov and the eye's 16:9. Display only. */
export const halfHorizontal = (vfovDeg: number) => Math.atan(Math.tan((vfovDeg * Math.PI) / 360) * (IDW / IDH))

export class SenseRig {
  readonly room: Room
  readonly eye: Eye
  grid = new OccupancyGrid({ cells: GRID, cell: CELL, center: { x: 0, z: 0 } })
  sal: Saliency
  colour: Uint8Array | null = null
  last: SensePass | null = null
  private cone: Mesh
  private gaze: Line
  private ring: Mesh
  private puffs: Points
  private puffPos = new Float32Array(MAX_PUFFS * 3)
  private fov = 0
  private eyePos = new Vector3()

  private scene: Scene

  constructor(scene: Scene, renderer: WebGLRenderer, things: readonly Placed[], rng: Rng, c: Colors) {
    this.scene = scene
    this.room = new Room(scene, things)
    this.eye = new Eye(renderer, scene, { fov: 74, width: IDW, height: IDH, depthWidth: 96, depthHeight: 54, far: FAR })
    this.sal = new Saliency({ rng })
    this.cone = new Mesh(new CircleGeometry(FAN, 40, 0, 1), new MeshBasicMaterial({ color: c.cone, transparent: true, opacity: 0.18, side: DoubleSide, depthWrite: false }))
    this.cone.rotation.x = -Math.PI / 2
    this.cone.position.y = 0.01
    this.gaze = new Line(new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3)), new LineBasicMaterial({ color: c.gaze }))
    this.ring = new Mesh(new RingGeometry(0.08, 0.12, 24), new MeshBasicMaterial({ color: c.gaze, side: DoubleSide, depthTest: false }))
    this.gaze.visible = this.ring.visible = false
    const pg = new BufferGeometry().setAttribute('position', new BufferAttribute(this.puffPos, 3))
    pg.setDrawRange(0, 0)
    this.puffs = new Points(pg, new PointsMaterial({ color: c.puff, size: 0.06, transparent: true, opacity: 0.55, depthWrite: false }))
    this.puffs.frustumCulled = false
    scene.add(this.cone, this.gaze, this.ring, this.puffs)
  }

  restart(things: readonly Placed[], rng: Rng) {
    this.room.set(things)
    this.sal.free()
    this.sal = new Saliency({ rng })
    this.grid.free()
    this.grid = new OccupancyGrid({ cells: GRID, cell: CELL, center: { x: 0, z: 0 } })
    this.gaze.visible = this.ring.visible = false
    this.last = null
  }

  /** The fan on the floor follows the agent and the field of view. */
  pose(a: AgentPose, vfovDeg: number) {
    const half = halfHorizontal(vfovDeg)
    if (half !== this.fov) {
      this.fov = half
      this.cone.geometry.dispose()
      this.cone.geometry = new CircleGeometry(FAN, 40, Math.PI / 2 - half, 2 * half)
    }
    this.cone.position.set(a.x, 0.01, a.z)
    // the fan opens along local +y, which the floor turn maps to -z; turn it to face yaw
    this.cone.rotation.set(-Math.PI / 2, 0, Math.PI + a.yaw)
  }

  /** One sense pass from the agent's head; the agent's own body is hidden from it. */
  pass(a: AgentPose, vfovDeg: number, t: number, hide: Object3D[]): SensePass {
    const s = Math.sin(a.yaw)
    const c = Math.cos(a.yaw)
    this.eyePos.set(a.x + s * 0.1, EYE_Y, a.z + c * 0.1)
    if (this.eye.camera.fov !== vfovDeg) { this.eye.camera.fov = vfovDeg; this.eye.camera.updateProjectionMatrix() }
    this.eye.place(this.eyePos, a.yaw, EYE_PITCH)
    const tracked: Tracked[] = [...this.room.meshes].map(([label, object]) => ({ object, label, minPixels: 1 }))
    const marks = [this.cone, this.gaze, this.ring, this.puffs, ...hide]
    const p = this.eye.pass(tracked, marks)
    const pixels = new Map(p.visible.map((v) => [v.label, v.pixels]))
    this.grid.integrate(p.camera, p.depth, p.depthWidth, p.depthHeight, FAR, { x: a.x, y: 0, z: a.z })
    // saliency over a colour frame of the same eye, marks hidden
    const vis = marks.map((m) => m.visible)
    marks.forEach((m) => (m.visible = false))
    this.colour = this.eye.colorFrame(SW, SH)
    marks.forEach((m, i) => (m.visible = vis[i]!))
    const cam = cameraFromThree(this.eye.camera)
    const objects = [...this.room.meshes.values()].map((m) => ({ x: m.position.x, y: m.position.y, z: m.position.z }))
    const labels = [...this.room.meshes.keys()]
    this.sal.update(this.colour, SW, SH, t, cam)
    let fixation: SensePass['fixation'] = null
    if (this.sal.ready(t)) {
      const f = this.sal.shift(t, cam, objects, 0.5)
      if (f) {
        fixation = { label: f.object >= 0 ? labels[f.object] ?? null : null, x: f.point.x, y: f.point.y, z: f.point.z }
        const g = this.gaze.geometry.getAttribute('position') as BufferAttribute
        g.setXYZ(0, this.eyePos.x, this.eyePos.y, this.eyePos.z)
        g.setXYZ(1, f.point.x, f.point.y, f.point.z)
        g.needsUpdate = true
        this.gaze.geometry.computeBoundingSphere()
        this.ring.position.set(f.point.x, f.point.y + 0.01, f.point.z)
        this.ring.lookAt(this.eyePos)
        this.gaze.visible = this.ring.visible = true
      }
    }
    this.last = { pixels, seen: p.visible, depth: p.depth, dw: p.depthWidth, dh: p.depthHeight, fixation }
    return this.last
  }

  /** Puffs as x, z, age, mass: drawn as points rising with age. */
  drawPuffs(puffs: Float64Array) {
    const n = Math.min(MAX_PUFFS, Math.floor(puffs.length / 4))
    for (let i = 0; i < n; i++) {
      this.puffPos[i * 3] = puffs[i * 4]!
      this.puffPos[i * 3 + 1] = 0.05 + Math.min(0.6, puffs[i * 4 + 2]! * 0.08)
      this.puffPos[i * 3 + 2] = puffs[i * 4 + 1]!
    }
    const g = this.puffs.geometry
    ;(g.getAttribute('position') as BufferAttribute).needsUpdate = true
    g.setDrawRange(0, n)
  }

  /** The eye inset in one of its modes, onto a 2d canvas. */
  drawInset(cv: HTMLCanvasElement, mode: InsetMode, ink: string) {
    const x = cv.getContext('2d')
    const p = this.last
    if (!x || !p || mode === 'hidden') return
    const W = mode === 'what it sees' ? SW : p.dw
    const H = mode === 'what it sees' ? SH : p.dh
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H }
    const img = x.createImageData(W, H)
    if (mode === 'what it sees' && this.colour) {
      const c = this.colour
      for (let i = 0; i < W * H * 4; i += 4) {
        img.data[i] = SRGB[c[i]!]!
        img.data[i + 1] = SRGB[c[i + 1]!]!
        img.data[i + 2] = SRGB[c[i + 2]!]!
        // a clear background reads back with alpha 0: show it as the void
        img.data[i + 3] = 255
      }
    } else {
      for (let i = 0; i < W * H; i++) {
        const v = 255 - Math.round(Math.min(1, p.depth[i]! / FAR) * 255)
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
        img.data[i * 4 + 3] = 255
      }
    }
    x.putImageData(img, 0, 0)
    if (mode !== 'detector') return
    x.font = '8px monospace'
    x.textBaseline = 'middle'
    for (const s of p.seen) {
      const cx = s.u * W
      const cy = s.v * H
      x.strokeStyle = ink
      x.strokeRect(cx - 4, cy - 4, 8, 8)
      x.fillStyle = ink
      x.fillText(`${s.label} ${s.pixels}`, Math.min(W - 40, cx + 6), cy)
    }
  }

  /** The grid the agent built, with the agent, onto a 2d canvas. Returns square meters known and the open edges. */
  drawGrid(cv: HTMLCanvasElement, a: AgentPose, tones: { unknown: string; free: string; wall: string; me: string }): { known: number; edges: number } {
    const cells = this.grid.cells()
    if (cv.width !== GRID) { cv.width = GRID; cv.height = GRID }
    const x = cv.getContext('2d')
    const k = this.grid.known()
    const edges = this.grid.frontiers({ x: a.x, z: a.z }).length
    if (x) {
      x.fillStyle = tones.unknown
      x.fillRect(0, 0, GRID, GRID)
      for (let i = 0; i < cells.length; i++) {
        const v = cells[i]
        if (!v) continue
        x.fillStyle = v === 2 ? tones.wall : tones.free
        // row by z, column by x; mirrored so the map reads like the top view
        x.fillRect(GRID - 1 - (i % GRID), GRID - 1 - Math.floor(i / GRID), 1, 1)
      }
      x.fillStyle = tones.me
      x.fillRect(GRID / 2 - a.x / CELL - 2, GRID / 2 - a.z / CELL - 2, 4, 4)
    }
    return { known: (k.free * CELL * CELL), edges }
  }

  dispose() {
    this.room.dispose()
    this.eye.dispose()
    this.sal.free()
    this.grid.free()
    for (const m of [this.cone, this.gaze, this.ring, this.puffs]) {
      this.scene.remove(m)
      m.geometry.dispose()
      ;(m.material as MeshBasicMaterial).dispose()
    }
  }
}
