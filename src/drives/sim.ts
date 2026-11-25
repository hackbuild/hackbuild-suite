// The drives tool's run (design 3.12): four needs grow on a sim clock,
// `Drives` scores what each act would reduce, `Chooser` picks with a why,
// `Sleep` and the body clock run the night, `GoalBoost` holds a goal an
// event raised, `MemoryStream` keeps what happened. Fixed steps of sim
// seconds, so a seed and the same injected events give the same trace on
// any frame rate. Three free and framework free; the view and the tests
// both run it.
import { Chooser, Drives, GoalBoost, MemoryStream, Sleep, bodyClock, load, type Decision, type SleepStage } from '@hackbuild/drives'
import { fnv, hex8 } from '../agents/props.ts'

export const ready = (): Promise<void> => load()

export const NEEDS = ['hunger', 'rest', 'play', 'social'] as const
export type Need = (typeof NEEDS)[number]
export const ACTS = ['idle', 'eat', 'rest', 'play', 'greet'] as const
export type Act = (typeof ACTS)[number]

/** Sim seconds a step covers (proposed). */
export const STEP = 5

/** Growth of each need a sim minute (proposed; rest follows the sleep model instead). */
const GROW: Record<Exclude<Need, 'rest'>, number> = { hunger: 0.0035, play: 0.006, social: 0.0045 }
/** What an act is expected to do to the needs, the effect the chooser scores. */
export const EFFECT: Record<Act, Partial<Record<Need, number>>> = {
  idle: {},
  eat: { hunger: -0.5 },
  rest: { rest: -0.35 },
  play: { play: -0.45, rest: 0.04 },
  greet: { social: -0.45 },
}
/** Reduction a sim minute while the act runs (proposed). */
const RATE: Partial<Record<Act, Partial<Record<Need, number>>>> = { eat: { hunger: -0.06 }, play: { play: -0.05 }, greet: { social: -0.07 } }
/** An act is done when its need is under this, or after its longest run in sim minutes (proposed). */
const DONE_UNDER = 0.08
const LONGEST: Record<Act, number> = { idle: 3, eat: 8, rest: 480, play: 12, greet: 6 }
/** Seconds an act holds before the chooser looks again, the ex-Gaussian mean part (proposed for acts of minutes). */
const DWELL = 90
/** Utility of doing nothing (vendor example). */
const IDLE = 0.12

export const EVENT_KINDS = ['food arrives', 'a visitor', 'the ball rolls by', 'a loud noise'] as const
export type EventKind = (typeof EVENT_KINDS)[number]

/** Which event a sentence names, by its words; null when it names none. */
export function eventOf(text: string): EventKind | null {
  const s = text.toLowerCase()
  if (/\b(food|eat|bowl|dinner|treat|meal)\b/.test(s)) return 'food arrives'
  if (/\b(visitor|friend|knock|door|guest|someone)\b/.test(s)) return 'a visitor'
  if (/\b(ball|toy|fetch|play)\b/.test(s)) return 'the ball rolls by'
  if (/\b(noise|bang|loud|thunder|crash)\b/.test(s)) return 'a loud noise'
  return null
}

export interface Injected {
  /** The step it lands on. */
  step: number
  kind: EventKind
  text: string
}

export interface Goal {
  id: Act
  why: string
  from: number
  until: number
  status: 'open' | 'done' | 'expired'
}

export interface Row {
  step: number
  t: number
  hour: number
  needs: Record<Need, number>
  act: Act
  reason: string
  probability: number
  switched: boolean
  stage: SleepStage
  pressure: number
  why: string
}

export interface SimOptions {
  /** Hour of the body clock at the start, 0 to 24. */
  startHour: number
  temperature: number
  commitment: number
}

const r6 = (v: number) => (Number.isFinite(v) ? v.toFixed(6) : 'nan')

export class DriveSim {
  step = 0
  readonly drives: Drives<Need>
  readonly chooser: Chooser<Act>
  readonly sleep: Sleep
  readonly memory = new MemoryStream({ capacity: 64 })
  readonly boost = new GoalBoost<Act>(0.25)
  readonly rows: Row[] = []
  readonly goals: Goal[] = []
  readonly injected: Injected[] = []
  last: Decision<Act> | null = null
  hash = 0x811c9dc5
  private runFor = 0
  private queue: Injected[] = []

  readonly opts: SimOptions

  constructor(rng: () => number, opts: SimOptions) {
    this.opts = opts
    this.drives = new Drives<Need>({ hunger: 1, rest: 0.9, play: 0.7, social: 0.8 })
    this.drives.set({ hunger: 0.3, rest: 0.2, play: 0.35, social: 0.25 })
    this.chooser = new Chooser<Act>({ rng, options: ACTS, start: 'idle', temperature: opts.temperature, commitment: opts.commitment, dwellMu: DWELL, dwellTau: DWELL / 2 })
    this.sleep = new Sleep({ rng, pressure: 0.3 })
  }

  get t() { return this.step * STEP }
  get hour() { return (this.opts.startHour + this.t / 3600) % 24 }
  get hashHex() { return hex8(this.hash) }
  get current(): Act { return this.chooser.current }

  /** Queues an event for the next step; returns null when the sentence names no need. */
  inject(text: string): Injected | null {
    const kind = (EVENT_KINDS as readonly string[]).includes(text) ? (text as EventKind) : eventOf(text)
    if (!kind) return null
    const e = { step: this.step + 1, kind, text }
    this.queue.push(e)
    return e
  }

  private apply(e: Injected) {
    const now = this.t
    const v = this.drives.values
    const goal = (id: Act, secs: number, why: string) => {
      for (const g of this.goals) if (g.status === 'open') g.status = 'expired'
      this.boost.set(id, now, secs, why)
      this.goals.push({ id, why, from: now, until: now + secs, status: 'open' })
    }
    if (e.kind === 'food arrives') { this.drives.set({ hunger: Math.min(1, v.hunger + 0.2) }); goal('eat', 300, 'food arrived') }
    if (e.kind === 'a visitor') { this.drives.set({ social: Math.min(1, v.social + 0.3) }); goal('greet', 240, 'a visitor came') }
    if (e.kind === 'the ball rolls by') { this.drives.set({ play: Math.min(1, v.play + 0.3) }); goal('play', 180, 'the ball rolled by') }
    if (e.kind === 'a loud noise' && this.sleep.stage !== 'awake') { this.sleep.wakeUp(); this.chooser.markDone() }
    this.memory.add(`${e.kind}: ${e.text}`, e.kind === 'a loud noise' ? 0.8 : 0.5, this.hour)
    this.injected.push(e)
    this.hash = fnv(`ev|${e.step}|${e.kind};`, this.hash)
  }

  /** One fixed step of STEP sim seconds. */
  tick(): Row {
    this.step++
    const now = this.t
    const hour = this.hour
    while (this.queue.length && this.queue[0]!.step <= this.step) this.apply(this.queue.shift()!)
    const act = this.chooser.current
    const minutes = STEP / 60
    const asleep = this.sleep.stage !== 'awake'
    // needs grow; rest is the sleep model's fatigue at this hour
    this.drives.grow(minutes, GROW)
    if (asleep) {
      if (this.sleep.step(minutes, hour)) this.chooser.markDone()
    } else this.sleep.pressureStep(minutes / 60, act === 'play' ? 1 : act === 'idle' ? 0.2 : 0.5)
    const fat = this.sleep.fatigue(hour, act === 'play')
    this.drives.set({ rest: Math.max(0, Math.min(1, fat)) })
    const rate = RATE[act]
    if (rate) {
      const v = this.drives.values
      const next: Partial<Record<Need, number>> = {}
      for (const [k, d] of Object.entries(rate) as [Need, number][]) next[k] = Math.max(0, v[k] + d * minutes)
      this.drives.set(next)
    }
    this.runFor += minutes
    const need = Object.keys(EFFECT[act])[0] as Need | undefined
    if (!this.chooser.done && act !== 'rest' && (this.runFor >= LONGEST[act] || (need && this.drives.values[need] < DONE_UNDER))) {
      this.chooser.markDone()
      for (const g of this.goals) if (g.status === 'open' && g.id === act) g.status = 'done'
    }
    for (const g of this.goals) if (g.status === 'open' && now >= g.until) g.status = 'expired'
    // score every act by what it would reduce; the goal adds its bonus
    const u: Partial<Record<Act, number>> = { idle: IDLE }
    for (const a of ACTS) if (a !== 'idle') u[a] = this.drives.rewardOf(EFFECT[a])
    // asleep, the chooser does not sample: rest holds until the sleep ends
    const d = this.chooser.update(now, this.boost.apply(now, u), this.lastReactive(), this.sleep.stage !== 'awake' && !this.chooser.done ? 'rest' : undefined)
    this.last = d
    if (d.switched) {
      this.runFor = 0
      if (d.current === 'rest') this.sleep.lieDown()
      else if (act === 'rest' && this.sleep.stage !== 'awake') this.sleep.wakeUp()
      this.memory.add(`${d.current}: ${d.why}`, 0.2, hour)
    }
    const v = this.drives.values
    const row: Row = {
      step: this.step, t: now, hour, needs: { hunger: v.hunger, rest: v.rest, play: v.play, social: v.social },
      act: d.current, reason: d.reason, probability: d.probability, switched: d.switched, stage: this.sleep.stage, pressure: this.sleep.pressure, why: d.why,
    }
    this.rows.push(row)
    if (this.rows.length > 20000) this.rows.shift()
    this.hash = fnv(`${row.step}|${r6(v.hunger)}|${r6(v.rest)}|${r6(v.play)}|${r6(v.social)}|${row.act}|${row.reason}|${r6(row.probability)}|${row.stage}|${r6(row.pressure)};`, this.hash)
    return row
  }

  /** The ball rolling by cannot wait: play is reactive on the step after it. */
  private lastReactive(): Act[] {
    const e = this.injected[this.injected.length - 1]
    return e && e.kind === 'the ball rolls by' && e.step === this.step ? ['play'] : []
  }

  /** Utilities of the last update, for the choice bars. */
  utilities(): Record<Act, number> {
    return (this.last?.utilities ?? Object.fromEntries(ACTS.map((a) => [a, 0]))) as Record<Act, number>
  }

  sleepiness(): number {
    return bodyClock(this.hour)
  }

  dispose() {
    this.drives.free()
    this.chooser.free()
    this.sleep.free()
    this.memory.free()
  }
}

/** A seeded run of n steps with events at given steps: the trace hash the tests and the smoke compare. */
export function runSteps(sim: DriveSim, n: number, events: readonly { step: number; text: string }[] = []): string {
  const todo = [...events].sort((a, b) => a.step - b.step)
  for (let i = 0; i < n; i++) {
    while (todo.length && todo[0]!.step <= sim.step + 1) sim.inject(todo.shift()!.text)
    sim.tick()
  }
  return sim.hashHex
}

export const hhmm = (hour: number) => `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.floor((hour % 1) * 60)).padStart(2, '0')}`

/** The run as csv, one row a step (P-SAVE-10). */
export function runCsv(rows: readonly Row[]): string {
  const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
  const head = 't,hour,hunger,rest,play,social,act,reason,probability,switched,sleep,pressure,why'
  return [head, ...rows.map((r) => [r.t, r.hour.toFixed(4), ...NEEDS.map((k) => r.needs[k].toFixed(5)), r.act, r.reason, Number.isFinite(r.probability) ? r.probability.toFixed(4) : '', r.switched ? 1 : 0, r.stage, r.pressure.toFixed(5), q(r.why)].join(','))].join('\n') + '\n'
}
