<script setup lang="ts">
// The scenario tool (design 3.12): pick or drop a scenario, run it in
// lockstep on the drives or mover sim, read the metrics and the report,
// keep a golden trace and diff two traces row by row. A browser view of
// `@hackbuild/scenario`, a headless harness until now (rank 74). Ports:
// the validator verdict of the PAWL original (P-TRACE-8, no model), the
// check rows of the BAIL original (P-DEPTH-11) and the load card of the
// GROMMET original (P-LOAD-15). The transport holds the run between
// chunks of steps; the period key lets one chunk through.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbChecks, HbChipGroup, HbExportPanel, HbFold, HbHow, HbKv, HbSparkRows, HbTable, HbVerdict,
  type HbCheckRow, type HbExportFormat, type HbExportReadout, type HbExportRequest, type HbSparkRow, type HbVerdictStatus,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { checkMessage, diffRows, parseTrace, verdict, type ScenarioEvent, type Trace } from '@hackbuild/scenario/browser'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { claimDrops, exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import type { Room } from '../agents/scene.ts'
import type { WorldView } from '../mover/bind.ts'
import { SCENARIO_KIND, allScenarios, goldenOf, readScenario, scenarioKind, type Golden, type ScenarioBody, type ScenarioFile } from './kind.ts'
import type { RunResult } from './run.ts'
import type { ScenarioSim } from './sims.ts'
import how from '@hackbuild/scenario/how'

if (!kinds.get(SCENARIO_KIND)) registerKind(scenarioKind)

/** Where each drives act happens in the room, as the drives tool has it. */
const AT: Record<string, { x: number; z: number }> = { idle: { x: 0, z: 0 }, eat: { x: 1.6, z: 1.1 }, rest: { x: -2.5, z: -1.5 }, play: { x: 1.2, z: -2.1 }, greet: { x: -1.5, z: 2.5 } }
const STATIONS = [{ label: 'bowl', x: 2, z: 1.5 }, { label: 'bed', x: -2.5, z: -1.5 }, { label: 'ball', x: 1.5, z: -2.5 }, { label: 'door', x: -1.5, z: 3 }]
/** Wall ms between chunks while the run plays, so the stage can be watched (proposed). */
const PACE = 16
const EMPTY = 'pick a scenario, or drop a scenario json.'

const tool = useStageTool({
  id: 'scenario',
  pad: false,
  empty: EMPTY,
  restart: (_rng, seed) => void start(seed),
  // the step key pauses first, then ticks once: one chunk through the gate
  tick: () => { if (!tool.transport.playing) tokens++ },
  hints: (base) => base.filter((h) => h.keys !== '1 to 4'),
})

const doc = useDocument<ScenarioBody>(SCENARIO_KIND)
const body = reactive<ScenarioBody>(scenarioKind.create())
const open = reactive({ pick: true, run: true, report: true, diff: true, export: false })
const list = computed(() => allScenarios(body))
const picked = ref('')
const current = computed<ScenarioFile | null>(() => list.value.find((s) => s.name === picked.value) ?? null)
const result = shallowRef<RunResult | null>(null)
/** The trace the diff compares against: the golden, or a dropped trace. */
const other = shallowRef<{ from: string; trace: Trace } | null>(null)
const live = reactive({
  state: 'idle' as 'idle' | 'running' | 'paused' | 'done' | 'failed',
  step: 0, total: 0, seconds: 0, seed: 7, note: '',
  probes: [] as number[], events: [] as { step: number; what: string }[],
})
let tokens = 0
let runId = 0
let lib: typeof import('./run.ts') | null = null
let bind: typeof import('../mover/bind.ts') | null = null
let scene: typeof import('../agents/scene.ts') | null = null
let world: WorldView | null = null
let room: Room | null = null
let sim: ScenarioSim | null = null
let framed: unknown = null

function save(fn: (d: ScenarioBody) => void) {
  fn(body)
  if (doc.doc.value) doc.edit(fn)
}

const golden = computed<Golden | null>(() => (current.value ? body.goldens[current.value.name] ?? null : null))

// ------------------------------------------------------------- run

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function gate(id: number) {
  for (;;) {
    if (id !== runId) throw new Error('restarted')
    if (tool.transport.playing) { live.state = 'running'; await wait(PACE); return }
    live.state = 'paused'
    if (tokens > 0) { tokens--; return }
    await wait(30)
  }
}

function onEvent(e: ScenarioEvent) {
  if (e.type === 'step') {
    live.step = e.step
    live.total = e.total
    live.seconds = e.simSeconds
    show()
  } else if (e.type === 'probe') {
    if (typeof e.value === 'number' && Number.isFinite(e.value)) live.probes.push(e.value)
  } else {
    live.events.unshift({ step: e.step, what: e.type === 'fired' ? `fired: ${e.when}` : e.type === 'shot' ? `shot ${e.path}` : 'action ran' })
    if (live.events.length > 12) live.events.pop()
  }
}

async function start(seed: number) {
  const sc = current.value
  if (!sc || !lib) return
  const id = ++runId
  tokens = 0
  Object.assign(live, { state: 'running', step: 0, total: 0, seconds: 0, seed, note: '', probes: [], events: [] })
  result.value = null
  tool.body.line = `seed ${seed} is running. ${sc.note ?? ''}`.trim()
  try {
    const r = await lib.runFile(sc, seed, golden.value, {
      onEvent: (e) => { if (id === runId) onEvent(e) },
      onSim: (s) => { if (id === runId) { sim = s; stage() } },
      gate: () => gate(id),
    })
    if (id !== runId) return
    result.value = r
    live.state = r.pass ? 'done' : 'failed'
    const first = r.report.results[0]
    const fails = first?.checks.filter((c) => verdict(c) === 'fail') ?? []
    tool.body.line = r.diff && r.diff !== 'traces match' ? `${r.diff}.` : fails[0] ? `${checkMessage(fails[0])}.` : first?.errors[0] ? `${first.errors[0]}.` : `${sc.name}: checks pass at seed ${seed}.`
    logEvent(r.pass ? 'note' : 'fail', `scenario: ${sc.name} seed ${seed} ${r.pass ? 'pass' : 'fail'}, hash ${r.hash}`)
  } catch (e) {
    if (id !== runId) return
    live.state = 'failed'
    tool.body.line = `the run stopped: ${(e as Error).message}.`
  }
}

/** The stage: the mover world and body, or the drives room with the body at its act. Display only. */
function stage() {
  const w = tool.walk.value
  if (!w || !sim || !bind || !scene) return
  if (sim.name === 'mover') {
    room?.dispose(); room = null
    if (!world) world = new bind.WorldView(w.stage.scene, [], tone('--hb-pink') || '#e0457b')
  } else {
    world?.dispose(); world = null
    if (!room) room = new scene.Room(w.stage.scene, STATIONS)
  }
  // the whole room from above, as the mover tool frames it
  if (framed !== w) {
    framed = w
    const fog = w.stage.scene.fog as { near: number; far: number } | null
    if (fog && 'near' in fog) { fog.near = 18; fog.far = 40 }
    tool.view.value = 'top'
    w.view('top')
    void nextTick(() => {
      w.stage.controls.maxDistance = Math.max(w.stage.controls.maxDistance, 30)
      w.stage.zoomBy(0.3)
    })
  }
  show()
}

function show() {
  const w = tool.walk.value
  if (!w || !sim) return
  const p = sim.spot()
  if (sim.name === 'mover' && world) {
    world.set(sim.items())
    const m = (sim.handle as { sim: { goal: { x: number; z: number } | null; path: { x: number; z: number }[]; leg: number; actor: { vel: { x: number; z: number } } } }).sim
    world.goal(m.goal, p, m.path.slice(m.leg))
    const v = m.actor.vel
    w.place(p.x, p.z, Math.hypot(v.x, v.z) > 0.05 ? Math.atan2(v.x, v.z) : 0)
  } else if (p.act) {
    const to = AT[p.act] ?? AT.idle!
    w.place(to.x, to.z, 0)
  }
  w.stage.loop.invalidate()
}

function pick(name: string) {
  if (!name || name === body.picked && picked.value === name && result.value) return
  picked.value = name
  save((d) => { d.picked = name })
  other.value = null
  const sc = current.value
  if (!sc) return
  // a new seed restarts through the seed watch; the same seed restarts here
  if (tool.seed.value !== sc.seed) tool.seed.value = sc.seed
  else tool.restart()
}

function recordGolden() {
  const r = result.value
  const sc = current.value
  if (!r || !sc) return
  const g = goldenOf(r.trace, live.seed)
  save((d) => { d.goldens = { ...d.goldens, [sc.name]: g } })
  tool.body.line = `golden kept for ${sc.name}: ${g.rows.length} rows at seed ${live.seed}.`
  logEvent('note', `scenario: golden for ${sc.name}, ${g.rows.length} rows`)
}

function dropGolden() {
  const sc = current.value
  if (!sc) return
  save((d) => { const g = { ...d.goldens }; delete g[sc.name]; d.goldens = g })
  tool.body.line = `no golden for ${sc.name} now.`
}

// ------------------------------------------------------------- drop

async function take(files: File[]) {
  for (const f of files) {
    const text = await f.text()
    let o: unknown = null
    try { o = JSON.parse(text) } catch { /* named below */ }
    if (o && typeof o === 'object' && Array.isArray((o as { rows?: unknown }).rows)) {
      try {
        other.value = { from: f.name, trace: parseTrace(o) }
        tool.body.line = `${f.name}: ${other.value.trace.rows.length} rows to diff against.`
      } catch (e) { tool.body.line = `${f.name}: ${(e as Error).message}.` }
      continue
    }
    const s = readScenario(text)
    if (typeof s === 'string') { tool.body.line = `${f.name}: ${s}`; continue }
    save((d) => { d.scenarios = [...d.scenarios.filter((x) => x.name !== s.name), s] })
    logEvent('note', `scenario: ${s.name} from ${f.name}`)
    pick(s.name)
  }
}
claimDrops({ accept: (f) => /\.json$/i.test(f.name) && !kinds.isDocFile(f.name), take: (f) => void take(f) })

// ------------------------------------------------------------- views

const status = computed<HbVerdictStatus>(() => (live.state === 'running' || live.state === 'paused' ? 'running' : result.value ? (result.value.pass ? 'pass' : 'fail') : 'not run'))
const verdictText = computed(() => {
  const r = result.value
  if (live.state === 'paused') return `paused at step ${live.step}`
  if (!r) return live.state === 'running' ? `step ${live.step} of ${live.total}` : 'not run'
  const s = r.report.results[0]
  const n = s?.checks.length ?? 0
  const f = s?.checks.filter((c) => verdict(c) === 'fail').length ?? 0
  return `${r.pass ? 'pass' : 'fail'}: ${n - f} of ${n} checks${s?.golden ? `, golden ${s.golden}` : ''}`
})
const checks = computed<HbCheckRow[]>(() => (result.value?.report.results[0]?.checks ?? []).map((c) => {
  const v = verdict(c)
  return { id: c.what, status: v, value: c.measured === null ? 'not run' : `${Number(c.measured.toPrecision(4))}${c.unit ? ` ${c.unit}` : ''} (${c.kind ?? 'measured'})`, reason: checkMessage(c) }
}))
const sparks = computed<HbSparkRow[]>(() => (live.probes.length ? [{ id: 'probe', label: current.value?.probes?.[0]?.js ?? 'probe', values: live.probes.slice(-120), value: live.probes[live.probes.length - 1] ?? 0 }] : []))
const against = computed<{ from: string; trace: { rows: unknown[][]; hash?: string | null } } | null>(() => other.value ?? (golden.value ? { from: `golden, seed ${golden.value.seed}`, trace: golden.value } : null))
const diff = computed(() => {
  const r = result.value
  const b = against.value
  if (!r || !b) return null
  const d = diffRows(r.trace, b.trace, 40)
  const cols = r.trace.cols ?? []
  const fmt = (v: unknown) => (typeof v === 'number' ? String(Number(v.toPrecision(5))) : JSON.stringify(v))
  return {
    ...d,
    table: d.rows.map((x) => ({ row: x.row, step: fmt((r.trace.rows[x.row] ?? [])[0] ?? ''), col: x.col < 0 ? 'row' : cols[x.col] ?? `column ${x.col}`, a: fmt(x.a), b: fmt(x.b) })),
  }
})
const diffLine = computed(() => {
  const d = diff.value
  if (!d) return 'no trace to diff against. keep a golden, or drop a trace json.'
  return d.differing ? `${d.differing} of ${d.compared} rows differ from ${against.value?.from}.` : `all ${d.compared} rows match ${against.value?.from}.`
})

// ------------------------------------------------------------- export

const name = computed(() => `scenario-${(current.value?.name ?? 'run').replace(/\s+/g, '-')}-${live.seed}`)
const formats: HbExportFormat[] = [
  { key: 'report', label: 'report', ext: '.txt', note: 'the report in the check message form: what, measured, legal, constraint, fix.' },
  { key: 'trace', label: 'trace', ext: '.trace.json', note: 'the rows with their columns, the probes, what fired and the hash.' },
  { key: 'scenario', label: 'scenario', ext: '.scenario.json', note: 'the scenario file with its sim, seed, actions, probes and checks.' },
  { key: 'doc', label: 'document', ext: scenarioKind.ext, note: 'the dropped scenarios, a golden trace for each, the picked one and the seed.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'verdict', value: verdictText.value },
  { label: 'trace hash', value: result.value?.hash ?? 'none yet' },
  { label: 'seed', value: String(live.seed) },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  const r = result.value
  const sc = current.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  if (req.format === 'scenario') {
    if (sc) saveFile(`${fname}.scenario.json`, JSON.stringify(sc, null, 2), 'application/json')
    return
  }
  if (!r) { tool.body.line = 'no run yet. press play.'; return }
  if (req.format === 'report') saveFile(`${fname}.txt`, `${r.text}\n`, 'text/plain')
  else saveFile(`${fname}.trace.json`, JSON.stringify({ format: 'hackbuild.scenario-trace', version: 1, scenario: sc?.name, sim: sc?.sim, seed: live.seed, hash: r.hash, ...r.trace }), 'application/json')
  logEvent('note', `scenario: exported ${req.format}, hash ${r.hash}`)
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === SCENARIO_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('scenarios')
  const d = doc.body.value
  if (d) Object.assign(body, { scenarios: d.scenarios.map((s) => ({ ...s })), goldens: { ...d.goldens }, picked: d.picked, seed: d.seed })
  const [r, b, s] = await Promise.all([import('./run.ts'), import('../mover/bind.ts'), import('../agents/scene.ts')])
  lib = r
  bind = b
  scene = s
  picked.value = list.value.some((x) => x.name === body.picked) ? body.picked : list.value[0]!.name
  const sc = current.value!
  const seed = body.seed ?? sc.seed
  if (tool.seed.value !== seed) tool.seed.value = seed
  else void start(seed)
})

watch(() => tool.seed.value, (s) => save((d) => { d.seed = s }))
watch(() => tool.walk.value, () => stage())

onBeforeUnmount(() => {
  runId++
  world?.dispose()
  room?.dispose()
})

// for the smoke: the tool handle on the stage host, no global
watch(() => tool.host.value, (el) => {
  if (el) (el as HTMLElement & { scenario?: unknown }).scenario = { live, body, result: () => result.value, diff: () => diff.value, pick, recordGolden, seed: tool.seed }
}, { immediate: true })

</script>

<template>
  <StageTool :tool="tool" title="scenario">
    <template #under>
      <HbChipGroup :model-value="picked" :options="list.map((s) => s.name)" label="scenario" data-scenarios @update:model-value="(v) => pick(String(v))" />
      <div class="hb-instrument" data-pane="verdict">
        <HbVerdict :status="status" :text="verdictText" />
        <HbKv label="step" :value="`${live.step} of ${live.total || '--'}, seed ${live.seed}`" />
      </div>
    </template>

    <template #rack>
      <HbFold v-model="open.pick" :num="0" summary="scenario" persist-key="scenario-pick">
        <div class="hb-instrument" data-pane="pick">
          <HbKv label="sim" :value="current?.sim ?? 'none'" />
          <HbKv label="length" :value="current ? `${current.seconds} s, ${current.seconds * 60} steps` : '--'" />
          <HbKv label="checks" :value="current?.checks?.length ?? 0" />
          <p v-if="current?.note" class="hb-hint">{{ current.note }}</p>
          <p class="hb-hint">drop a scenario json: name, sim (drives or mover), seed, seconds, actions, probes and checks. code fields run in this page, so drop only files you trust.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.run" :num="1" summary="run" persist-key="scenario-run">
        <div class="hb-instrument" data-pane="run">
          <HbKv label="state" :value="live.state" />
          <HbKv label="sim time" :value="`${live.seconds.toFixed(2)} s`" />
          <HbSparkRows v-if="sparks.length" :rows="sparks" label="probe" :digits="3" />
          <HbTable v-if="live.events.length" :columns="[{ key: 'step', label: 'step', numeric: true }, { key: 'what', label: 'what' }]" :rows="live.events" />
          <p class="hb-hint">space holds the run between chunks of 30 steps; the period key lets one chunk through; r runs it again with the same seed.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.report" :num="2" summary="report" persist-key="scenario-report">
        <div class="hb-instrument" data-pane="report">
          <HbChecks v-if="checks.length" :rows="checks" caption="checks" />
          <pre v-if="result" data-report>{{ result.text }}</pre>
          <p v-else class="hb-hint">the report shows when the run ends.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.diff" :num="3" summary="golden and diff" persist-key="scenario-diff">
        <div class="hb-instrument" data-pane="diff">
          <HbKv label="golden" :value="golden ? `${golden.rows.length} rows, seed ${golden.seed}` : 'none kept'" />
          <HbKv label="trace hash" :value="result?.hash ?? '--'" data-hash />
          <HbButton variant="secondary" size="sm" :disabled="!result" data-golden @click="recordGolden">keep this run as the golden</HbButton>
          <HbButton v-if="golden" variant="secondary" size="sm" @click="dropGolden">forget the golden</HbButton>
          <p class="hb-hint" data-diff>{{ result?.diff && result.diff !== 'traces match' ? `${result.diff}. ` : '' }}{{ diffLine }}</p>
          <HbTable
            v-if="diff && diff.table.length"
            :columns="[{ key: 'row', label: 'row', numeric: true }, { key: 'step', label: 'step', numeric: true }, { key: 'col', label: 'column' }, { key: 'a', label: 'this run', numeric: true }, { key: 'b', label: 'expected', numeric: true }]"
            :rows="diff.table"
            data-diff-rows
          />
        </div>
      </HbFold>

      <HbFold v-model="open.export" :num="4" summary="export" persist-key="scenario-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="lib ? '' : 'the runner is starting.'" label="scenario" @export="onExport" />
      </HbFold>

      <HbHow v-bind="how" persist-key="scenario-how" />
    </template>
  </StageTool>
</template>
