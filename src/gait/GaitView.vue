<script setup lang="ts">
// The gait tool (design 3.11): a quadruped walks under the pad or the keys
// on the procedural gait of `@hackbuild/gait`. Ported from the GAIT CPG
// block of the browser dog original (P-SET-3): gait mix bars, a footfall
// diagram as a live instrument, and the readout of speed, stride frequency,
// duty, turn rate, Froude and body source; phase and contact per leg; tune
// from the registry; key hints in the hud (P-ROOM-14); the pad on a phone
// (P-PHONE-10). Ground chips put the walk on a slope or bumps; the run
// bakes into a clip file.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue'
import {
  HbButton, HbChipGroup, HbChoiceBars, HbExportPanel, HbFold, HbHow, HbKv, HbParamRow, HbTable, HbWave,
  type HbChoiceOption, type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { GAIT_NAMES } from '@hackbuild/gait'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { CLIP_EXT } from '../avatar/pose.ts'
import { GAIT_CHIPS, GAIT_KIND, TERRAINS, bakedClip, chipSpeed, gaitKind, type GaitBody, type GaitChip, type Terrain } from './kind.ts'
import type { GaitRig, MapReport } from './bind.ts'

if (!kinds.get(GAIT_KIND)) registerKind(gaitKind)

const tool = useStageTool({
  id: 'gait',
  empty: 'this is the built in dog. steer with the pad or w a s d. drop a glb with four legs to walk your own.',
  tunables: (reg) => {
    reg.define({ key: 'walk.speed', group: 'gait', label: 'top speed', def: 1.2, min: 0.1, max: 5, step: 0.1, unit: 'm/s', note: 'speed at full stick when the gait chip is auto.', source: 'inferred' })
    reg.define({ key: 'gait.stride', group: 'gait', label: 'stride', def: 1, min: 0.6, max: 1.6, step: 0.05, unit: 'x', note: 'above 1 takes longer, slower steps at the same speed; the gait reads the slower cadence.', source: 'inferred' })
    reg.define({ key: 'gait.slope', group: 'ground', label: 'slope', def: 12, min: 0, max: 25, step: 1, unit: 'deg', note: 'the rise of the ridge when the ground chip is slope.', source: 'inferred' })
  },
  restart: (rng) => { rig.value?.restart(rng) },
})

const doc = useDocument<GaitBody>(GAIT_KIND)
const opts = reactive<GaitBody>(gaitKind.create())
const open = reactive({ gait: true, legs: true, ground: true, body: false, export: true })
const rig = shallowRef<GaitRig | null>(null)
const report = shallowRef<MapReport | null>(null)
const LEG_WORDS = ['left fore', 'right fore', 'left hind', 'right hind']
const live = reactive({
  speed: 0, turn: 0, freq: 0, duty: 0, froude: 0, standing: true, stride: 0, missed: 0, frames: 0,
  weights: Object.fromEntries(GAIT_NAMES.map((n) => [n, 0])) as Record<string, number>,
  legs: LEG_WORDS.map(() => ({ phase: 0, stance: true })),
})
let bind: typeof import('./bind.ts') | null = null
let offPose: (() => void) | null = null
let offLoaded: (() => void) | null = null
let mannequinScale = 1

const top = computed(() => (opts.gait === 'auto' ? tool.values['walk.speed'] ?? 1.2 : chipSpeed(opts.gait, rig.value?.legLength ?? 0.38)))
const dominant = computed(() => GAIT_NAMES.reduce((a, b) => (live.weights[b]! > live.weights[a]! ? b : a), GAIT_NAMES[0]!))
const mix = computed<HbChoiceOption[]>(() => GAIT_NAMES.map((n) => ({ id: n, score: live.weights[n] ?? 0, chosen: !live.standing && n === dominant.value })))
const legRows = computed(() => live.legs.map((l, i) => ({ leg: LEG_WORDS[i], phase: l.phase.toFixed(2), foot: l.stance ? 'planted' : 'swing' })))

function save(fn: (d: GaitBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

let frames = 0
let last = 0
function frame() {
  const r = rig.value
  const w = tool.walk.value
  if (!r || !w) return
  const t = w.stage.loop.time
  const dt = Math.min(0.05, Math.max(0, t - last))
  last = t
  if (!tool.transport.playing) return
  const steer = sm!.padCommand(w.stage.camera, tool.move.value, r.pose.yaw, top.value)
  r.stride = tool.values['gait.stride'] ?? 1
  r.bakeSeconds = opts.bake
  const f = r.step(dt * tool.transport.rate, steer.speed, steer.turnRate)
  // the hidden mannequin stands where the dog is, so the camera follows it
  const proxy = w.stage.body?.avatar.root
  if (proxy && r.dog.visible) {
    proxy.position.set(r.pose.x, 0, r.pose.z)
    proxy.updateMatrixWorld(true)
  }
  w.stage.loop.invalidate()
  if (!f || frames++ % 4) return
  const s = f.state
  live.speed = f.speed
  live.turn = f.turnRate
  live.freq = s.standing ? 0 : s.frequency / r.stride
  live.duty = s.duty
  live.froude = s.froude
  live.standing = s.standing
  live.stride = live.freq > 0 ? f.speed / live.freq : 0
  live.missed = f.missed.length
  live.frames = r.baked().frames
  for (const n of GAIT_NAMES) live.weights[n] = s.weights[n]
  s.feet.forEach((ft, i) => { live.legs[i] = { phase: s.legPhases[i] ?? 0, stance: ft.stance } })
  drawStrip()
}

// ------------------------------------------------------------- footfalls

const strip = shallowRef<HTMLCanvasElement | null>(null)
function drawStrip() {
  void nextTick(() => {
    const c = strip.value
    const r = rig.value
    if (!c || !r) return
    const box = c.getBoundingClientRect()
    const dpr = Math.min(2, devicePixelRatio || 1)
    const W = Math.max(1, Math.round(box.width * dpr))
    const H = Math.max(1, Math.round(box.height * dpr))
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H }
    const x = c.getContext('2d')
    if (!x) return
    x.clearRect(0, 0, W, H)
    const rh = H / 4
    const bw = W / bind!.STRIP
    const ink = [tone('--hb-slime') || '#8f6', tone('--hb-info') || '#3b82f6']
    r.strip.forEach((row, k) => row.forEach((on, li) => {
      if (!on) return
      x.fillStyle = ink[li < 2 ? 0 : 1]!
      x.fillRect(k * bw, li * rh + 2, Math.ceil(bw) + 0.5, rh - 4)
    }))
  })
}

// ------------------------------------------------------------- body

function adopt() {
  const r = rig.value
  const w = tool.walk.value
  const b = w?.stage.body
  if (!r || !w || !bind || !b) return
  if (tool.body.placeholder) {
    b.avatar.root.visible = false
    mannequinScale = b.avatar.root.scale.x
    // the follow camera frames the proxy: a dog sized box
    b.avatar.root.scale.setScalar(mannequinScale * 0.32)
    r.setRig(r.dog, bind.DOG_NAMES)
    report.value = null
    return
  }
  const m = bind.mapQuadruped(b.avatar.root)
  report.value = m
  if (!m.names) {
    tool.body.line = `${tool.body.name} has ${m.legs} of 4 legs by bone name (missing ${m.missing.join(', ')}). the built in dog keeps walking.`
    b.avatar.root.visible = false
    r.setRig(r.dog, bind.DOG_NAMES)
    return
  }
  try {
    r.setRig(b.avatar.root, m.names)
    tool.body.line = `${tool.body.name}: 4 of 4 legs, ${m.tail} tail bones and ${m.ears} ears mapped by name. it walks on the gait now.`
    logEvent('note', `gait: ${tool.body.name} mapped, 4 legs`)
  } catch (err) {
    tool.body.line = `could not drive ${tool.body.name}: ${err instanceof Error ? err.message : String(err)}. the built in dog keeps walking.`
    r.setRig(r.dog, bind.DOG_NAMES)
  }
}

function backToDog() {
  tool.walk.value?.stage.showPlaceholder()
}

watch(() => opts.terrain, (t) => {
  rig.value?.setGround(t, tool.values['gait.slope'] ?? 12)
  save((d) => { d.terrain = t })
})
watch(() => tool.values['gait.slope'], (s) => rig.value?.setGround(opts.terrain, s ?? 12))
watch(() => opts.gait, (g) => {
  const r = rig.value
  if (r) {
    const bias = g === 'pace' ? 1 : 0
    if (bias !== r.paceBias) { r.paceBias = bias; tool.restart() }
  }
  save((d) => { d.gait = g })
})
watch(() => opts.bake, (b) => save((d) => { d.bake = b }))

// ------------------------------------------------------------- export

const name = computed(() => `${tool.body.placeholder ? 'dog' : tool.body.name}-gait`.replace(/[^\w.-]+/g, '-'))
const formats: HbExportFormat[] = [
  { key: 'clip', label: 'clip', ext: CLIP_EXT, note: 'the last seconds of the run baked at 30 fps: every bone, the root track and the foot contacts.' },
  { key: 'doc', label: 'document', ext: gaitKind.ext, note: 'the gait chip, ground and bake length. body files are never in it.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'body', value: tool.body.placeholder ? 'built in dog' : tool.body.name },
  { label: 'baked', value: `${live.frames} frames, ${(live.frames / 30).toFixed(1)} s` },
  { label: 'ground', value: opts.terrain },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  const r = rig.value
  if (!r) return
  const b = r.baked()
  if (!b.frames) { tool.body.line = 'nothing baked yet. press play and walk a few steps.'; return }
  const clip = bakedClip(fname, 'gait', bind!.BAKE_FPS, b.bones, b.rotations, b.root, ['LF', 'RF', 'LH', 'RH'], b.contacts)
  saveFile(`${fname}${CLIP_EXT}`, JSON.stringify(clip), 'application/json')
  tool.body.line = `${fname}${CLIP_EXT} saved, ${b.frames} frames.`
  logEvent('note', `gait: baked ${b.frames} frames`)
}

// ------------------------------------------------------------- start

let sm: typeof import('../stage/steer') | null = null
onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === GAIT_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('gait')
  const d = doc.body.value
  if (d) Object.assign(opts, { gait: d.gait, terrain: d.terrain, bake: d.bake })
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
    const r = new bind.GaitRig(w.stage.scene, { stance: tone('--hb-ink') || '#1a1a1a', swing: tone('--hb-pink') || '#e0457b', ground: tone('--hb-sunk') || '#efe9db' }, tone('--hb-raised') || '#e8e0d0')
    r.paceBias = opts.gait === 'pace' ? 1 : 0
    r.setGround(opts.terrain, tool.values['gait.slope'] ?? 12)
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
  offLoaded?.()
  offPose?.()
  rig.value?.dispose()
  rig.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(rig, (r) => {
  const el = tool.host.value as (HTMLElement & { gait?: unknown }) | null
  if (el && r) el.gait = { pose: () => ({ ...r.pose }), contacts: () => r.strip.slice(), live, opts, report: () => report.value }
})

const HOW = `import { load, QuadrupedGait, BodyDynamics } from "@hackbuild/gait";
import { measureQuadruped, driveQuadruped } from "@hackbuild/gait/three";

await load(); // the wasm core, inlined: works from file://
const rig = measureQuadruped(dog, names); // dog at the origin, facing +z
const gait = new QuadrupedGait(rig.specs, rig.legLength, { ground: heightAt, rng });
const body = new BodyDynamics(rig.geometry, rng);
function frame(dt, pose, cmd) {
  const s = gait.update(dt, pose, cmd); // phase, contacts, gait weights
  const under = gait.nominal(pose.x, pose.z, pose.yaw).map(([x, z]) => heightAt(x, z));
  const b = body.update(dt, s, cmd, under); // pitch and roll from the ground
  gait.setOffsets(b.legOffsets);
  driveQuadruped(rig, pose, s, b); // two bone leg ik onto the bones
}`
</script>

<template>
  <StageTool :tool="tool" title="gait">
    <template #under>
      <HbWave label="footfalls" :value="live.standing ? 'standing' : dominant" :off="!tool.transport.playing">
        <canvas ref="strip" data-strip="footfalls" />
      </HbWave>
    </template>

    <template #rack>
      <HbFold v-model="open.gait" :num="0" summary="gait" persist-key="gait-gait">
        <div class="hb-instrument" data-pane="gait">
          <HbChipGroup v-model="opts.gait" :options="[...GAIT_CHIPS]" toggle label="gait" />
          <HbChoiceBars :options="mix" sort="none" label="gait mix" :digits="2" quiet />
          <HbKv label="speed" :value="`${live.speed.toFixed(2)} m/s`" />
          <HbKv label="stride freq" :value="`${live.freq.toFixed(2)} Hz`" />
          <HbKv label="stride length" :value="`${live.stride.toFixed(2)} m (computed)`" />
          <HbKv label="duty" :value="live.duty.toFixed(2)" />
          <HbKv label="turn rate" :value="`${live.turn.toFixed(2)} rad/s`" />
          <HbKv label="froude" :value="live.froude.toFixed(3)" />
          <HbKv label="body source" value="procedural" />
          <p class="hb-hint">a chip sets the top speed to the middle of its froude band ({{ top.toFixed(2) }} m/s); the library picks the gait from the speed.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.legs" :num="1" summary="phase and contacts" persist-key="gait-legs">
        <div class="hb-instrument" data-pane="legs">
          <HbTable :columns="[{ key: 'leg', label: 'leg' }, { key: 'phase', label: 'phase', numeric: true }, { key: 'foot', label: 'foot' }]" :rows="legRows" />
          <p v-if="live.missed" class="hb-hint">{{ live.missed }} of 4 legs out of reach this frame.</p>
          <p class="hb-hint">phase is 0 at touchdown. a disc on the ground marks each planted foot.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.ground" :num="2" summary="speed, stride and ground" persist-key="gait-ground">
        <HbParamRow
          :model-value="tool.values['walk.speed'] ?? 1.2" label="top speed" :min="0.1" :max="5" :step="0.1" unit="m/s" :default-value="1.2"
          :disabled="opts.gait !== 'auto'" @update:model-value="(v) => tool.reg.set('walk.speed', Number(v))"
        />
        <HbParamRow
          :model-value="tool.values['gait.stride'] ?? 1" label="stride" :min="0.6" :max="1.6" :step="0.05" unit="x" :default-value="1"
          @update:model-value="(v) => tool.reg.set('gait.stride', Number(v))"
        />
        <HbChipGroup v-model="opts.terrain" :options="[...TERRAINS]" toggle label="ground" />
        <HbParamRow
          v-if="opts.terrain === 'slope'" :model-value="tool.values['gait.slope'] ?? 12" label="slope" :min="0" :max="25" :step="1" unit="deg" :default-value="12"
          @update:model-value="(v) => tool.reg.set('gait.slope', Number(v))"
        />
        <p class="hb-hint">the body pitches and rolls from the ground under its four feet.</p>
      </HbFold>

      <HbFold v-model="open.body" :num="3" summary="body" persist-key="gait-body">
        <HbKv label="body" :value="tool.body.placeholder ? 'built in dog, 26 bones' : tool.body.name" />
        <template v-if="report">
          <HbKv label="legs" :value="`${report.legs} of 4 by name`" />
          <HbKv label="tail and ears" :value="`${report.tail} tail bones, ${report.ears} ears`" />
          <HbKv label="bones" :value="report.bones" />
        </template>
        <p class="hb-hint">drop a glb or vrm with four legs anywhere. legs are found by bone name: front and hind, left and right.</p>
        <HbButton variant="secondary" size="sm" :disabled="tool.body.placeholder" @click="backToDog">back to the built in dog</HbButton>
      </HbFold>

      <HbFold v-model="open.export" :num="4" summary="export" persist-key="gait-export">
        <HbParamRow
          :model-value="opts.bake" label="bake the last" :min="1" :max="30" :step="1" unit="s" :default-value="6"
          @update:model-value="(v) => (opts.bake = Number(v))"
        />
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="rig ? '' : 'the stage is starting.'" label="gait" @export="onExport" />
      </HbFold>

      <HbHow
        :packages="['@hackbuild/gait', '@hackbuild/rig', '@hackbuild/avatar-host']"
        install="npm i @hackbuild/gait three"
        :code="HOW"
        persist-key="gait-how"
      />
    </template>
  </StageTool>
</template>
