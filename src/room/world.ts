// The room scene module (design 3.10, F-2): what is in the room, where the
// body stands, what its hands hold, and the body API the brain plans with.
// Ported from the room original's body: a walk that stops short of the
// target, two grippers, put on a surface, look, say, wait and explore, each
// a tool whose failure is a first person sentence the model reads. Drives
// (curiosity, tidy, social, rest) rise with time and pick the next own idea
// in free run. Framework free and three free: the stage reads `pose` and
// the things each frame and draws them.
import { ToolError, type Tool } from '@hackbuild/agent'
import type { Rng } from '@hackbuild/organic'
import { clampRoom, propDef, ROOM, type Placed } from '../agents/props.ts'

export const FURNITURE = ['shelf', 'table', 'chair'] as const
export const SMALL = ['mug', 'ball', 'box', 'bowl'] as const
export const ROOM_THINGS = [...FURNITURE, ...SMALL]
export type Hand = 'left' | 'right'

/** Where "you" stand: the front camera side of the room, meters. */
export const YOU = { x: 0, z: 3 }

export interface Thing extends Placed {
  /** The furniture it sits on, or null on the floor. */
  on: string | null
  /** The hand that holds it, or null. */
  held: Hand | null
}

export interface Pose {
  x: number
  z: number
  /** Facing, radians, 0 faces +z. */
  yaw: number
}

export type LogKind = 'you' | 'me' | 'act' | 'fail' | 'eye' | 'note' | 'think' | 'load'
/** A log row replaced in place: the id of the row (none for a new one), live while it runs, the fraction done. */
export interface LiveRow {
  id?: number
  live?: boolean
  fraction?: number
}

export interface LogLine {
  id: number
  t: number
  kind: LogKind
  text: string
  /** A row that updates in place while the act runs. */
  live?: boolean
}

export const DRIVES = ['curiosity', 'tidy', 'social', 'rest'] as const
export type Drive = (typeof DRIVES)[number]

/** Rise per second of each drive while nothing feeds it (proposed). */
const RISE: Record<Drive, number> = { curiosity: 0.012, tidy: 0.006, social: 0.008, rest: 0.004 }
/** Walking speed, meters a second (proposed, as the walking stage). */
export const WALK = 1.2
/** Stop this far short of a thing, plus half its size, meters (proposed). */
const SHORT = 0.45
/** Reach of a gripper from where the body stands, meters (proposed). */
export const REACH = 0.9

interface Walk {
  kind: 'walk'
  to: { x: number; z: number }
  what: string
  done: () => void
  fail: (e: Error) => void
  line: number
  /** Meters to walk at the start, for the fraction done. */
  total: number
}
interface Wait {
  kind: 'wait'
  left: number
  done: () => void
  fail: (e: Error) => void
}
type Act = Walk | Wait

/** 'the shelf', but 'you'. */
const the = (what: string) => (what === 'you' ? 'you' : `the ${what}`)
const r2 = (v: number) => Math.round(v * 100) / 100
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

export interface WorldHooks {
  /** A line for the talk log; `row` updates one in place, live while the act runs, with its fraction done. */
  log(kind: LogKind, text: string, row?: LiveRow): number
  /** The body said something: the bubble and the caption read it. */
  said(text: string): void
}

export class World {
  things: Thing[]
  pose: Pose = { x: 0, z: 0, yaw: 0 }
  hands: Record<Hand, string | null> = { left: null, right: null }
  drives: Record<Drive, number> = { curiosity: 0.6, tidy: 0.3, social: 0.4, rest: 0.1 }
  /** What the body is doing, in a few words. */
  doing = 'standing'
  private act: Act | null = null
  private rng: Rng
  private hooks: WorldHooks

  constructor(layout: readonly Placed[], rng: Rng, hooks: WorldHooks) {
    this.things = layout.map((p) => ({ ...p, on: null, held: null }))
    this.rng = rng
    this.hooks = hooks
  }

  get busy(): boolean {
    return this.act !== null
  }

  thing(label: string): Thing | undefined {
    const l = label.toLowerCase().replace(/^the\s+/, '').trim()
    return this.things.find((t) => t.label === l)
  }

  /** A target by name: a thing, "you", or "me". */
  spot(name: string): { x: number; z: number; size: number; what: string } | null {
    const n = name.toLowerCase().replace(/^the\s+/, '').trim()
    if (n === 'you' || n === 'me' || n === 'here' || n === 'person') return { ...YOU, size: 0.4, what: 'you' }
    const t = this.thing(n)
    if (!t) return null
    const d = propDef(t.label)
    return { x: t.x, z: t.z, size: d ? Math.max(d.w, d.d) : 0.3, what: t.label }
  }

  heldThing(): string | null {
    return this.hands.right ?? this.hands.left
  }

  /** One line on the hands, as the body tab reads it. */
  handsLine(): string {
    return `left: ${this.hands.left ?? 'empty'}. right: ${this.hands.right ?? 'empty'}.`
  }

  /** Stops the act in hand; its tool fails with "i was stopped." */
  stop(): void {
    const a = this.act
    this.act = null
    this.doing = 'standing'
    if (a?.kind === 'walk') this.hooks.log('act', `stopped on the way to ${the(a.what)}.`, { id: a.line, live: false })
    a?.fail(new ToolError('i was stopped.'))
  }

  /** The pad's one button: lift the nearest small thing in reach, else put down what the hand holds. */
  grab(): string {
    const near = this.things
      .filter((t) => !t.held && (SMALL as readonly string[]).includes(t.label))
      .map((t) => ({ t, d: dist(this.pose, t) }))
      .filter((x) => x.d <= REACH + 0.2)
      .sort((x, y) => x.d - y.d)[0]
    const free = !this.hands.right || !this.hands.left
    if (near && free) return this.pickUp(near.t.label)
    if (this.heldThing()) return this.drop()
    throw new ToolError(`nothing small within ${REACH} m. drive up to the ${SMALL.slice(0, -1).join(', ')} or ${SMALL[SMALL.length - 1]}.`)
  }

  /** Advances the act and the drives by dt seconds. Returns true while the body moves. */
  tick(dt: number): boolean {
    for (const k of DRIVES) this.drives[k] = Math.min(1, this.drives[k] + RISE[k] * dt)
    const a = this.act
    if (!a) return false
    if (a.kind === 'wait') {
      a.left -= dt
      if (a.left <= 0) this.finish()
      return false
    }
    const p = this.pose
    const dx = a.to.x - p.x
    const dz = a.to.z - p.z
    const d = Math.hypot(dx, dz)
    p.yaw = Math.atan2(dx, dz)
    const step = WALK * dt
    if (d <= step) {
      p.x = a.to.x
      p.z = a.to.z
      this.hooks.log('act', `walked to ${the(a.what)}.`, { id: a.line, live: false })
      this.finish()
      return true
    }
    p.x += (dx / d) * step
    p.z += (dz / d) * step
    this.drives.rest = Math.min(1, this.drives.rest + 0.004 * dt)
    this.hooks.log('act', `walking to ${the(a.what)}, ${(d - step).toFixed(1)} m left.`, { id: a.line, live: true, fraction: a.total > 0 ? Math.min(1, 1 - (d - step) / a.total) : 0 })
    this.carry()
    return true
  }

  /** Held things move with the hands. */
  carry(): void {
    for (const t of this.things) {
      if (!t.held) continue
      const side = t.held === 'right' ? -1 : 1
      t.x = r2(this.pose.x + Math.sin(this.pose.yaw) * 0.3 + Math.cos(this.pose.yaw) * 0.25 * side)
      t.z = r2(this.pose.z + Math.cos(this.pose.yaw) * 0.3 - Math.sin(this.pose.yaw) * 0.25 * side)
    }
  }

  private finish(): void {
    const a = this.act
    this.act = null
    this.doing = 'standing'
    a?.done()
  }

  private start(a: Omit<Walk, 'done' | 'fail'> | Omit<Wait, 'done' | 'fail'>, signal: AbortSignal): Promise<void> {
    if (this.act) this.stop()
    return new Promise<void>((done, fail) => {
      this.act = { ...a, done, fail } as Act
      signal.addEventListener('abort', () => { if (this.act?.done === done) this.stop() }, { once: true })
    })
  }

  walkTo(name: string, signal: AbortSignal): Promise<string> {
    const s = this.spot(name)
    if (!s) throw new ToolError(`i do not see a ${name} in this room. i can go to: ${this.things.map((t) => t.label).join(', ')}, or you.`)
    const d = dist(this.pose, s)
    const stop = SHORT + s.size / 2
    if (d <= stop + 0.05) return Promise.resolve(`i am at ${the(s.what)} already.`)
    const k = (d - stop) / d
    const to = { x: clampRoom(this.pose.x + (s.x - this.pose.x) * k), z: clampRoom(this.pose.z + (s.z - this.pose.z) * k) }
    this.doing = `walking to ${the(s.what)}`
    const total = dist(this.pose, to)
    const line = this.hooks.log('act', `walking to ${the(s.what)}, ${d.toFixed(1)} m.`, { live: true, fraction: 0 })
    return this.start({ kind: 'walk', to, what: s.what, line, total }, signal).then(() => `i am at ${the(s.what)}.`)
  }

  lookAt(name: string): string {
    const s = this.spot(name)
    if (!s) throw new ToolError(`i do not see a ${name} to look at.`)
    this.pose.yaw = Math.atan2(s.x - this.pose.x, s.z - this.pose.z)
    this.carry()
    return `i look at ${the(s.what)}.`
  }

  pickUp(name: string): string {
    const t = this.thing(name)
    if (!t) throw new ToolError(`there is no ${name} here.`)
    if (!(SMALL as readonly string[]).includes(t.label)) throw new ToolError(`the ${t.label} is too big to lift. i can lift: ${SMALL.join(', ')}.`)
    if (t.held) return `i hold the ${t.label} already.`
    const d = dist(this.pose, t)
    if (d > REACH + 0.2) throw new ToolError(`the ${t.label} is ${d.toFixed(1)} m away. i walk closer first.`)
    const hand: Hand | null = !this.hands.right ? 'right' : !this.hands.left ? 'left' : null
    if (!hand) throw new ToolError(`both hands are full: ${this.hands.left} and ${this.hands.right}. i put one down first.`)
    this.hands[hand] = t.label
    t.held = hand
    t.on = null
    this.drives.tidy = Math.max(0, this.drives.tidy - 0.1)
    this.carry()
    return `i hold the ${t.label} in my ${hand} hand.`
  }

  putOn(name: string, place: string): string {
    const t = this.thing(name === 'it' ? (this.heldThing() ?? name) : name)
    if (!t) throw new ToolError(`there is no ${name} here.`)
    if (!t.held) throw new ToolError(`i am not holding the ${t.label}. i pick it up first.`)
    const f = this.thing(place)
    if (!f || !(FURNITURE as readonly string[]).includes(f.label)) throw new ToolError(`i can put things on: ${FURNITURE.join(', ')}.`)
    const d = dist(this.pose, f)
    if (d > REACH + 0.6) throw new ToolError(`the ${f.label} is ${d.toFixed(1)} m away. i walk to it first.`)
    this.hands[t.held] = null
    t.held = null
    t.on = f.label
    t.x = f.x
    t.z = f.z
    this.drives.tidy = Math.max(0, this.drives.tidy - 0.35)
    return `the ${t.label} is on the ${f.label}.`
  }

  drop(): string {
    const l = this.heldThing()
    if (!l) throw new ToolError('my hands are empty.')
    const t = this.thing(l)!
    this.hands[t.held!] = null
    t.held = null
    t.on = null
    t.x = clampRoom(this.pose.x + Math.sin(this.pose.yaw) * 0.5)
    t.z = clampRoom(this.pose.z + Math.cos(this.pose.yaw) * 0.5)
    return `the ${t.label} is on the floor in front of me.`
  }

  say(text: string): string {
    const s = text.trim()
    if (!s) throw new ToolError('say needs words.')
    this.hooks.said(s)
    this.drives.social = Math.max(0, this.drives.social - 0.2)
    return 'said.'
  }

  wait(seconds: number, signal: AbortSignal): Promise<string> {
    const s = Math.max(0.5, Math.min(10, Number.isFinite(seconds) ? seconds : 2))
    this.doing = 'waiting'
    this.drives.rest = Math.max(0, this.drives.rest - 0.05 * s)
    return this.start({ kind: 'wait', left: s }, signal).then(() => `i waited ${s.toFixed(1)} s.`)
  }

  /** A seeded spot in the room, away from where the body stands. */
  explore(signal: AbortSignal): Promise<string> {
    let to = { x: 0, z: 0 }
    for (let i = 0; i < 20; i++) {
      to = { x: r2(-ROOM + 2 * ROOM * this.rng()), z: r2(-ROOM + 2 * ROOM * this.rng()) }
      if (dist(to, this.pose) > 1.5) break
    }
    this.doing = 'exploring'
    this.drives.curiosity = Math.max(0, this.drives.curiosity - 0.3)
    const line = this.hooks.log('act', `exploring, heading to ${to.x.toFixed(1)}, ${to.z.toFixed(1)}.`, { live: true, fraction: 0 })
    return this.start({ kind: 'walk', to, what: 'new spot', line, total: dist(this.pose, to) }, signal).then(() => 'i looked around a new part of the room.')
  }

  /** The body API the model sees (P-ROOM-8), the same list the prompt carries. */
  tools(): Tool[] {
    const things = { type: 'string', enum: [...this.things.map((t) => t.label), 'you'] }
    const small = { type: 'string', enum: [...SMALL] }
    const places = { type: 'string', enum: [...FURNITURE] }
    const obj = (props: Record<string, unknown>, required: string[]) => ({ type: 'object', properties: props, required })
    return [
      { name: 'walk_to', description: 'walk up to a thing or to you; stops just short of it.', parameters: obj({ target: things }, ['target']), run: (a, c) => this.walkTo(a[0]!, c.signal) },
      { name: 'look_at', description: 'turn to face a thing or you.', parameters: obj({ target: things }, ['target']), run: (a) => this.lookAt(a[0]!) },
      { name: 'pick_up', description: `lift a small thing within ${REACH} m into a free hand.`, parameters: obj({ thing: small }, ['thing']), run: (a) => this.pickUp(a[0]!) },
      { name: 'put_on', description: 'put a held thing on a piece of furniture within reach.', parameters: obj({ thing: small, place: places }, ['thing', 'place']), run: (a) => this.putOn(a[0]!, a[1]!) },
      { name: 'drop', description: 'put what the hand holds on the floor in front.', run: () => this.drop() },
      { name: 'say', description: 'say a short line out loud.', parameters: obj({ text: { type: 'string' } }, ['text']), run: (a) => this.say(a.join(', ')) },
      { name: 'wait', description: 'stand still for some seconds.', parameters: obj({ seconds: { type: 'number' } }, []), run: (a, c) => this.wait(Number(a[0] ?? 2), c.signal) },
      { name: 'explore', description: 'walk to a part of the room not visited lately.', run: (_a, c) => this.explore(c.signal) },
      { name: 'stop', description: 'stop what the body is doing.', run: () => { this.stop(); return 'stopped.' } },
    ]
  }

  /** Drive scores for free run: the highest picks the next own idea. */
  scores(): { id: Drive; score: number; idea: string }[] {
    const loose = this.things.find((t) => (SMALL as readonly string[]).includes(t.label) && !t.on && !t.held)
    return [
      { id: 'curiosity' as const, score: this.drives.curiosity, idea: 'explore' },
      { id: 'tidy' as const, score: loose ? this.drives.tidy : 0, idea: loose ? `put the ${loose.label} on the shelf` : 'wait' },
      { id: 'social' as const, score: this.drives.social * 0.9, idea: 'come here' },
      { id: 'rest' as const, score: this.drives.rest, idea: 'wait' },
    ]
  }

  /** The state lines a prompt carries: where, holding, doing. */
  state(): string {
    return `standing at ${this.pose.x.toFixed(1)}, ${this.pose.z.toFixed(1)}. ${this.handsLine()} doing: ${this.doing}.`
  }
}
