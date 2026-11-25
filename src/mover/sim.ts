// The mover run: one capsule body in a `World`, a `Steerer` walking the
// planned waypoints to a goal, or the keys and the pad driving it straight.
// Framework free and three free, so node runs the same steps as the tool.
import { Steerer, World, type Actor, type AgentState, type Footprint, type SteerOut } from '@hackbuild/mover'
import { BODY_H, BODY_R, MOVER_COPY, collidersOf, footprintsOf, inside, planPath, type Spot, type SteerRead, type WorldItem } from './kind.ts'

/** Arrival radius of a waypoint on the way, meters (proposed). */
const PASS = 0.3
/** The body eases to the wanted velocity with this time constant, seconds (the library page's 0.15, inferred). */
const EASE = 0.15

export interface SimEvent {
  t: number
  kind: 'goal' | 'mode' | 'arrived' | 'stall' | 'drive'
  text: string
}

export class MoverSim {
  world: World
  steer: Steerer
  fps: Footprint[] = []
  items: WorldItem[] = []
  path: Spot[] = []
  leg = 0
  goal: Spot | null = null
  actor: Actor
  me: AgentState
  last: SteerOut | null = null
  t = 0
  events: SimEvent[] = []
  trace: { t: number; x: number; z: number; mode: string; why: string }[] = []
  private mode = ''

  readonly speed: number

  constructor(items: readonly WorldItem[], start: Spot, speed = 1.4) {
    this.speed = speed
    this.world = new World([])
    this.steer = new Steerer('body', { speed })
    this.actor = { pos: { x: start.x, y: 0, z: start.z }, vel: { x: 0, y: 0, z: 0 }, radius: BODY_R, height: BODY_H, grounded: true }
    this.me = { id: 'body', x: start.x, z: start.z, vx: 0, vz: 0, radius: BODY_R, moving: false }
    this.setItems(items)
  }

  private log(kind: SimEvent['kind'], text: string) {
    this.events.push({ t: this.t, kind, text })
    if (this.events.length > 300) this.events.shift()
  }

  /** New things in the world: colliders and footprints again, and a new path to the goal. */
  setItems(items: readonly WorldItem[]) {
    this.items = items.map((t) => ({ ...t }))
    this.world.colliders = collidersOf(this.items)
    this.fps = footprintsOf(this.items)
    if (this.goal) this.setGoal(this.goal.x, this.goal.z, true)
  }

  /** A goal: the path round the things, or the copy that says why there is none. */
  setGoal(x: number, z: number, quiet = false): string | null {
    if (inside(this.items, x, z)) return MOVER_COPY.inWall
    const p = planPath(this.items, { x: this.actor.pos.x, z: this.actor.pos.z }, { x, z })
    if (!p) return MOVER_COPY.noWay
    this.goal = { x, z }
    this.path = p
    this.leg = 0
    this.steer.setGoal(p[0]!.x, p[0]!.z)
    if (!quiet) this.log('goal', `goal at ${x.toFixed(2)}, ${z.toFixed(2)}: ${p.length} waypoint${p.length === 1 ? '' : 's'}`)
    return null
  }

  clearGoal() {
    this.goal = null
    this.path = []
    this.steer.clearGoal()
  }

  /** One step. `drive` is a velocity from the keys or the pad; it takes over from the goal. */
  step(dt: number, drive: { vx: number; vz: number } | null = null) {
    this.t += dt
    const a = this.actor
    let want = { vx: 0, vz: 0 }
    if (drive && (drive.vx || drive.vz)) {
      if (this.goal) { this.clearGoal(); this.log('drive', 'the keys took over. the goal is dropped.') }
      want = drive
      this.last = { vx: drive.vx, vz: drive.vz, mode: 'go', sideWaypoint: null, why: 'driven by the keys or the pad' }
    } else if (this.goal) {
      this.me.moving = true
      const out = this.steer.update(this.t, this.me, [this.me], this.fps)
      this.last = out
      if (out.sideWaypoint) this.log('stall', `stalled: a side step to ${out.sideWaypoint.x.toFixed(2)}, ${out.sideWaypoint.z.toFixed(2)}`)
      const wp = this.path[this.leg]!
      const near = Math.hypot(wp.x - a.pos.x, wp.z - a.pos.z) < PASS
      if (this.leg < this.path.length - 1 && (near || out.mode === 'arrived')) {
        this.leg++
        this.steer.setGoal(this.path[this.leg]!.x, this.path[this.leg]!.z)
      } else if (this.leg === this.path.length - 1 && out.mode === 'arrived') {
        this.log('arrived', `arrived at ${a.pos.x.toFixed(2)}, ${a.pos.z.toFixed(2)}`)
        this.clearGoal()
      }
      want = { vx: out.vx, vz: out.vz }
    } else {
      this.me.moving = false
      this.last = this.last && this.last.mode === 'arrived' ? this.last : { vx: 0, vz: 0, mode: 'arrived', sideWaypoint: null, why: '' }
    }
    const k = Math.min(1, dt / EASE)
    a.vel.x += (want.vx - a.vel.x) * k
    a.vel.z += (want.vz - a.vel.z) * k
    this.world.step(a, dt)
    this.world.endFrame()
    Object.assign(this.me, { x: a.pos.x, z: a.pos.z, vx: a.vel.x, vz: a.vel.z })
    const mode = this.last?.mode ?? ''
    if (mode !== this.mode) { this.log('mode', `${this.mode || 'start'} to ${mode}`); this.mode = mode }
    this.trace.push({ t: this.t, x: a.pos.x, z: a.pos.z, mode, why: this.last?.why ?? '' })
    if (this.trace.length > 20000) this.trace.shift()
  }

  /** Facing for the body, radians, 0 faces +z; null when standing still. */
  heading(): number | null {
    const v = this.actor.vel
    return Math.hypot(v.x, v.z) > 0.05 ? Math.atan2(v.x, v.z) : null
  }

  read(): SteerRead {
    const a = this.actor
    return {
      mode: this.last?.mode ?? 'arrived',
      why: this.last?.why ?? '',
      speed: Math.hypot(a.vel.x, a.vel.z),
      waypoint: this.goal ? `${this.leg + 1} of ${this.path.length}` : 'none',
      stalls: this.steer.stalls,
      unreachable: this.steer.unreachable,
      grounded: !!a.grounded,
      hitWall: !!a.hitWall,
      x: a.pos.x,
      z: a.pos.z,
    }
  }
}
