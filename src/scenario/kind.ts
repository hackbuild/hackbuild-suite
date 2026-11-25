// The scenario document kind and the built in scenarios (design 3.12).
// A scenario file is the JSON `parseScenario` of `@hackbuild/scenario`
// reads, with a `sim` field naming the agents sim it runs on. The package
// ships the runner and no scenarios, so the built in ones are here, over
// the drives and mover sims. A document keeps the scenarios dropped into
// it, the golden trace recorded for each by name, the picked one and the
// seed, saved as `.hbscenario.json`. Framework free.
import { parseScenario, type Trace } from '@hackbuild/scenario/browser'
import type { DocKind } from '../workspace/kinds.ts'
import { SIMS, type SimName } from './sims.ts'

export const SCENARIO_KIND = 'scenario.suite'

export interface CheckFile {
  what: string
  js: string
  unit?: string
  legal: { min?: number; max?: number }
  constraint: string
  fix?: string
  kind?: 'measured' | 'computed' | 'inferred'
  optional?: boolean
}

export interface ScenarioFile {
  name: string
  sim: SimName
  seed: number
  seconds: number
  note?: string
  actions?: { at?: number; when?: string; js: string }[]
  probes?: { every: number; js: string }[]
  checks?: CheckFile[]
}

export interface Golden {
  seed: number
  rows: unknown[][]
  cols?: string[]
  hash?: string
}

export interface ScenarioBody {
  scenarios: ScenarioFile[]
  goldens: Record<string, Golden>
  picked: string
  /** The seed of the next run; null runs the scenario's own. */
  seed: number | null
}

const WALL = 'set by the wall, 2.4 by 0.2 m at 0, 1.4, and the body radius 0.28 m'

export const BUILT_IN: readonly ScenarioFile[] = [
  {
    name: 'mover round a wall',
    sim: 'mover',
    seed: 7,
    seconds: 10,
    note: 'a wall stands between the body and a goal the seed puts behind it.',
    actions: [{ at: 0, js: "h.place('wall', 0, 1.4); h.goal(h.rand() * 2 - 1, 2.8)" }],
    probes: [{ every: 0.5, js: 'h.gap()' }],
    checks: [
      { what: 'gap at the end', js: 't.probes[t.probes.length - 1][1]', unit: 'm', legal: { max: 0.5 }, constraint: 'set by the arrival radius and the body, inferred', fix: 'check the waypoints round the wall' },
      { what: 'rows inside the wall', js: 't.rows.filter((r) => Math.abs(r[1]) < 1.48 && Math.abs(r[2] - 1.4) < 0.38).length', legal: { max: 0 }, constraint: WALL, kind: 'computed', fix: 'check the colliders of the wall' },
      { what: 'stall', js: 'm.stallSeconds(t.rows.map((r) => [r[1], r[2]]), t.rows.map((r) => r[4]), 0.1)', unit: 's', legal: { max: 1 }, constraint: 'set by the stall detector, 0.2 m in 2 s (package default)', fix: 'check the side waypoint' },
    ],
  },
  {
    name: 'drives a morning',
    sim: 'drives',
    seed: 7,
    seconds: 30,
    note: 'two and a half hours of the body clock from 08:00, 5 sim seconds a step.',
    checks: [
      { what: 'highest need', js: 'Math.max(...t.rows.flatMap((r) => r.slice(1, 5)))', legal: { min: 0, max: 1 }, constraint: 'set by the needs model, 0 to 1', kind: 'computed' },
      { what: 'acts tried', js: 'new Set(t.rows.map((r) => r[5])).size', legal: { min: 2 }, constraint: 'set by the chooser: needs that grow get acted on', kind: 'computed', fix: 'check the temperature and the growth rates' },
      { what: 'switches a sim hour', js: 'm.togglesPerSecond(t.rows.map((r) => r[5]), 30) * 3600', unit: '/h', legal: { max: 40 }, constraint: 'set by the dwell, 90 s mean (proposed)', fix: 'raise the commitment' },
    ],
  },
  {
    name: 'drives food arrives',
    sim: 'drives',
    seed: 7,
    seconds: 15,
    note: 'food arrives at step 300; the goal it raises should win.',
    actions: [{ at: 5, js: "h.inject('food arrives')" }],
    probes: [{ every: 1, js: "h.need('hunger')" }],
    checks: [
      { what: 'steps to eat', js: '(() => { const r = t.rows.find((x) => x[0] > 300 && x[5] === "eat"); return r ? r[0] - 300 : null })()', unit: 'steps', legal: { max: 120 }, constraint: 'set by the goal it raises, 300 sim s', fix: 'check the goal bonus' },
    ],
  },
]

/** Words naming what is wrong with a scenario file, or null. */
export function checkScenarioFile(raw: unknown): string | null {
  const f = raw as Partial<ScenarioFile> | null
  if (!f || typeof f !== 'object') return 'the scenario is not an object.'
  if (!(SIMS as readonly string[]).includes(String(f.sim))) return `sim ${String(f.sim)} is not one of ${SIMS.join(', ')}.`
  try {
    parseScenario(f)
  } catch (e) {
    return `${(e as Error).message}.`
  }
  return null
}

/** A scenario from dropped text: the file, or the words that say why not. */
export function readScenario(text: string): ScenarioFile | string {
  let o: unknown
  try {
    o = JSON.parse(text)
  } catch {
    return 'this file is not json. drop a scenario json.'
  }
  const why = checkScenarioFile(o)
  return why ?? (o as ScenarioFile)
}

export const newScenarioBody = (): ScenarioBody => ({ scenarios: [], goldens: {}, picked: BUILT_IN[0]!.name, seed: null })

export function checkScenarioBody(raw: unknown): string | null {
  const b = raw as Partial<ScenarioBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!Array.isArray(b.scenarios)) return 'scenarios is not a list.'
  for (const s of b.scenarios) {
    const why = checkScenarioFile(s)
    if (why) return why
  }
  if (!b.goldens || typeof b.goldens !== 'object') return 'goldens is not an object.'
  for (const [k, g] of Object.entries(b.goldens)) if (!g || !Array.isArray(g.rows)) return `the golden of ${k} has no rows.`
  if (typeof b.picked !== 'string') return 'picked is not a name.'
  if (b.seed !== null && !Number.isInteger(b.seed)) return 'the seed is not a whole number.'
  return null
}

/** Every scenario the document offers: the built in ones, then the dropped ones by name. */
export function allScenarios(b: ScenarioBody): ScenarioFile[] {
  const own = new Set(b.scenarios.map((s) => s.name))
  return [...BUILT_IN.filter((s) => !own.has(s.name)), ...b.scenarios]
}

/** A trace as the golden a document keeps. */
export const goldenOf = (t: Trace, seed: number): Golden => ({ seed, rows: t.rows, ...(t.cols ? { cols: t.cols } : {}), ...(t.hash ? { hash: t.hash } : {}) })

export const scenarioKind: DocKind<ScenarioBody> = {
  kind: SCENARIO_KIND,
  tool: 'scenario',
  label: 'scenario',
  ext: '.hbscenario.json',
  version: 1,
  create: newScenarioBody,
  check: checkScenarioBody,
  imports: [{
    accept: '.scenario.json',
    label: 'open as a scenario',
    async read(file) {
      const s = readScenario(await file.text())
      if (typeof s === 'string') throw new Error(s)
      return { name: s.name, body: { ...newScenarioBody(), scenarios: [s], picked: s.name } }
    },
  }],
}
