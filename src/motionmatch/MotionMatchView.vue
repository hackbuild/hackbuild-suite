<script setup lang="ts">
// The motion-match tool (design 3.11): steer a body through a clip set.
// The pad or w a s d asks for a trajectory; the matcher of
// `@hackbuild/motion-match` picks a frame and plays from it. Score bars of
// the candidates (P-ROOM-9) and a pane that fills as the search resolves
// (P-ROOM-12): the chosen clip, its frame and cost, per clip costs; the
// desired trajectory in pink and the matched frame's own in blue on the
// floor; the database inspector switches clips off; the transport of the
// shared toolbar (P-STAGE-13). The run exports as a clip and as a trace csv.
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue'
import {
  HbChoiceBars, HbExportPanel, HbFold, HbHow, HbKv, HbTable, HbToggleRow,
  type HbChoiceOption, type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { CLIP_EXT } from '../avatar/pose.ts'
import { bakedClip } from '../gait/kind.ts'
import { BUILTIN_CLIPS, MM_KIND, fewClipsLine, mmKind, traceCsv, type MmBody, type TraceRow } from './kind.ts'
import type { Candidate, MatchRig, Tuning } from './bind.ts'
import how from '@hackbuild/motion-match/how'

if (!kinds.get(MM_KIND)) registerKind(mmKind)

const W = { trajectoryPosition: 1, trajectoryDirection: 1.5, footPosition: 0.75, footVelocity: 1, hipVelocity: 1 }
const tool = useStageTool({
  id: 'motion-match',
  empty: 'this is the built in rig on a clip set made in code. steer with the pad or w a s d. a glb or vrm drops anywhere.',
  tunables: (reg) => {
    reg.define({ key: 'walk.speed', group: 'steer', label: 'top speed', def: 1.6, min: 0.2, max: 3, step: 0.1, unit: 'm/s', note: 'speed the trajectory asks for at full stick.', source: 'inferred' })
    reg.define({ key: 'mm.w.trajectoryPosition', group: 'weights', label: 'trajectory position', def: W.trajectoryPosition, min: 0, max: 4, step: 0.05, unit: 'x', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_CONFIG' })
    reg.define({ key: 'mm.w.trajectoryDirection', group: 'weights', label: 'trajectory direction', def: W.trajectoryDirection, min: 0, max: 4, step: 0.05, unit: 'x', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_CONFIG' })
    reg.define({ key: 'mm.w.footPosition', group: 'weights', label: 'foot position', def: W.footPosition, min: 0, max: 4, step: 0.05, unit: 'x', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_CONFIG' })
    reg.define({ key: 'mm.w.footVelocity', group: 'weights', label: 'foot velocity', def: W.footVelocity, min: 0, max: 4, step: 0.05, unit: 'x', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_CONFIG' })
    reg.define({ key: 'mm.w.hipVelocity', group: 'weights', label: 'hip velocity', def: W.hipVelocity, min: 0, max: 4, step: 0.05, unit: 'x', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_CONFIG' })
    reg.define({ key: 'mm.searchInterval', group: 'search', label: 'search every', def: 0.1, min: 0.02, max: 0.5, step: 0.01, unit: 's', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_PARAMS' })
    reg.define({ key: 'mm.minImprovement', group: 'search', label: 'jump only below', def: 0.05, min: 0, max: 1, step: 0.01, note: 'a jump needs a cost this much below the current frame.', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_PARAMS' })
    reg.define({ key: 'mm.halflife', group: 'search', label: 'blend halflife', def: 0.1, min: 0.02, max: 0.5, step: 0.01, unit: 's', note: 'inertialization of each jump.', source: 'vendor', cite: '@hackbuild/motion-match DEFAULT_PARAMS' })
  },
  restart: () => rebuild(),
})

const doc = useDocument<MmBody>(MM_KIND)
const opts = reactive<MmBody>(mmKind.create())
const open = reactive({ match: true, db: true, view: false, export: true })
const rig = shallowRef<MatchRig | null>(null)
const live = reactive({ clip: 'none', frame: 0, cost: NaN, transitions: 0, speed: 0, turn: 0, brute: NaN, best: NaN, phase: 0, contacts: [true, true] })
const cands = shallowRef<Candidate[]>([])
const trace: TraceRow[] = []
const run = { rot: [] as number[], root: [] as number[], contacts: [] as number[], names: [] as string[], acc: 0 }
let bind: typeof import('./bind.ts') | null = null
let sm: typeof import('../stage/steer') | null = null
let offPose: (() => void) | null = null
let offLoaded: (() => void) | null = null

const onClips = computed(() => BUILTIN_CLIPS.filter((c) => !opts.off.includes(c.name)))
const few = computed(() => fewClipsLine(onClips.value.length))
const tuning = (): Tuning => {
  const v = tool.values
  return {
    weights: Object.fromEntries(Object.entries(W).map(([k, d]) => [k, v[`mm.w.${k}`] ?? d])) as Tuning['weights'],
    params: { searchInterval: v['mm.searchInterval'] ?? 0.1, minImprovement: v['mm.minImprovement'] ?? 0.05, halflife: v['mm.halflife'] ?? 0.1, trajectoryHalflife: 0.25 },
  }
}

function rebuild() {
  const r = rig.value
  if (!r) return
  r.build(onClips.value, tuning())
  trace.length = 0
  run.rot = []; run.root = []; run.contacts = []
  cands.value = []
  if (few.value) tool.body.line = few.value
  tool.walk.value?.stage.loop.invalidate()
}
let rebuildTimer: ReturnType<typeof setTimeout> | undefined
watch(() => Object.entries(tool.values).filter(([k]) => k.startsWith('mm.')).map(([, v]) => v).join(','), () => {
  clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(rebuild, 150)
})

function save(fn: (d: MmBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}
function toggleClip(name: string, on: boolean) {
  opts.off = on ? opts.off.filter((n) => n !== name) : [...opts.off, name]
  save((d) => { d.off = [...opts.off] })
  rebuild()
}
watch(() => [opts.trajectory, opts.candidate], ([t, c]) => {
  const r = rig.value
  if (r) { r.showWant = !!t; r.showMatch = !!c }
  save((d) => { d.trajectory = !!t; d.candidate = !!c })
})

const bars = computed<HbChoiceOption[]>(() => cands.value.map((c) => ({ id: c.clip, score: 1 / (1 + c.cost), chosen: c.clip === live.clip })))
const dbRows = computed(() => BUILTIN_CLIPS.map((c) => {
  const k = cands.value.find((x) => x.clip === c.name)
  const turn = c.turnRate ?? 0
  return {
    clip: c.name,
    motion: `${c.speed}${c.speedEnd !== undefined ? ` to ${c.speedEnd}` : ''} m/s${turn ? `, ${turn > 0 ? 'left' : 'right'} ${Math.abs(turn)} rad/s` : ''}`,
    loop: c.speedEnd === undefined ? 'loop' : 'once',
    cost: k && Number.isFinite(k.cost) ? k.cost.toFixed(3) : '',
  }
}))
const dbFrames = computed(() => rig.value?.db?.frames.reduce((a, b) => a + b, 0) ?? 0)

let frames = 0
let last = 0
function frame() {
  const r = rig.value
  const w = tool.walk.value
  if (!r || !w || !sm) return
  const t = w.stage.loop.time
  const dt = Math.min(0.05, Math.max(0, t - last))
  last = t
  if (!tool.transport.playing || !r.db) return
  const f0 = r.last
  const cmd = sm.padCommand(w.stage.camera, tool.move.value, f0?.yaw ?? 0, tool.values['walk.speed'] ?? 1.6)
  const f = r.step(dt * tool.transport.rate, cmd.speed, cmd.turnRate)
  w.stage.loop.invalidate()
  if (!f) return
  const name = r.clipName(f.clip)
  trace.push({ t: tool.transport.time, clip: name, frame: f.frame, cost: f.cost, jumped: f.jumped, speed: f.speed, turnRate: f.turnRate })
  if (trace.length > 30 * 120) trace.shift()
  record(dt, f)
  if (f.jumped) logEvent('note', `motion-match: ${name} frame ${Math.floor(f.frame)}, cost ${f.cost.toFixed(3)}`)
  if (frames++ % 6) return
  const c = r.candidates()
  cands.value = c.list
  Object.assign(live, { clip: name, frame: f.frame, cost: f.cost, transitions: f.transitions, speed: f.speed, turn: f.turnRate, brute: c.brute.cost, best: c.best, contacts: [...r.contacts] })
}

function record(dt: number, f: { x: number; z: number; yaw: number }) {
  const body = tool.walk.value?.stage.body
  if (!body) return
  run.acc += dt
  if (run.acc < 1 / 30 && run.root.length) return
  run.acc = 0
  const bones = body.avatar.bones as Record<string, { quaternion: { x: number; y: number; z: number; w: number } } | undefined>
  if (!run.names.length) run.names = Object.keys(bones).filter((n) => bones[n])
  for (const n of run.names) { const q = bones[n]!.quaternion; run.rot.push(q.x, q.y, q.z, q.w) }
  run.root.push(f.x, 0, f.z, f.yaw)
  run.contacts.push(...rig.value!.contacts.map((c) => (c ? 1 : 0)))
  const over = run.root.length / 4 - 30 * 20
  if (over > 0) { run.rot.splice(0, over * run.names.length * 4); run.root.splice(0, over * 4); run.contacts.splice(0, over * 2) }
}

function adopt() {
  const r = rig.value
  if (!r) return
  r.setBody()
  run.names = []
  run.rot = []; run.root = []; run.contacts = []
  rebuild()
}

// ------------------------------------------------------------- export

const name = computed(() => `${tool.body.name}-match`.replace(/[^\w.-]+/g, '-'))
const formats: HbExportFormat[] = [
  { key: 'clip', label: 'clip', ext: CLIP_EXT, note: 'the last 20 seconds of the run at 30 fps: every human bone, the root track and the foot contacts.' },
  { key: 'trace', label: 'trace', ext: '.csv', note: 'one row a frame: time, clip, frame, cost, jump, speed, turn rate.' },
  { key: 'doc', label: 'document', ext: mmKind.ext, note: 'the overlays and the clips switched off. the tuning lives in the tune drawer.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'body', value: tool.body.name },
  { label: 'clips', value: `${onClips.value.length} of ${BUILTIN_CLIPS.length}, ${dbFrames.value} frames` },
  { label: 'jumps', value: String(live.transitions) },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  if (req.format === 'trace') {
    saveFile(`${fname}.csv`, traceCsv(trace), 'text/csv')
    tool.body.line = `${fname}.csv saved, ${trace.length} rows.`
    return
  }
  const n = run.root.length / 4
  if (!n) { tool.body.line = 'nothing recorded yet. press play and steer a few steps.'; return }
  saveFile(`${fname}${CLIP_EXT}`, JSON.stringify(bakedClip(fname, 'motion-match', 30, run.names, run.rot, run.root, ['left', 'right'], run.contacts)), 'application/json')
  tool.body.line = `${fname}${CLIP_EXT} saved, ${n} frames.`
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === MM_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('motion match')
  const d = doc.body.value
  if (d) Object.assign(opts, { trajectory: d.trajectory, candidate: d.candidate, off: [...d.off] })
  const [m, s] = await Promise.all([import('./bind.ts'), import('../stage/steer')])
  await m.ready()
  sm = s
  bind = m
})

watch(
  () => tool.walk.value,
  async (w) => {
    if (!w) return
    while (!bind) await new Promise((r) => setTimeout(r, 20))
    const r = new bind.MatchRig(w.stage, { want: tone('--hb-pink') || '#e0457b', match: tone('--hb-info') || '#3b82f6', contact: tone('--hb-ink') || '#1a1a1a' })
    r.showWant = opts.trajectory
    r.showMatch = opts.candidate
    rig.value = r
    offLoaded?.()
    offLoaded = w.stage.on('loaded', () => adopt())
    adopt()
    last = w.stage.loop.time
    const prev = w.stage.scene.onBeforeRender
    w.stage.scene.onBeforeRender = (...a) => { prev.apply(w.stage.scene, a); frame() }
    offPose = () => { w.stage.scene.onBeforeRender = prev }
  },
)

onBeforeUnmount(() => {
  clearTimeout(rebuildTimer)
  offLoaded?.()
  offPose?.()
  rig.value?.dispose()
  rig.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(rig, (r) => {
  const el = tool.host.value as (HTMLElement & { mm?: unknown }) | null
  if (el && r) el.mm = { live, root: () => (r.last ? { x: r.last.x, z: r.last.z } : null), cands: () => cands.value }
})

</script>

<template>
  <StageTool :tool="tool" title="motion-match">
    <template #rack>
      <HbFold v-model="open.match" :num="0" summary="match" persist-key="mm-match">
        <div class="hb-instrument" data-pane="match">
          <HbKv label="clip" :value="live.clip" />
          <HbKv label="frame" :value="Math.floor(live.frame)" />
          <HbKv label="cost" :value="Number.isFinite(live.best) ? `${live.best.toFixed(3)} (computed)` : 'pending'" data-cost />
          <HbKv label="search reads" :value="Number.isFinite(live.cost) ? live.cost.toFixed(3) : 'pending'" />
          <HbKv label="jumps" :value="live.transitions" />
          <HbKv label="speed" :value="`${live.speed.toFixed(2)} m/s`" />
          <HbKv label="turn rate" :value="`${live.turn.toFixed(2)} rad/s`" />
          <HbKv label="feet" :value="live.contacts.map((c, i) => `${i ? 'right' : 'left'} ${c ? 'planted' : 'swing'}`).join(', ')" />
          <HbChoiceBars :options="bars" label="candidates" :digits="2" :limit="5" />
          <p class="hb-hint">a bar is 1 over 1 plus the clip's cheapest cost. pink is the trajectory you ask for, blue the matched frame's own. search reads is the matcher's last search, less the jump margin when it stayed. costs per clip are computed in the page; the cheapest is {{ Number.isFinite(live.best) ? live.best.toFixed(3) : 'pending' }} and the matcher's brute search reads {{ Number.isFinite(live.brute) ? live.brute.toFixed(3) : 'pending' }}.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.db" :num="1" summary="clip set" persist-key="mm-db">
        <p v-if="few" class="hb-hint" data-few>{{ few }}</p>
        <HbKv label="database" :value="`${onClips.length} clips, ${dbFrames} frames at 30 fps, ${rig?.db?.dims ?? 0} features a frame`" />
        <HbTable :columns="[{ key: 'clip', label: 'clip' }, { key: 'motion', label: 'motion' }, { key: 'loop', label: 'play' }, { key: 'cost', label: 'cost', numeric: true }]" :rows="dbRows" />
        <HbToggleRow
          v-for="c in BUILTIN_CLIPS" :key="c.name" :model-value="!opts.off.includes(c.name)" :label="c.name"
          @update:model-value="(on: boolean) => toggleClip(c.name, on)"
        />
        <p class="hb-hint">every clip is made in code by the library's synthetic gait: two planted feet, hips, nothing downloaded.</p>
      </HbFold>

      <HbFold v-model="open.view" :num="2" summary="overlays" persist-key="mm-view">
        <HbToggleRow v-model="opts.trajectory" label="desired trajectory" description="where the pad asks the root to be in a third, two thirds and one second." />
        <HbToggleRow v-model="opts.candidate" label="matched trajectory" description="where the chosen frame's own clip goes over the same times." />
      </HbFold>

      <HbFold v-model="open.export" :num="3" summary="export" persist-key="mm-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="rig ? '' : 'the stage is starting.'" label="motion-match" @export="onExport" />
      </HbFold>

      <HbHow v-bind="how" persist-key="mm-how" />
    </template>
  </StageTool>
</template>
