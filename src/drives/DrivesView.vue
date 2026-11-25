<script setup lang="ts">
// The drives tool (design 3.12): needs rise on a sim clock and the
// chooser picks what to do, with the reason. Ported from the drive bars of
// the gimbal original's affect panel (P-ROOM-10), the inject row of the
// splice original (P-ROOM-13) and the mind tab of the room original
// (P-ROOM-6: drives, goals kept until done). New here: "why this choice"
// rows from `Chooser`, the body clock and the hypnogram from `Sleep`, and
// the run as csv (P-SAVE-10). Fixed steps of sim seconds: a seed and the
// same events give the same trace hash at any frame rate.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbChipGroup, HbChoiceBars, HbExportPanel, HbFold, HbGauges, HbHow, HbInput, HbKv, HbList, HbParamRow, HbSparkRows, HbTable, HbWave,
  type HbChoiceOption, type HbExportFormat, type HbExportReadout, type HbExportRequest, type HbGaugeRow, type HbSparkRow,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import type { Rng } from '@hackbuild/organic'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import type { Placed } from '../agents/props.ts'
import type { Room } from '../agents/scene.ts'
import { DRIVES_KIND, drivesKind, type DrivesBody } from './kind.ts'
import type { Act, DriveSim, Need } from './sim.ts'

if (!kinds.get(DRIVES_KIND)) registerKind(drivesKind)

const NEED_WORDS: Need[] = ['hunger', 'rest', 'play', 'social']
const ACT_WORDS: Act[] = ['idle', 'eat', 'rest', 'play', 'greet']
const EVENTS = ['food arrives', 'a visitor', 'the ball rolls by', 'a loud noise']
/** Where each act happens in the room; idle stands in the middle (proposed). */
const STATIONS: Placed[] = [{ label: 'bowl', x: 2, z: 1.5 }, { label: 'bed', x: -2.5, z: -1.5 }, { label: 'ball', x: 1.5, z: -2.5 }, { label: 'door', x: -1.5, z: 3 }]
const AT: Record<Act, { x: number; z: number }> = { idle: { x: 0, z: 0 }, eat: { x: 1.6, z: 1.1 }, rest: { x: -2.5, z: -1.5 }, play: { x: 1.2, z: -2.1 }, greet: { x: -1.5, z: 2.5 } }
/** Samples the drive rows keep, and steps a sample covers (proposed). */
const SAMPLES = 120
const EVERY = 12

const tool = useStageTool({
  id: 'drives',
  empty: 'the agent walks to what it chose. inject an event to steer it.',
  tunables: (reg) => {
    reg.define({ key: 'drives.speed', group: 'run', label: 'sim speed', def: 60, min: 1, max: 3600, step: 1, unit: 'x', note: 'sim seconds a wall second; an hour of the body clock takes a minute at 60.', source: 'inferred' })
    reg.define({ key: 'drives.hour', group: 'run', label: 'start hour', def: 8, min: 0, max: 23, step: 1, unit: 'h', note: 'the body clock at the start of a run.', source: 'inferred' })
    reg.define({ key: 'drives.temperature', group: 'choice', label: 'temperature', def: 0.06, min: 0.01, max: 0.5, step: 0.01, unit: '', note: 'softmax temperature: higher picks lower scores more often.', source: 'vendor', cite: 'Chooser default' })
    reg.define({ key: 'drives.commitment', group: 'choice', label: 'commitment', def: 0.12, min: 0, max: 0.5, step: 0.01, unit: '', note: 'bonus on the current act while it is not done.', source: 'vendor', cite: 'Chooser default' })
  },
  restart: (rng) => begin(rng),
  tick: (dt) => frame(dt),
})

const doc = useDocument<DrivesBody>(DRIVES_KIND)
const opts = reactive<DrivesBody>(drivesKind.create())
const open = reactive({ drives: true, choice: true, goals: true, clock: true, inject: true, run: false, export: false })
const sim = shallowRef<DriveSim | null>(null)
const said = ref('')
const event = ref<string>('')
const live = reactive({
  step: 0, hour: 8, clock: '--', act: 'idle' as Act, why: '', reason: '', stage: 'awake', pressure: 0, sleepiness: 0, wake: 0, hash: '', bonus: 0,
  needs: { hunger: 0, rest: 0, play: 0, social: 0 } as Record<Need, number>,
  utilities: { idle: 0, eat: 0, rest: 0, play: 0, greet: 0 } as Record<Act, number>, prob: Number.NaN,
  history: { hunger: [], rest: [], play: [], social: [] } as Record<Need, number[]>, ticks: [] as number[],
  whys: [] as { t: string; act: string; reason: string; p: string; why: string }[],
  goals: [] as { goal: string; why: string; status: string; until: string }[],
  memory: [] as string[], stages: [] as string[], note: '',
})
let lib: typeof import('./sim.ts') | null = null
let scene: typeof import('../agents/scene.ts') | null = null
let room: Room | null = null
let loaded: Promise<void> | null = null
let acc = 0
let todo: { step: number; text: string }[] = []
let switched = false
const strip = shallowRef<HTMLCanvasElement | null>(null)

const speed = computed(() => tool.values['drives.speed'] ?? 60)

function save(fn: (d: DrivesBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

// ------------------------------------------------------------- run

function begin(rng: Rng) {
  void (async () => {
    if (!loaded) return
    await loaded
    if (!lib) return
    sim.value?.dispose()
    sim.value = new lib.DriveSim(rng, {
      startHour: tool.values['drives.hour'] ?? 8,
      temperature: tool.values['drives.temperature'] ?? 0.06,
      commitment: tool.values['drives.commitment'] ?? 0.12,
    })
    todo = opts.events.map((e) => ({ step: e.step, text: e.text })).sort((a, b) => a.step - b.step)
    acc = 0
    Object.assign(live, { history: { hunger: [], rest: [], play: [], social: [] }, ticks: [], whys: [], stages: [], note: '' })
    tool.walk.value?.place(0, 0, 0)
    read()
  })()
}

/** n fixed steps; the saved events land on their steps. */
function steps(n: number) {
  const s = sim.value
  if (!s) return
  for (let i = 0; i < n; i++) {
    while (todo.length && todo[0]!.step <= s.step + 1) s.inject(todo.shift()!.text)
    const r = s.tick()
    if (r.switched) {
      switched = true
      live.whys.unshift({ t: lib!.hhmm(r.hour), act: r.act, reason: r.reason, p: Number.isFinite(r.probability) ? r.probability.toFixed(2) : '', why: r.why })
      if (live.whys.length > 8) live.whys.pop()
    }
    if (r.step % EVERY === 0) {
      for (const k of NEED_WORDS) { const h = live.history[k]; h.push(r.needs[k]); if (h.length > SAMPLES) h.shift() }
      live.ticks = live.ticks.map((x) => x - 1).filter((x) => x >= 0)
      if (switched) { live.ticks.push(live.history.hunger.length - 1); switched = false }
      live.stages.push(r.stage)
      if (live.stages.length > SAMPLES) live.stages.shift()
    }
  }
}

function frame(dt: number) {
  const s = sim.value
  if (!s || !lib) return
  acc += dt * speed.value
  const n = Math.min(4000, Math.floor(acc / lib.STEP))
  acc -= n * lib.STEP
  if (n) { steps(n); read() }
  walkTo(s.current, dt)
}

/** The mannequin walks to where the act happens; display only, never hashed. */
function walkTo(act: Act, dt: number) {
  const w = tool.walk.value
  const root = w?.stage.body?.avatar.root
  if (!w || !root) return
  const to = AT[act]
  const dx = to.x - root.position.x
  const dz = to.z - root.position.z
  const d = Math.hypot(dx, dz)
  if (d < 0.05) return
  const step = Math.min(d, 1.4 * dt * Math.min(4, tool.transport.rate))
  w.place(root.position.x + (dx / d) * step, root.position.z + (dz / d) * step, Math.atan2(dx, dz))
}

function read() {
  const s = sim.value
  if (!s || !lib) return
  const v = s.drives.values
  Object.assign(live.needs, v)
  Object.assign(live.utilities, s.utilities())
  const d = s.last
  Object.assign(live, {
    step: s.step, hour: s.hour, clock: lib.hhmm(s.hour), act: s.current, why: d?.why ?? '', reason: d?.reason ?? '', prob: d?.probability ?? Number.NaN,
    stage: s.sleep.stage, pressure: s.sleep.pressure, sleepiness: s.sleepiness(), wake: s.sleep.wakeThreshold(), hash: s.hashHex,
    bonus: s.chooser.done ? 0 : (tool.values['drives.commitment'] ?? 0.12),
  })
  live.goals = s.goals.slice(-6).reverse().map((g) => ({ goal: g.id, why: g.why, status: g.status, until: lib!.hhmm((s.opts.startHour + g.until / 3600) % 24) }))
  live.memory = s.memory.length ? s.memory.retrieve(s.hour, [s.current], 3) : []
  tool.body.line = d ? `${s.current} at ${lib.hhmm(s.hour)}. ${d.why}` : tool.body.line
  drawStrip()
}

// ------------------------------------------------------------- inject

function inject(text: string) {
  const s = sim.value
  if (!s || !text.trim()) return
  const e = s.inject(text.trim())
  if (!e) { live.note = `"${text.trim()}" names no need. name food, a visitor, the ball or a noise.`; return }
  live.note = `${e.kind} lands at step ${e.step}.`
  opts.events.push({ step: e.step, kind: e.kind, text: e.text })
  save((d) => { d.events = opts.events.map((x) => ({ ...x })) })
  logEvent('note', `drives: ${e.kind} at step ${e.step}`)
  said.value = ''
}
watch(event, (k) => { if (k) { inject(k); void nextTick(() => (event.value = '')) } })

function clearEvents() {
  opts.events = []
  save((d) => { d.events = [] })
  tool.restart()
}

watch(() => [tool.values['drives.speed'], tool.values['drives.hour'], tool.values['drives.temperature'], tool.values['drives.commitment']], ([sp, h, t, c]) =>
  save((d) => { d.speed = sp ?? 60; d.startHour = h ?? 8; d.temperature = t ?? 0.06; d.commitment = c ?? 0.12 }))

// ------------------------------------------------------------- views

const gauges = computed<HbGaugeRow[]>(() => {
  const need = live.act === 'eat' ? 'hunger' : live.act === 'greet' ? 'social' : live.act
  return NEED_WORDS.map((k) => ({ label: k, value: live.needs[k], display: live.needs[k].toFixed(2), current: k === need }))
})
const sparks = computed<HbSparkRow[]>(() => NEED_WORDS.map((k) => ({ id: k, label: k, values: live.history[k].slice(), value: live.needs[k], ticks: live.ticks.slice() })))
const choice = computed<HbChoiceOption[]>(() => ACT_WORDS.map((a) => ({
  id: a, score: Math.max(0, live.utilities[a] ?? 0), chosen: a === live.act, bonus: a === live.act ? live.bonus : 0,
  prob: a === live.act && Number.isFinite(live.prob) ? live.prob : undefined,
})))
const meta = computed(() => `temperature ${(tool.values['drives.temperature'] ?? 0.06).toFixed(2)}, commitment ${(tool.values['drives.commitment'] ?? 0.12).toFixed(2)}, dwell until ${Math.round(sim.value?.chooser.dwellUntil ?? 0)} s`)

function drawStrip() {
  void nextTick(() => {
    const c = strip.value
    if (!c) return
    const box = c.getBoundingClientRect()
    const dpr = Math.min(2, devicePixelRatio || 1)
    const W = Math.max(1, Math.round(box.width * dpr))
    const H = Math.max(1, Math.round(box.height * dpr))
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H }
    const x = c.getContext('2d')
    if (!x) return
    x.clearRect(0, 0, W, H)
    // the hypnogram: awake on top, rem, onset, nrem lowest
    const LEVEL: Record<string, number> = { awake: 0, wake: 0, rem: 1, onset: 2, nrem: 3 }
    const bw = W / SAMPLES
    x.fillStyle = tone('--hb-info') || '#3b82f6'
    live.stages.forEach((s, i) => {
      const l = LEVEL[s] ?? 0
      if (!l) return
      x.fillRect(i * bw, (H * l) / 4 - 2, Math.ceil(bw) + 0.5, H / 4)
    })
  })
}

// ------------------------------------------------------------- export

const name = computed(() => `drives-${tool.seed.value}`)
const formats: HbExportFormat[] = [
  { key: 'csv', label: 'run', ext: '.csv', note: 'one row a step: needs, act, reason, probability, sleep and the why.' },
  { key: 'trace', label: 'trace', ext: '.trace.json', note: 'the seed, the settings, the events and the trace hash, with every step.' },
  { key: 'doc', label: 'document', ext: drivesKind.ext, note: 'speed, start hour, chooser settings and the events with their steps.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'steps', value: String(live.step) },
  { label: 'trace hash', value: live.hash || 'none yet' },
  { label: 'seed', value: String(tool.seed.value) },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  const s = sim.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  if (!s || !lib || !s.rows.length) { tool.body.line = 'no steps yet. press play.'; return }
  if (req.format === 'csv') saveFile(`${fname}.csv`, lib.runCsv(s.rows), 'text/csv')
  else saveFile(`${fname}.trace.json`, JSON.stringify({ format: 'hackbuild.drives-trace', version: 1, seed: tool.seed.value, step: lib.STEP, opts: s.opts, events: s.injected, hash: s.hashHex, rows: s.rows }), 'application/json')
  logEvent('note', `drives: exported ${s.rows.length} steps, hash ${s.hashHex}`)
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === DRIVES_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('drives')
  const d = doc.body.value
  if (d) {
    opts.events = d.events.map((e) => ({ ...e }))
    tool.reg.set('drives.speed', d.speed)
    tool.reg.set('drives.hour', d.startHour)
    tool.reg.set('drives.temperature', d.temperature)
    tool.reg.set('drives.commitment', d.commitment)
  }
  loaded = (async () => {
    const [m, sc] = await Promise.all([import('./sim.ts'), import('../agents/scene.ts')])
    await m.ready()
    lib = m
    scene = sc
  })()
  await loaded
  tool.restart()
})

watch(() => tool.walk.value, async (w) => {
  if (!w) return
  while (!scene) await new Promise((r) => setTimeout(r, 20))
  room?.dispose()
  room = new scene.Room(w.stage.scene, STATIONS)
})

onBeforeUnmount(() => {
  room?.dispose()
  sim.value?.dispose()
  sim.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(sim, (s) => {
  const el = tool.host.value as (HTMLElement & { drives?: unknown }) | null
  if (el && s) el.drives = { live, steps: (n: number) => { steps(n); read(); return sim.value?.hashHex }, hash: () => sim.value?.hashHex, step: () => sim.value?.step ?? 0 }
})

const HOW = `import { load, Drives, Chooser, Sleep, GoalBoost, seededRng } from "@hackbuild/drives";

await load(); // the wasm core, inlined: works from file://
const rng = seededRng(7);
const drives = new Drives({ hunger: 1, rest: 0.9, play: 0.7, social: 0.8 });
const chooser = new Chooser({ rng, options: ["idle", "eat", "rest", "play", "greet"] });
const sleep = new Sleep({ rng });
const goal = new GoalBoost(0.25);
// each fixed step: grow the needs, score each act by what it would reduce
drives.grow(step / 60, { hunger: 0.0035, play: 0.006, social: 0.0045 });
drives.set({ rest: sleep.fatigue(hour) });
const d = chooser.update(now, goal.apply(now, {
  idle: 0.12,
  eat: drives.rewardOf({ hunger: -0.5 }),
  rest: drives.rewardOf({ rest: -0.35 }),
}));
log(d.why); // "eat: top switch after 105 ms, utility now 0.18"`
</script>

<template>
  <StageTool :tool="tool" title="drives">
    <template #under>
      <HbChipGroup v-model="event" :options="EVENTS" label="inject" />
      <HbWave label="hypnogram" :value="live.stage" :off="!tool.transport.playing">
        <canvas ref="strip" data-strip="hypnogram" />
      </HbWave>
    </template>

    <template #rack>
      <HbFold v-model="open.drives" :num="0" summary="drives" persist-key="drives-drives">
        <div class="hb-instrument" data-pane="drives">
          <HbGauges :rows="gauges" :max="1" label="needs now" />
          <HbSparkRows :rows="sparks" label="needs over time" :min="0" :max="1" :window="(SAMPLES * EVERY * 5)" :digits="2" />
          <p class="hb-hint">a tick on a row marks a switch of act. rest follows the sleep model: pressure and the body clock.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.choice" :num="1" summary="choice and why" persist-key="drives-choice">
        <div class="hb-instrument" data-pane="choice">
          <HbChoiceBars :options="choice" sort="none" :why="live.why" :meta="meta" label="act scores" :digits="3" legend />
          <HbKv label="doing" :value="live.act" />
          <HbKv label="reason" :value="live.reason" />
          <HbTable
            :columns="[{ key: 't', label: 'time' }, { key: 'act', label: 'act' }, { key: 'reason', label: 'reason' }, { key: 'p', label: 'p', numeric: true }, { key: 'why', label: 'why' }]"
            :rows="live.whys"
          />
          <p v-if="!live.whys.length" class="hb-hint">no switch yet. press play.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.goals" :num="2" summary="goals" persist-key="drives-goals">
        <div class="hb-instrument" data-pane="goals">
          <HbTable v-if="live.goals.length" :columns="[{ key: 'goal', label: 'goal' }, { key: 'why', label: 'why' }, { key: 'status', label: 'status' }, { key: 'until', label: 'until' }]" :rows="live.goals" />
          <p v-else class="hb-hint">none. an injected event raises a goal, kept until done or out of time.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.clock" :num="3" summary="body clock and sleep" persist-key="drives-clock">
        <div class="hb-instrument" data-pane="clock">
          <HbKv label="clock" :value="live.clock" />
          <HbKv label="sleepiness" :value="`${live.sleepiness.toFixed(3)} (body clock)`" />
          <HbKv label="sleep" :value="live.stage" />
          <HbKv label="pressure" :value="live.pressure.toFixed(3)" />
          <HbKv label="wakes at" :value="`noise over ${live.wake.toFixed(2)}`" />
          <p class="hb-hint">activity peaks near 7 and 19 (vendor). a loud noise wakes a sleeper.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.inject" :num="4" summary="inject an event" persist-key="drives-inject">
        <div class="hb-instrument" data-pane="inject">
          <HbInput v-model="said" placeholder="inject an event (e.g. a friend knocks at the door)" aria-label="event to inject" @keydown.enter="inject(said)" />
          <HbButton variant="secondary" size="sm" data-inject @click="inject(said)">inject</HbButton>
          <p v-if="live.note" class="hb-hint" data-note>{{ live.note }}</p>
          <HbKv label="events this run" :value="opts.events.length" />
          <HbButton variant="secondary" size="sm" :disabled="!opts.events.length" @click="clearEvents">clear events and restart</HbButton>
          <HbList v-if="live.memory.length">
            <div v-for="m in live.memory" :key="m" class="hb-row">{{ m }}</div>
          </HbList>
          <p class="hb-hint">memory: the three it recalls for what it does now, by recency, importance and relevance.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.run" :num="5" summary="run" persist-key="drives-run">
        <div class="hb-instrument" data-pane="run">
          <HbParamRow :model-value="speed" label="sim speed" :min="1" :max="3600" :step="1" unit="x" :default-value="60" @update:model-value="(v) => tool.reg.set('drives.speed', Number(v))" />
          <HbKv label="step" :value="`${live.step}, 5 s each`" />
          <HbKv label="trace hash" :value="live.hash" data-hash />
          <p class="hb-hint">restart with the same seed replays the run: the same events land on the same steps and the hash matches.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.export" :num="6" summary="export" persist-key="drives-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="sim ? '' : 'the core is starting.'" label="drives" @export="onExport" />
      </HbFold>

      <HbHow :packages="['@hackbuild/drives']" install="npm i @hackbuild/drives" :code="HOW" persist-key="drives-how" />
    </template>
  </StageTool>
</template>
