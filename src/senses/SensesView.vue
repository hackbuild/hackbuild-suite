<script setup lang="ts">
// The senses tool (design 3.12): what an agent perceives each sense pass.
// Ported from the room original's EYES and MIND tabs: the eye inset with
// its modes (P-ROOM-3), "in view" with bearing and distance and "seen
// earlier" beliefs (P-ROOM-6, P-CAM-8), the sense controls with the cost
// note (P-ROOM-15) and the map the agent built (P-ROOM-5). New here:
// click a thing, then click the floor to move it; the percept memory is a
// list with age and confidence; the sense feed is a tagged log. Gaze,
// the field of view and the scent puffs draw on the stage.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbCausalLog, HbChipGroup, HbExportPanel, HbFold, HbHow, HbInset, HbKv, HbList, HbParamRow, HbSelect, HbTable,
  type HbCausalEvent, type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { Vector2 } from 'three'
import type { Rng } from '@hackbuild/organic'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { clampRoom, propDef, seededLayout, type Placed } from '../agents/props.ts'
import {
  FEEDS, INSETS, SENSES_KIND, SENSE_THINGS, bearingDeg, depthFeed, feedCsv, feedText, inViewLine, seenEarlierLine, sensesKind,
  type Feed, type InsetMode, type SensesBody,
} from './kind.ts'
import type { AgentPose, SenseCore } from './core.ts'
import type { SenseRig } from './bind.ts'

if (!kinds.get(SENSES_KIND)) registerKind(sensesKind)

const EMPTY = 'nothing in view. click the floor to place a thing.'
const tool = useStageTool({
  id: 'senses',
  empty: EMPTY,
  tunables: (reg) => {
    reg.define({ key: 'eye.fov', group: 'eye', label: 'field of view', def: 74, min: 50, max: 110, step: 1, unit: 'deg', note: 'vertical; the fan on the floor shows the horizontal field.', source: 'vendor', cite: 'eye prototype 74' })
    reg.define({ key: 'eye.rate', group: 'eye', label: 'sense rate', def: 4, min: 1, max: 10, step: 0.5, unit: '/s', note: 'sense passes a second; each pass renders the eye three times.', source: 'inferred' })
    reg.define({ key: 'eye.floor', group: 'eye', label: 'detector floor', def: 4, min: 1, max: 40, step: 1, unit: 'px', note: 'a thing is seen only if it covers at least this many pixels of the 192 by 108 eye frame.', source: 'inferred' })
    reg.define({ key: 'walk.speed', group: 'body', label: 'walk speed', def: 1.2, min: 0.2, max: 3, step: 0.1, unit: 'm/s', note: 'speed at full stick.', source: 'inferred' })
  },
  restart: (rng) => begin(rng),
  tick: (dt, t) => frame(dt, t),
  menu: (at) => menuAt(at),
  say: (s) => say(s),
})

const doc = useDocument<SensesBody>(SENSES_KIND)
const opts = reactive<SensesBody>(sensesKind.create())
const open = reactive({ view: true, earlier: true, feed: true, eyes: true, map: false, export: false })
const rig = shallowRef<SenseRig | null>(null)
const core = shallowRef<SenseCore | null>(null)
const picked = ref<string>('ball')
const insetOpen = ref(typeof matchMedia === 'function' ? !matchMedia('(max-width: 560px)').matches : true)
const live = reactive({
  view: [] as string[], earlier: [] as string[], feed: [] as HbCausalEvent[], fed: '', tokens: 0,
  clear: { left: 0, ahead: 0, right: 0 }, grid: [] as number[][], known: 0, edges: 0, passes: 0, whiff: 0, hash: '',
})
let bind: typeof import('./bind.ts') | null = null
let loaded: Promise<void> | null = null
let fromDoc = true
let acc = 0
let lastFix: string | null = null
const inset = shallowRef<HTMLCanvasElement | null>(null)
const map = shallowRef<HTMLCanvasElement | null>(null)

const fov = computed(() => tool.values['eye.fov'] ?? 74)
const rate = computed(() => tool.values['eye.rate'] ?? 4)
const floor = computed(() => tool.values['eye.floor'] ?? 4)

function save(fn: (d: SensesBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

function agent(): AgentPose | null {
  const root = tool.walk.value?.stage.body?.avatar.root
  return root ? { x: root.position.x, z: root.position.z, yaw: root.rotation.y } : null
}

// ------------------------------------------------------------- run

/** A restart: the seeded layout (or the document's on first open), a fresh memory and map. */
function begin(rng: Rng) {
  void (async () => {
    if (!loaded) return
    await loaded
    const w = tool.walk.value
    if (!w || !bind) return
    const things: Placed[] = fromDoc && opts.things.length ? opts.things.map((t) => ({ ...t })) : seededLayout(rng, SENSE_THINGS)
    fromDoc = false
    opts.things = things
    save((d) => { d.things = things.map((t) => ({ ...t })) })
    core.value?.dispose()
    core.value = new bind.SenseCore(rng, opts.things)
    if (!rig.value) {
      rig.value = new bind.SenseRig(w.stage.scene, w.stage.renderer, opts.things, rng, {
        cone: tone('--hb-pink') || '#e0457b', gaze: tone('--hb-pink') || '#e0457b', puff: tone('--hb-slime') || '#8f6',
      })
    } else rig.value.restart(opts.things, rng)
    w.place(0, 0, 0)
    acc = 1
    lastFix = null
    Object.assign(live, { view: [], earlier: [], feed: [], passes: 0 })
    tool.body.line = EMPTY
  })()
}

function frame(dt: number, t: number) {
  const r = rig.value
  const c = core.value
  const a = agent()
  if (!r || !c || !a || !bind) return
  r.pose(a, fov.value)
  c.smell(dt, t, a)
  r.drawPuffs(c.puffs())
  acc += dt
  if (acc < 1 / rate.value) return
  acc = 0
  const root = tool.walk.value!.stage.body!.avatar.root
  const p = r.pass(a, fov.value, t, [root])
  c.sense(t, a, () => true, p.pixels, floor.value)
  const fix = p.fixation?.label ?? null
  if (fix && fix !== lastFix) c.look(t, fix)
  if (fix) lastFix = fix
  read(a, t)
}

/** The panes from the core's state after a pass. */
function read(a: AgentPose, t: number) {
  const c = core.value!
  const r = rig.value!
  const s = Math.sin(a.yaw)
  const co = Math.cos(a.yaw)
  const ex = a.x + s * 0.1
  const ez = a.z + co * 0.1
  live.view = c.percepts
    .filter((p) => p.visible)
    .sort((x, y) => x.dist - y.dist)
    .map((p) => { const th = opts.things.find((x) => x.label === p.label)!; return inViewLine(p.label, bearingDeg(th.x - ex, th.z - ez, a.yaw), p.dist) })
  live.earlier = c.seenEarlier(t).map((e) => seenEarlierLine(e.label, e.near, e.ago, e.confidence))
  live.feed = c.events.slice(-80).map((e) => ({ id: e.id, t: e.t, agent: 'agent', kind: e.kind, text: e.text }))
  live.whiff = c.whiff
  live.hash = c.hashHex
  live.passes++
  const last = r.last
  if (last) {
    const f = depthFeed(last.depth, last.dw, last.dh, fov.value)
    live.clear = { left: f.left, ahead: f.ahead, right: f.right }
    live.grid = f.grid
    const fed = feedText(opts.feed, f, live.view)
    live.fed = opts.feed === 'nothing' ? '' : fed.text
    live.tokens = opts.feed === 'nothing' ? 0 : fed.tokens
  }
  tool.body.line = live.view.length ? `in view: ${live.view.slice(0, 3).join('; ')}` : EMPTY
  void nextTick(() => {
    if (inset.value && insetOpen.value) r.drawInset(inset.value, opts.inset, tone('--hb-pink') || '#e0457b')
    if (map.value && open.map) {
      const g = r.drawGrid(map.value, a, { unknown: tone('--hb-sunk') || '#ddd', free: tone('--hb-paper') || '#fff', wall: tone('--hb-ink') || '#111', me: tone('--hb-pink') || '#e0457b' })
      live.known = g.known
      live.edges = g.edges
    }
  })
}

// ------------------------------------------------------------- place

let down: { x: number; y: number; t: number } | null = null
function onDown(e: PointerEvent) { down = { x: e.clientX, y: e.clientY, t: performance.now() } }
function onUp(e: PointerEvent) {
  const d = down
  down = null
  const w = tool.walk.value
  const r = rig.value
  if (!d || !w || !r || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8 || performance.now() - d.t > 600) return
  const box = w.stage.renderer.domElement.getBoundingClientRect()
  const ndc = new Vector2(((e.clientX - box.left) / box.width) * 2 - 1, -((e.clientY - box.top) / box.height) * 2 + 1)
  const hit = r.room.pick(ndc, w.stage.camera)
  if (!hit) return
  if ('label' in hit) { picked.value = hit.label; tool.body.line = `${hit.label} picked. click the floor to put it there.`; return }
  placeAt(picked.value, hit.x, hit.z)
}

function placeAt(label: string, x: number, z: number) {
  const th = opts.things.find((t) => t.label === label)
  if (!th) return
  th.x = clampRoom(x)
  th.z = clampRoom(z)
  rig.value?.room.set(opts.things)
  tool.walk.value?.stage.loop.invalidate()
  acc = 1
  save((d) => { d.things = opts.things.map((t) => ({ ...t })) })
}

// ------------------------------------------------------------- menu

/** The stage menu over a thing (P-ROOM-2): each item sends a sentence. */
function menuAt(at: { x: number; y: number }) {
  const w = tool.walk.value
  const r = rig.value
  if (!w || !r) return null
  const box = w.stage.renderer.domElement.getBoundingClientRect()
  const hit = r.room.pick(new Vector2((at.x / box.width) * 2 - 1, -(at.y / box.height) * 2 + 1), w.stage.camera)
  if (!hit || !('label' in hit)) return null
  const l = hit.label
  return { title: l, items: [{ label: 'look at it', say: `look at the ${l}` }, { label: 'where is it?', say: `where is the ${l}` }, { label: 'put it here', say: `put the ${l} in front of me` }] }
}

/** A sentence from the menu, acted on and written to the feed as said. */
function say(s: string) {
  const c = core.value
  const a = agent()
  const m = /^(look at|where is|put) the (\w+)/.exec(s)
  const th = m ? opts.things.find((t) => t.label === m[2]) : undefined
  if (!c || !a || !m || !th) return
  const t = tool.transport.time
  let reply = ''
  if (m[1] === 'look at') {
    tool.walk.value?.place(a.x, a.z, Math.atan2(th.x - a.x, th.z - a.z))
    reply = `turns to the ${th.label}`
  } else if (m[1] === 'where is') {
    const p = c.percepts.find((x) => x.label === th.label)
    const e = c.seenEarlier(t).find((x) => x.label === th.label)
    reply = p?.visible ? `in view: ${inViewLine(th.label, bearingDeg(th.x - a.x, th.z - a.z, a.yaw), p.dist)}` : e ? `from memory: ${seenEarlierLine(e.label, e.near, e.ago, e.confidence)}` : `the ${th.label} has not been seen.`
  } else {
    const d = 0.6 + (propDef(th.label)?.d ?? 0.3) / 2
    placeAt(th.label, a.x + Math.sin(a.yaw) * d, a.z + Math.cos(a.yaw) * d)
    reply = `the ${th.label} stands in front of it`
  }
  c.say(t, th.label, `"${s}": ${reply}`)
  tool.body.line = `"${s}": ${reply}`
  logEvent('note', `senses: ${s}`)
  acc = 1
  read(agent()!, t)
}

watch(() => opts.feed, (f: Feed) => save((d) => { d.feed = f }))
watch(() => opts.inset, (m: InsetMode) => save((d) => { d.inset = m }))
watch([fov, rate, floor], ([a, b, c]) => save((d) => { d.fov = a; d.rate = b; d.floor = c }))

// ------------------------------------------------------------- export

const name = computed(() => `senses-${tool.seed.value}`)
const formats: HbExportFormat[] = [
  { key: 'feed', label: 'sense feed', ext: '.csv', note: 'every event of the feed: time, tag and words.' },
  { key: 'doc', label: 'document', ext: sensesKind.ext, note: 'where every thing stands, the eye settings and the feed choice.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'events', value: String(core.value?.events.length ?? 0) },
  { label: 'trace hash', value: live.hash || 'none yet' },
  { label: 'seed', value: String(tool.seed.value) },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  const ev = core.value?.events ?? []
  if (!ev.length) { tool.body.line = 'the feed is empty. press play.'; return }
  saveFile(`${fname}.csv`, feedCsv(ev), 'text/csv')
  logEvent('note', `senses: exported ${ev.length} events`)
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === SENSES_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('senses')
  const d = doc.body.value
  if (d) Object.assign(opts, { things: d.things.map((t) => ({ ...t })), feed: d.feed, inset: d.inset })
  loaded = (async () => {
    const m = await import('./bind.ts')
    await m.ready()
    bind = m
  })()
  await loaded
  tool.restart()
})

watch(() => tool.host.value, (el, old) => {
  old?.removeEventListener('pointerdown', onDown)
  old?.removeEventListener('pointerup', onUp)
  el?.addEventListener('pointerdown', onDown)
  el?.addEventListener('pointerup', onUp)
}, { immediate: true })

onBeforeUnmount(() => {
  tool.host.value?.removeEventListener('pointerdown', onDown)
  tool.host.value?.removeEventListener('pointerup', onUp)
  rig.value?.dispose()
  core.value?.dispose()
  rig.value = null
  core.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(rig, (r) => {
  const el = tool.host.value as (HTMLElement & { senses?: unknown }) | null
  const w = tool.walk.value
  if (el && r && w && bind) {
    const sc = bind.screenOf
    el.senses = { live, opts, picked, pixels: () => Object.fromEntries(r.last?.pixels ?? []), percepts: () => core.value?.percepts, screenOf: (x: number, z: number) => sc(x, z, w.stage.camera, w.stage.renderer.domElement), agent }
  }
})

const gridRows = computed(() => live.grid.map((row, i) => ({ row: String(i + 1), ...Object.fromEntries(row.map((v, j) => [`c${j}`, v.toFixed(1)])) })))
const gridCols = [{ key: 'row', label: 'row' }, ...Array.from({ length: 8 }, (_, j) => ({ key: `c${j}`, label: String(j + 1), numeric: true }))]
const insetTitle = computed(() => (opts.inset === 'what it sees' ? 'eye' : opts.inset))

const HOW = `import { load, PerceptMemory, Saliency, OccupancyGrid, Looming, OdourField, Sniffer, seededRng } from "@hackbuild/senses";
import { Eye, cameraFromThree } from "@hackbuild/senses/three";

await load(); // the wasm core, inlined: works from file://
const rng = seededRng(7);
const memory = new PerceptMemory({ rng });
const eye = new Eye(renderer, scene, { fov: 74 });
function sense(t, agent) {
  eye.place(head, agent.yaw, -0.42);
  const pass = eye.pass(tracked, [agent.body]); // pixels per thing, depth
  grid.integrate(pass.camera, pass.depth, pass.depthWidth, pass.depthHeight, 12, agent);
  for (const [i, thing] of things.entries()) {
    const px = pass.visible.find((v) => v.label === thing.label)?.pixels ?? 0;
    memory.sense(i, head, agent.yaw, { pos: thing.pos, size: thing.size, occluded: px < floor }, 1, t);
  }
}`
</script>

<template>
  <StageTool :tool="tool" title="senses">
    <template #under>
      <HbChipGroup v-model="picked" :options="[...SENSE_THINGS]" label="place" data-place />
    </template>
    <template #inset>
      <HbInset v-model:mode="opts.inset" v-model:open="insetOpen" :modes="[...INSETS]" :title="insetTitle" ratio="16 / 9" collapsible>
        <canvas ref="inset" data-inset="eye" />
      </HbInset>
    </template>

    <template #rack>
      <HbFold v-model="open.view" :num="0" summary="in view" persist-key="senses-view">
        <div class="hb-instrument" data-pane="in-view">
          <HbList>
            <div v-for="l in live.view" :key="l" class="hb-row">{{ l }}</div>
            <div v-if="!live.view.length" class="hb-row">{{ EMPTY }}</div>
          </HbList>
          <p class="hb-hint">eye detector: a thing counts once it covers {{ floor }} pixels of the eye frame. bearing is from where the agent faces.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.earlier" :num="1" summary="seen earlier" persist-key="senses-earlier">
        <div class="hb-instrument" data-pane="seen-earlier">
          <HbList>
            <div v-for="l in live.earlier" :key="l" class="hb-row">{{ l }}</div>
            <div v-if="!live.earlier.length" class="hb-row">nothing yet</div>
          </HbList>
          <p class="hb-hint">beliefs: where memory puts a thing drifts with the square root of its age.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.feed" :num="2" summary="sense feed" persist-key="senses-feed">
        <div class="hb-instrument" data-pane="feed">
          <HbCausalLog :events="live.feed" :limit="40" :kinds="['see', 'lost', 'look', 'loom', 'scent', 'say']" label="sense feed" />
          <HbKv label="scent at the nose" :value="live.whiff.toFixed(3)" />
        </div>
      </HbFold>

      <HbFold v-model="open.eyes" :num="3" summary="eyes" persist-key="senses-eyes">
        <div class="hb-instrument" data-pane="eyes">
          <HbParamRow :model-value="fov" label="field of view" :min="50" :max="110" :step="1" unit="deg" :default-value="74" @update:model-value="(v) => tool.reg.set('eye.fov', Number(v))" />
          <HbParamRow :model-value="rate" label="sense rate" :min="1" :max="10" :step="0.5" unit="/s" :default-value="4" @update:model-value="(v) => tool.reg.set('eye.rate', Number(v))" />
          <HbParamRow :model-value="floor" label="detector floor" :min="1" :max="40" :step="1" unit="px" :default-value="4" @update:model-value="(v) => tool.reg.set('eye.floor', Number(v))" />
          <p class="hb-hint">the detector is simulated from eye pixels: a thing is seen only if it covers at least this many pixels of the eye frame.</p>
          <HbSelect v-model="opts.feed" :options="[...FEEDS]" label="feed the brain" />
          <HbKv label="clear left" :value="`${live.clear.left.toFixed(1)} m`" />
          <HbKv label="clear ahead" :value="`${live.clear.ahead.toFixed(1)} m`" />
          <HbKv label="clear right" :value="`${live.clear.right.toFixed(1)} m`" />
          <HbTable v-if="opts.feed === 'clearances and an 8 by 5 grid' && gridRows.length" :columns="gridCols" :rows="gridRows" />
          <pre v-if="live.fed" class="hb-code" data-fed>{{ live.fed }}</pre>
          <HbKv label="prompt cost" :value="`${live.tokens} tokens a pass (inferred, 4 characters a token)`" />
          <p class="hb-hint">give a small language model a few clearances and labelled sightings with ranges, not raw pixels. the grid costs prompt tokens, so turn it on for bigger models.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.map" :num="4" summary="map" persist-key="senses-map">
        <div class="hb-instrument" data-pane="map">
          <HbInset title="map" aux="own depth" ratio="1 / 1"><canvas ref="map" data-map="grid" /></HbInset>
          <HbKv label="floor known" :value="`${live.known.toFixed(1)} square meters (computed)`" />
          <HbKv label="unexplored edges" :value="live.edges" />
          <p class="hb-hint">built from the agent's own depth: ink is a wall, white is floor it has seen. walk with the pad to fill it.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.export" :num="5" summary="export" persist-key="senses-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="rig ? '' : 'the stage is starting.'" label="senses" @export="onExport" />
        <HbButton variant="secondary" size="sm" @click="tool.restart()">back to the seeded layout</HbButton>
      </HbFold>

      <HbHow :packages="['@hackbuild/senses', '@hackbuild/avatar-host']" install="npm i @hackbuild/senses three" :code="HOW" persist-key="senses-how" />
    </template>
  </StageTool>
</template>
