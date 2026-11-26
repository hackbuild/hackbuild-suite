// The room: furniture and small things in three.js on the character stage,
// colliders for @hackbuild/mover, a walker that follows planned paths, and
// what the body sees from its eyes (rays against the room, as a depth buffer
// would give). The tools the agent calls act on this world.
import { BoxGeometry, Color, CylinderGeometry, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, Raycaster, SphereGeometry, Vector3, type Object3D, type Scene } from 'three'
import { box, planPath, type Collider, type Spot } from '@hackbuild/mover'
import { ToolError, type Tool } from '@hackbuild/agent'

export const HALF = 3
const PINK = 0xfe0386
const INK = 0x1a1a1a
const mat = (color: number, o: Partial<{ emissive: number; roughness: number }> = {}) => new MeshStandardMaterial({ color, roughness: o.roughness ?? 0.8, emissive: o.emissive ?? 0 })

interface Furniture { id: string; name: string; w: number; d: number; h: number; color: number; x: number; z: number; mesh?: Group; on?: boolean }
interface Thing { id: string; name: string; color: number; shape: 'box' | 'ball' | 'cyl'; size: number; mesh?: Mesh; on: string | null }
export interface Seen { id: string; name: string; dist: number; bearing: number; x: number; z: number }

const FURNITURE: Furniture[] = [
  { id: 'table', name: 'table', w: 1.2, d: 0.7, h: 0.72, color: 0xfffdf7, x: 0.8, z: 1.0 },
  { id: 'workbench', name: 'workbench', w: 1.8, d: 0.6, h: 0.9, color: 0xd9a35a, x: -0.6, z: -2.55 },
  { id: 'shelf', name: 'shelf', w: 0.5, d: 1.4, h: 1.2, color: 0xd9a35a, x: 2.7, z: -1.0 },
  { id: 'chair', name: 'chair', w: 0.5, d: 0.5, h: 0.46, color: PINK, x: -1.2, z: 0.9 },
  { id: 'lamp', name: 'lamp', w: 0.3, d: 0.3, h: 1.6, color: INK, x: -2.6, z: -1.6 },
]
const THINGS: Thing[] = [
  { id: 'mug', name: 'mug', color: 0xfffdf7, shape: 'cyl', size: 0.09, on: 'workbench' },
  { id: 'radio', name: 'radio', color: PINK, shape: 'box', size: 0.2, on: 'workbench' },
  { id: 'wrench', name: 'wrench', color: 0x8a8a8a, shape: 'box', size: 0.18, on: 'workbench' },
  { id: 'coin', name: 'coin', color: 0xe0a829, shape: 'cyl', size: 0.05, on: 'table' },
  { id: 'bottle', name: 'bottle', color: 0x2f5fa7, shape: 'cyl', size: 0.07, on: 'shelf' },
  { id: 'ball', name: 'ball', color: 0x2f5fa7, shape: 'ball', size: 0.12, on: null },
]

export interface WorldEvents {
  log(kind: 'eye' | 'body' | 'note', line: string): void
  say(text: string): Promise<void>
  gesture(id: 'wave' | 'nod' | 'shake' | 'bow'): void
}

export class World {
  readonly group = new Group()
  readonly mover = new Group()
  /** Two gripper pads in front of the body, shown by the grippers verb. */
  readonly hands = new Group()
  private worn: Object3D | null = null
  readonly eye = new PerspectiveCamera(70, 2, 0.05, 12)
  readonly furniture = FURNITURE.map((f) => ({ ...f }))
  readonly things = THINGS.map((t) => ({ ...t }))
  colliders: Collider[] = []
  held: Thing | null = null
  /** Things seen earlier: where and when. */
  readonly beliefs = new Map<string, { x: number; z: number; at: number; on: string | null }>()
  /** Occupancy built from the eyes: 0 unknown, 1 free, 2 blocked; 30 by 30 cells over the floor. */
  readonly map = new Uint8Array(30 * 30)
  readonly trail: Spot[] = []
  path: Spot[] = []
  private walking: { resolve: () => void; reject: (e: Error) => void } | null = null
  private yaw = 0
  private ray = new Raycaster()
  private seed = 1

  constructor(readonly ev: WorldEvents) {
    this.group.add(this.mover)
    for (const x of [-0.22, 0.22]) {
      const pad = new Mesh(new SphereGeometry(0.045, 12, 8), mat(PINK, { emissive: 0x3a0020 }))
      pad.position.set(x, 0.95, 0.28)
      this.hands.add(pad)
    }
    this.mover.add(this.hands)
    this.build()
  }

  private rng() {
    this.seed = (this.seed * 16807) % 2147483647
    return this.seed / 2147483647
  }

  /** Lays the room out again; a new seed moves the furniture and the loose things. */
  build(seed?: number) {
    if (seed !== undefined) {
      this.seed = seed
      for (const f of this.furniture) if (f.id === 'table' || f.id === 'chair') (f.x = -1.8 + this.rng() * 3.2), (f.z = -0.6 + this.rng() * 2.2)
      for (const t of this.things) if (t.id !== 'radio') t.on = [null, 'table', 'workbench', 'shelf'][Math.floor(this.rng() * 4)]!
    }
    for (const c of [...this.group.children]) if (c !== this.mover) this.group.remove(c)
    const floor = new Mesh(new PlaneGeometry(HALF * 2, HALF * 2), mat(0xf1e6d6))
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    floor.name = 'floor'
    const back = new Mesh(new BoxGeometry(HALF * 2, 2.6, 0.08), mat(0xefe9db))
    back.position.set(0, 1.3, -HALF)
    back.name = 'wall'
    const left = new Mesh(new BoxGeometry(0.08, 2.6, HALF * 2), mat(0xe8e1d1))
    left.position.set(-HALF, 1.3, 0)
    left.name = 'wall'
    this.group.add(floor, back, left)
    this.colliders = [box(0, 2.6, -HALF, HALF * 2, 0.1), box(-HALF, 2.6, 0, 0.1, HALF * 2), box(HALF + 0.05, 2.6, 0, 0.1, HALF * 2), box(0, 2.6, HALF + 0.05, HALF * 2, 0.1)]
    for (const f of this.furniture) {
      const g = new Group()
      g.name = f.id
      g.userData.thing = f.id
      if (f.id === 'lamp') {
        const pole = new Mesh(new CylinderGeometry(0.02, 0.02, f.h), mat(INK))
        pole.position.y = f.h / 2
        const shade = new Mesh(new CylinderGeometry(0.12, 0.22, 0.3, 16), mat(0xfffdf7, { emissive: f.on ? 0xfff2c0 : 0 }))
        shade.position.y = f.h
        g.add(pole, shade)
      } else {
        const top = new Mesh(new BoxGeometry(f.w, f.id === 'chair' ? 0.06 : 0.05, f.d), mat(f.color))
        top.position.y = f.h
        const base = new Mesh(new BoxGeometry(f.w * 0.9, f.h, f.d * 0.9), mat(f.id === 'chair' ? INK : 0x2a2a2a))
        base.position.y = f.h / 2
        g.add(top, base)
        if (f.id === 'chair') {
          const backrest = new Mesh(new BoxGeometry(f.w, 0.5, 0.06), mat(PINK))
          backrest.position.set(0, f.h + 0.25, -f.d / 2)
          g.add(backrest)
        }
      }
      g.position.set(f.x, 0, f.z)
      g.traverse((o) => ((o as Mesh).castShadow = true, (o.userData.thing = f.id)))
      f.mesh = g
      this.group.add(g)
      this.colliders.push(box(f.x, f.h, f.z, f.w, f.d))
    }
    this.things.forEach((t, i) => {
      const geo = t.shape === 'ball' ? new SphereGeometry(t.size, 16, 12) : t.shape === 'cyl' ? new CylinderGeometry(t.size, t.size, t.id === 'coin' ? 0.01 : t.size * 2, 16) : new BoxGeometry(t.size * 1.4, t.size, t.size)
      const m = new Mesh(geo, mat(t.color, { roughness: 0.5 }))
      m.castShadow = true
      m.name = t.id
      m.userData.thing = t.id
      t.mesh = m
      this.group.add(m)
      this.place(t, t.on, i)
    })
    this.map.fill(0)
    this.beliefs.clear()
  }

  private place(t: Thing, on: string | null, i = 0) {
    const f = this.furniture.find((x) => x.id === on)
    const m = t.mesh!
    if (f) m.position.set(f.x - f.w / 3 + ((i * 0.37) % (f.w * 0.66)), f.h + 0.06 + (t.shape === 'cyl' && t.id !== 'coin' ? t.size : t.size / 2), f.z)
    else m.position.set(1.6 - i * 0.2, t.size, 1.9)
    t.on = on
    this.group.add(m)
  }

  /** The body root: the stage's body goes inside the mover group. */
  wear(root: Object3D | null) {
    if (this.worn) this.mover.remove(this.worn)
    this.worn = root
    if (root) this.mover.add(root)
  }
  get at(): Spot { return { x: this.mover.position.x, z: this.mover.position.z } }

  find(name: string): { x: number; z: number; id: string; name: string; kind: 'furniture' | 'thing' } | null {
    const n = name.toLowerCase().replace(/^(the|a|my)\s+/, '').trim()
    const f = this.furniture.find((x) => n.includes(x.name) || x.name.includes(n))
    if (f) return { x: f.x, z: f.z, id: f.id, name: f.name, kind: 'furniture' }
    const t = this.things.find((x) => n.includes(x.name) || x.name.includes(n))
    if (t && t.mesh) {
      const p = new Vector3()
      t.mesh.getWorldPosition(p)
      return { x: p.x, z: p.z, id: t.id, name: t.name, kind: 'thing' }
    }
    if (/\b(me|person|you|here)\b/.test(n)) return { x: 0, z: 2.4, id: 'person', name: 'you', kind: 'furniture' }
    return null
  }

  /** Walks to near a spot along a planned path; resolves on arrival. */
  walkTo(to: Spot, signal?: AbortSignal): Promise<void> {
    const r = planPath(this.colliders, this.at, to, { radius: 0.25, margin: 0.1 })
    let goal = to
    let plan = r
    if (!r.ok) {
      // the spot itself is inside furniture: walk to the closest free side
      for (const [dx, dz] of [[0, 0.75], [0, -0.75], [0.8, 0], [-0.8, 0], [0.7, 0.7], [-0.7, 0.7]]) {
        goal = { x: to.x + dx!, z: to.z + dz! }
        plan = planPath(this.colliders, this.at, goal, { radius: 0.25, margin: 0.1 })
        if (plan.ok) break
      }
    }
    if (!plan.ok) return Promise.reject(new ToolError('i cannot find a way there.'))
    this.path = [...plan.waypoints]
    this.walking?.reject(new Error('a newer walk started'))
    return new Promise((resolve, reject) => {
      this.walking = { resolve, reject }
      signal?.addEventListener('abort', () => this.stop())
    })
  }

  stop() {
    this.path = []
    const w = this.walking
    this.walking = null
    w?.reject(new ToolError('i stopped.'))
  }

  get busy() { return this.path.length > 0 }

  /** One frame: walk the path, carry what is held, keep the eye on the head. */
  tick(dt: number, headHeight: number) {
    const next = this.path[0]
    if (next) {
      const dx = next.x - this.mover.position.x
      const dz = next.z - this.mover.position.z
      const d = Math.hypot(dx, dz)
      const want = Math.atan2(dx, dz)
      let turn = want - this.yaw
      while (turn > Math.PI) turn -= 2 * Math.PI
      while (turn < -Math.PI) turn += 2 * Math.PI
      this.yaw += Math.sign(turn) * Math.min(Math.abs(turn), dt * 5)
      const step = Math.min(d, dt * 1.1)
      if (d < 0.05) {
        this.path.shift()
        const last = this.trail[this.trail.length - 1]
        if (!last || Math.hypot(last.x - next.x, last.z - next.z) > 0.2) this.trail.push({ ...next })
        if (!this.path.length) (this.walking?.resolve(), (this.walking = null))
      } else if (Math.abs(turn) < 1.2) this.mover.position.set(this.mover.position.x + (dx / d) * step, 0, this.mover.position.z + (dz / d) * step)
      this.mover.rotation.y = this.yaw
    }
    this.hands.position.y = headHeight * 0.6 - 0.95
    if (this.held?.mesh) this.held.mesh.position.set(this.mover.position.x + Math.sin(this.yaw) * 0.3, headHeight * 0.6, this.mover.position.z + Math.cos(this.yaw) * 0.3)
    this.eye.position.set(this.mover.position.x + Math.sin(this.yaw) * 0.12, headHeight * 0.93, this.mover.position.z + Math.cos(this.yaw) * 0.12)
    this.eye.lookAt(this.eye.position.x + Math.sin(this.yaw), headHeight * 0.75, this.eye.position.z + Math.cos(this.yaw))
  }

  turnBy(rad: number) {
    this.yaw += rad
    this.mover.rotation.y = this.yaw
  }

  /** Distances along rays in a cols by rows grid over the eye's view, metres; marks the map. */
  depth(cols: number, rows: number, scene: Scene): Float32Array {
    const out = new Float32Array(cols * rows)
    const dir = new Vector3()
    this.eye.updateMatrixWorld()
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      dir.set(((c + 0.5) / cols) * 2 - 1, 1 - ((r + 0.5) / rows) * 2, 0.5).unproject(this.eye).sub(this.eye.position).normalize()
      this.ray.set(this.eye.position, dir)
      this.ray.far = this.eye.far
      const hit = this.ray.intersectObject(this.group, true).find((h) => h.object.name !== 'floor' && !this.mover.getObjectById(h.object.id))
      const d = hit ? hit.distance : this.eye.far
      out[r * cols + c] = d
      // the map: free along the ray, blocked where it hit
      for (let s = 0.3; s < Math.min(d, 6); s += 0.2) this.mark(this.eye.position.x + dir.x * s, this.eye.position.z + dir.z * s, 1)
      if (hit) this.mark(hit.point.x, hit.point.z, 2)
    }
    void scene
    return out
  }

  private mark(x: number, z: number, v: number) {
    const i = Math.floor(((x + HALF) / (HALF * 2)) * 30)
    const j = Math.floor(((z + HALF) / (HALF * 2)) * 30)
    if (i < 0 || j < 0 || i >= 30 || j >= 30) return
    const k = j * 30 + i
    if (v === 2 || this.map[k] !== 2) this.map[k] = v
  }

  /** What is in view now and not hidden behind something, nearest first. */
  seen(): Seen[] {
    const out: Seen[] = []
    const p = new Vector3()
    const ndc = new Vector3()
    this.eye.updateMatrixWorld()
    for (const o of [...this.furniture, ...this.things]) {
      const m = (o as Thing).mesh ?? (o as Furniture).mesh
      if (!m || o === this.held) continue
      m.getWorldPosition(p)
      p.y = Math.max(p.y, 0.3)
      ndc.copy(p).project(this.eye)
      if (ndc.z > 1 || Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1) continue
      const dist = p.distanceTo(this.eye.position)
      this.ray.set(this.eye.position, p.clone().sub(this.eye.position).normalize())
      const hit = this.ray.intersectObject(this.group, true).find((h) => !this.mover.getObjectById(h.object.id))
      if (hit && hit.object.userData.thing !== o.id && hit.distance < dist - 0.25) continue
      const bearing = Math.round((Math.atan2(p.x - this.eye.position.x, p.z - this.eye.position.z) - this.yaw) * (180 / Math.PI))
      out.push({ id: o.id, name: o.name, dist, bearing, x: p.x, z: p.z })
      this.beliefs.set(o.id, { x: p.x, z: p.z, at: Date.now(), on: (o as Thing).on ?? null })
    }
    return out.sort((a, b) => a.dist - b.dist)
  }

  /** Screen boxes of what is in view, for the detector view. */
  boxes(w: number, h: number): { label: string; x: number; y: number; w: number; h: number }[] {
    const seen = new Set(this.seen().map((s) => s.id))
    const out: { label: string; x: number; y: number; w: number; h: number }[] = []
    const v = new Vector3()
    for (const o of [...this.furniture, ...this.things]) {
      const m = (o as Thing).mesh ?? (o as Furniture).mesh
      if (!m || !seen.has(o.id)) continue
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      m.traverse((c) => {
        const g = (c as Mesh).geometry
        if (!g) return
        g.computeBoundingBox()
        const b = g.boundingBox!
        for (const cx of [b.min.x, b.max.x]) for (const cy of [b.min.y, b.max.y]) for (const cz of [b.min.z, b.max.z]) {
          v.set(cx, cy, cz).applyMatrix4(c.matrixWorld).project(this.eye)
          x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y)
        }
      })
      out.push({ label: o.name, x: ((Math.max(-1, x0) + 1) / 2) * w, y: ((1 - Math.min(1, y1)) / 2) * h, w: ((Math.min(1, x1) - Math.max(-1, x0)) / 2) * w, h: ((Math.min(1, y1) - Math.max(-1, y0)) / 2) * h })
    }
    return out
  }

  near(id: string): number {
    const f = this.find(id)
    return f ? Math.hypot(f.x - this.at.x, f.z - this.at.z) : Infinity
  }

  /** The tools the agent calls. Failures are first person, for the model to read. */
  tools(): Tool[] {
    const arg = { type: 'object', properties: { thing: { type: 'string' } }, required: ['thing'] } as const
    const need = (name: string) => {
      const f = this.find(name)
      if (!f) throw new ToolError(`i do not see a ${name} here.`)
      return f
    }
    return [
      { name: 'walk_to', description: 'walk to a thing or a piece of furniture', parameters: arg, run: async ([name = ''], ctx) => {
        const f = need(name)
        await this.walkTo(f, ctx.signal)
        return `i am at the ${f.name}.`
      } },
      { name: 'pick_up', description: 'pick up a small thing within reach', parameters: arg, run: ([name = '']) => {
        const t = this.things.find((x) => x.id === need(name).id)
        if (!t) throw new ToolError(`the ${name} is too big to pick up.`)
        if (this.held) throw new ToolError(`my hands are full: i hold the ${this.held.name}.`)
        const d = this.near(t.id)
        if (d > 1.1) throw new ToolError(`the ${t.name} is ${d.toFixed(1)} m away. i walk closer first.`)
        this.held = t
        t.on = null
        this.ev.log('body', `picked up the ${t.name}`)
        return `i hold the ${t.name}.`
      } },
      { name: 'put_on', description: 'put what i hold on a piece of furniture within reach', parameters: arg, run: ([name = '']) => {
        if (!this.held) throw new ToolError('i am not holding anything.')
        const f = this.furniture.find((x) => x.id === need(name).id)
        if (!f) throw new ToolError(`i cannot put things on the ${name}.`)
        const d = this.near(f.id)
        if (d > 1.3) throw new ToolError(`the ${f.name} is ${d.toFixed(1)} m away. i walk closer first.`)
        const t = this.held
        this.held = null
        this.place(t, f.id, this.things.indexOf(t))
        return `the ${t.name} is on the ${f.name}.`
      } },
      { name: 'put_down', description: 'put what i hold on the floor', run: () => {
        if (!this.held) throw new ToolError('i am not holding anything.')
        const t = this.held
        this.held = null
        t.mesh!.position.y = t.size
        t.on = null
        return `i put the ${t.name} down.`
      } },
      { name: 'look_around', description: 'turn on the spot and look', run: () => {
        const names = new Set<string>()
        for (let k = 0; k < 6; k++) {
          this.turnBy(Math.PI / 3)
          this.tick(0, 1.6)
          for (const s of this.seen()) names.add(s.name)
        }
        return names.size ? `i see ${[...names].join(', ')}.` : 'i see nothing i know.'
      } },
      { name: 'turn_on', description: 'switch the lamp or the radio on or off', parameters: arg, run: ([name = '']) => {
        const f = need(name)
        if (this.near(f.id) > 1.3) throw new ToolError(`the ${f.name} is too far to reach. i walk closer first.`)
        const lamp = this.furniture.find((x) => x.id === f.id && x.id === 'lamp')
        if (lamp) {
          lamp.on = !lamp.on
          const shade = lamp.mesh?.children[1] as Mesh | undefined
          if (shade) (shade.material as MeshStandardMaterial).emissive = new Color(lamp.on ? 0xfff2c0 : 0)
          return `the lamp is ${lamp.on ? 'on' : 'off'}.`
        }
        if (f.id === 'radio') return 'the radio hums.'
        throw new ToolError(`the ${f.name} has no switch.`)
      } },
      { name: 'say', description: 'say something out loud', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, target: () => null, run: async ([text = '']) => {
        await this.ev.say(text)
      } },
      { name: 'gesture', description: 'wave, nod, shake or bow', parameters: { type: 'object', properties: { move: { type: 'string', enum: ['wave', 'nod', 'shake', 'bow'] } }, required: ['move'] }, target: () => null, run: ([m = 'wave']) => {
        this.ev.gesture(m as 'wave')
      } },
    ]
  }
}
