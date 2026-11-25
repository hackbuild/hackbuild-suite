// One scenario run on its sim through the browser entry of
// `@hackbuild/scenario`: the report, the trace with its hash, and the
// golden comparison when one is kept. The view adds the transport through
// `gate`; the tests call it bare. Framework free.
import { diffMessage, formatReport, parseScenario, reportPasses, runScenarios, traceHash, type Report, type ScenarioEvent, type Trace } from '@hackbuild/scenario/browser'
import type { Golden, ScenarioFile } from './kind.ts'
import { makeSim, STEPS_PER_SECOND, type ScenarioSim } from './sims.ts'

export interface RunResult {
  report: Report
  trace: Trace
  pass: boolean
  text: string
  /** Hash of rows, probes and fired: the same on every engine for the same numbers. */
  hash: string
  /** Against the golden: "traces match", the first difference, or null with none kept. */
  diff: string | null
}

export interface RunHooks {
  onEvent?: (e: ScenarioEvent) => void
  onSim?: (s: ScenarioSim) => void
  /** Awaited before each chunk of steps: the transport holds the run here. */
  gate?: () => Promise<void> | void
  date?: string
  browser?: string
}

export async function runFile(file: ScenarioFile, seed: number, golden: Golden | null, o: RunHooks = {}): Promise<RunResult> {
  const sc = { ...parseScenario(file), seed }
  let made: ScenarioSim | null = null
  const report = await runScenarios({
    scenarios: [sc],
    stepsPerSecond: STEPS_PER_SECOND[file.sim],
    makeSim: async (s) => {
      const sim = await makeSim(file.sim, s)
      made = sim
      o.onSim?.(sim)
      const step = sim.step.bind(sim)
      sim.step = async (n: number) => {
        await o.gate?.()
        step(n)
      }
      return sim
    },
    ...(golden ? { goldens: { [sc.name]: golden } } : {}),
    ...(o.onEvent ? { onEvent: o.onEvent } : {}),
    ...(o.date ? { date: o.date } : {}),
    ...(o.browser ? { browser: o.browser } : {}),
  })
  const trace = report.traces[sc.name] ?? { rows: [], probes: [], fired: [], wallSeconds: 0 }
  ;(made as ScenarioSim | null)?.dispose()
  const { traces: _t, ...plain } = report
  return {
    report: plain,
    trace,
    pass: reportPasses(plain),
    text: formatReport(plain),
    hash: traceHash(trace),
    diff: golden ? diffMessage(trace, golden) : null,
  }
}
