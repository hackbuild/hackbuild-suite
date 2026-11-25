// The sims a scenario runs against, from the agents tools: the drives run
// (needs and choices on a sim clock) and the mover run (a body steered
// round walls). Each is wrapped in the lockstep contract of
// `@hackbuild/scenario/browser`: `step(n)` and `trace()`, and a handle `h`
// the scenario's actions and probes call. A scenario names its sim in a
// `sim` field the package leaves alone. Rows hold rounded numbers and
// labels only; headings (atan2) stay out of them, since the last digit of
// atan2 differs between engines (the package README, measured).
// Framework free and three free: the node tests run the same steps.
import { seededRng as drivesRng } from '@hackbuild/drives'
import { seededRng } from '@hackbuild/organic'
import type { Sim, SimTrace } from '@hackbuild/scenario/browser'
import { DriveSim, NEEDS, ready as drivesReady } from '../drives/sim.ts'
import { newItem, type ItemKind, type WorldItem } from '../mover/kind.ts'
import { MoverSim } from '../mover/sim.ts'

export const SIMS = ['drives', 'mover'] as const
export type SimName = (typeof SIMS)[number]

/** Steps a second of scenario time for each sim: a drives step is 5 sim seconds, a mover step 1/60 s. */
export const STEPS_PER_SECOND: Record<SimName, number> = { drives: 60, mover: 60 }
/** Steps between trace rows (proposed: 10 rows a second of scenario time). */
const ROW_EVERY = 6

const r = (v: number, d = 1e5) => (Number.isFinite(v) ? Math.round(v * d) / d : null)

export interface DrivesHandle {
  sim: DriveSim
  inject(text: string): boolean
  need(name: string): number
  act(): string
}

export interface MoverHandle {
  sim: MoverSim
  /** The seeded stream of the scenario: actions place things with it. */
  rand(): number
  place(kind: ItemKind, x: number, z: number, turn?: 0 | 1): string
  goal(x: number, z: number): string | null
  /** Meters from the body to the last goal set, or null with none set. */
  gap(): number | null
  x(): number
  z(): number
}

/** The sim is also the handle: actions and probes call `h.place(...)` on it. */
export interface ScenarioSim extends Sim {
  name: SimName
  handle: DrivesHandle | MoverHandle
  /** Where the body stands now, for the stage; display only. */
  spot(): { x: number; z: number; act?: string }
  items(): WorldItem[]
  dispose(): void
}

export async function makeSim(name: SimName, seed: number): Promise<ScenarioSim> {
  if (name === 'drives') {
    await drivesReady()
    const sim = new DriveSim(drivesRng(seed), { startHour: 8, temperature: 0.06, commitment: 0.12 })
    const rows: unknown[][] = []
    const handle: DrivesHandle = {
      sim,
      inject: (text) => !!sim.inject(text),
      need: (k) => sim.drives.values[k as (typeof NEEDS)[number]] ?? Number.NaN,
      act: () => sim.current,
    }
    return Object.assign(Object.create(handle) as DrivesHandle, {
      name: name as SimName, handle,
      step(n: number) {
        for (let i = 0; i < n; i++) {
          const row = sim.tick()
          if (row.step % ROW_EVERY === 0) rows.push([row.step, ...NEEDS.map((k) => r(row.needs[k])), row.act, row.stage])
        }
      },
      trace: (): SimTrace => ({ cols: ['step', ...NEEDS, 'act', 'sleep'], rows: rows.map((x) => x.slice()), hash: sim.hashHex }),
      spot: () => ({ x: 0, z: 0, act: sim.current }),
      items: () => [],
      dispose: () => sim.dispose(),
    })
  }
  const rng = seededRng(seed)
  const sim = new MoverSim([], { x: 0, z: 0 })
  const rows: unknown[][] = []
  let steps = 0
  let goal: { x: number; z: number } | null = null
  const handle: MoverHandle = {
    sim,
    rand: () => rng(),
    place(kind, x, z, turn = 0) {
      const t = newItem(sim.items, kind, x, z, turn)
      sim.setItems([...sim.items, t])
      return t.label
    },
    goal(x, z) {
      const why = sim.setGoal(r(x, 100) ?? 0, r(z, 100) ?? 0)
      if (!why) goal = { x: sim.goal!.x, z: sim.goal!.z }
      return why
    },
    gap: () => (goal ? Math.hypot(goal.x - sim.actor.pos.x, goal.z - sim.actor.pos.z) : null),
    x: () => sim.actor.pos.x,
    z: () => sim.actor.pos.z,
  }
  return Object.assign(Object.create(handle) as MoverHandle, {
    name: name as SimName, handle,
    step(n: number) {
      for (let i = 0; i < n; i++) {
        sim.step(1 / 60)
        steps++
        if (steps % ROW_EVERY === 0) rows.push([steps, r(sim.actor.pos.x), r(sim.actor.pos.z), sim.last?.mode ?? 'arrived', !!sim.goal])
      }
    },
    trace: (): SimTrace => ({ cols: ['step', 'x', 'z', 'mode', 'goal'], rows: rows.map((x) => x.slice()) }),
    spot: () => ({ x: sim.actor.pos.x, z: sim.actor.pos.z }),
    items: () => sim.items.map((t) => ({ ...t })),
    dispose: () => undefined,
  })
}
