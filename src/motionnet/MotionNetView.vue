<script setup lang="ts">
// The motion-net tool (design 3.11): the neural quadruped gait of
// `@hackbuild/motion-net` under the pad or the keys. A load row names the
// weights' source, size and their own licence line, and fetches only on a
// press, through the suite's one weight store, with progress and cancel
// (P-LOAD-6, P-LOAD-13). Until the weights run, or when they fail, the
// procedural gait of the gait tool walks and the line says so. Style
// chips; phase, paw contacts and inference time in the instrument; the
// procedural dog beside the network as the A and B view (P-CHAT-13); the
// run bakes into a clip file. Written against the package's public
// exports and its readme only.
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue'
import {
  HbButton, HbChipGroup, HbExportPanel, HbFold, HbHow, HbKv, HbLoader, HbParamRow, HbTable,
  type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { PAWS, UPSTREAM, WEIGHT_LICENCE } from '@hackbuild/motion-net'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { CLIP_EXT } from '../avatar/pose.ts'
import { bakedClip } from '../gait/kind.ts'
import type { GaitRig } from '../gait/bind.ts'
import { NET_KIND, SHOWS, STYLE_CHIPS, WEIGHTS_MB, netKind, sourceOf, weightsLine, type NetBody } from './kind.ts'
import type { NetRig, Network } from './bind.ts'
import how from '@hackbuild/motion-net/how'

if (!kinds.get(NET_KIND)) registerKind(netKind)

const STUB = typeof location !== 'undefined' && new URLSearchParams(location.search).has('stub')

const tool = useStageTool({
  id: 'motion-net',
  empty: weightsLine({ state: 'none' }),
  tunables: (reg) => {
    reg.define({ key: 'walk.speed', group: 'network', label: 'top speed', def: 1.2, min: 0.1, max: 3.5, step: 0.1, unit: 'm/s', note: 'speed at full stick. the readme measures the host from 0.6 to 3.5 m/s.', source: 'inferred' })
  },
  restart: (rng) => { gait.value?.restart(rng); net.value?.restart() },
})

const doc = useDocument<NetBody>(NET_KIND)
const opts = reactive<NetBody>(netKind.create())
const open = reactive({ weights: true, network: true, paws: true, export: false })
const gait = shallowRef<GaitRig | null>(null)
const net = shallowRef<NetRig | null>(null)
const w = reactive({
  state: 'none' as 'none' | 'loading' | 'ready' | 'failed',
  url: UPSTREAM.bin as string, loaded: 0, total: null as number | null, error: '', stored: false, licence: '',
  mode: '', fallback: '' as string, sha256: '',
})
const live = reactive({
  source: 'procedural', style: '', speed: 0, turn: 0, evalMs: 0, latencyMs: 0, age: 0, received: 0, frames: 0,
  paws: PAWS.map(() => ({ phase: 0, contact: 0, stance: true })),
})
let gaitMod: typeof import('../gait/bind.ts') | null = null
let netMod: typeof import('./bind.ts') | null = null
let sm: typeof import('../stage/steer') | null = null
let abort: AbortController | null = null
let failNext = false
let offPose: (() => void) | null = null
/** The procedural dog's contact discs, hidden while it stands aside. */
let gaitDiscs: { visible: boolean }[] = []

const running = computed(() => w.state === 'ready' && !!net.value?.host)
/** What walks: the network only once it runs. */
const showNet = computed(() => running.value && opts.show !== 'procedural')
const showGait = computed(() => !showNet.value || opts.show === 'both')
const line = computed(() => weightsLine({ state: w.state, loaded: w.loaded, error: w.error, stub: w.mode === 'stub', stored: w.stored }))
const styleOptions = STYLE_CHIPS.map((s) => ({ value: s, label: s.toLowerCase() }))
const pawRows = computed(() => live.paws.map((p, i) => ({ paw: PAWS[i], phase: p.phase.toFixed(2), contact: p.contact.toFixed(2), foot: p.stance ? 'planted' : 'swing' })))

function save(fn: (d: NetBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

// ------------------------------------------------------------- weights

async function store() {
  const hub = await import('../models/hub.ts')
  await hub.start()
  return hub.weights()
}

async function refreshStored() {
  if (STUB) return
  try { w.stored = await netMod!.stored(await store(), w.url) } catch { w.stored = false }
}

async function adoptNetwork(get: () => Promise<Network>) {
  if (w.state === 'loading') return
  abort = new AbortController()
  Object.assign(w, { state: 'loading', loaded: 0, total: UPSTREAM.binBytes, error: '' })
  logEvent('note', `motion-net: loading weights from ${sourceOf(w.url)}`)
  try {
    const n = await get()
    net.value?.use(n)
    Object.assign(w, { state: 'ready', mode: n.mode, fallback: n.fallbackReason ?? '', sha256: n.sha256 ?? '' })
    logEvent('done', `motion-net: network running, ${n.mode}`)
    tool.restart()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const cancelled = abort?.signal.aborted
    Object.assign(w, { state: 'failed', error: cancelled ? 'cancelled. the parts kept so far resume on the next load' : msg.replace(/\.$/, '') })
    net.value?.use(null)
    logEvent('fail', `motion-net: ${w.error}`)
  } finally {
    abort = null
    void refreshStored()
  }
}

function onLicence(text: string) {
  w.licence = text
  logEvent('note', text)
}

function load(url: string) {
  w.url = url || UPSTREAM.bin
  const fail = failNext
  failNext = false
  void adoptNetwork(async () => {
    if (STUB) return netMod!.stubNetwork(fail)
    const s = await store()
    return netMod!.fetchNetwork({
      store: s, url: w.url, signal: abort!.signal, onLicence,
      onProgress: (loaded, total) => { w.loaded = loaded; w.total = total },
    })
  })
}

function cancel() {
  abort?.abort()
  if (!STUB) void store().then((s) => s.cancel(w.url))
}

function dropped(files: File[]) {
  void adoptNetwork(() => netMod!.fromFiles(files, onLicence))
}

function unload() {
  net.value?.use(null)
  Object.assign(w, { state: 'none', mode: '', fallback: '', sha256: '' })
}

// ------------------------------------------------------------- frame

let last = 0
let frames = 0
function frame() {
  const st = tool.walk.value
  const n = net.value
  const g = gait.value
  if (!st || !n || !g || !sm) return
  const t = st.stage.loop.time
  const dt = Math.min(0.05, Math.max(0, t - last))
  last = t
  if (!tool.transport.playing) return
  const top = tool.values['walk.speed'] ?? 1.2
  const step = dt * tool.transport.rate
  const h = n.host
  n.offsetX = opts.show === 'both' ? 0.7 : 0
  g.dog.visible = showGait.value
  for (const d of gaitDiscs) if (!showGait.value) d.visible = false
  if (showGait.value) {
    const c = sm.padCommand(st.stage.camera, tool.move.value, g.pose.yaw, top)
    g.step(step, c.speed, c.turnRate)
  }
  let hf = null
  if (showNet.value && h) {
    const c = sm.padCommand(st.stage.camera, tool.move.value, h.root.yaw, top)
    hf = n.step(step, { speed: c.speed, turnRate: c.turnRate, style: opts.style })
  } else n.step(0, { speed: 0, turnRate: 0 }) // hides it when nothing runs
  if (!showNet.value) n.root.visible = false
  // the hidden mannequin stands where the bodies are, so the camera follows them
  const proxy = st.stage.body?.avatar.root
  if (proxy) {
    const gx = g.pose.x
    const gz = g.pose.z
    const nx = hf ? hf.root.x + n.offsetX : gx
    const nz = hf ? hf.root.z : gz
    const both = hf && showGait.value
    proxy.position.set(both ? (gx + nx) / 2 : hf ? nx : gx, 0, both ? (gz + nz) / 2 : hf ? nz : gz)
    proxy.updateMatrixWorld(true)
  }
  st.stage.loop.invalidate()
  if (frames++ % 4) return
  if (hf) {
    const m = hf.motorState()
    live.source = m.source
    live.style = hf.style
    live.speed = Math.hypot(hf.rootVelocity.x, hf.rootVelocity.z)
    live.turn = hf.rootVelocity.turnRate
    live.evalMs = hf.evalMs
    live.latencyMs = hf.latencyMs
    live.age = hf.predictionAge
    live.received = hf.received
    live.frames = n.baked().frames
    hf.paws.forEach((p, i) => { live.paws[i] = { phase: p.phase, contact: p.contact, stance: p.stance } })
  } else {
    const f = g.last
    live.source = 'procedural'
    live.style = ''
    live.speed = f?.speed ?? 0
    live.turn = f?.turnRate ?? 0
    live.frames = g.baked().frames
    f?.state.feet.forEach((ft, i) => { live.paws[i] = { phase: f.state.legPhases[i] ?? 0, contact: ft.stance ? 1 : 0, stance: ft.stance } })
  }
}

function adoptBody() {
  const st = tool.walk.value
  const b = st?.stage.body
  const g = gait.value
  if (!st || !b || !g || !gaitMod) return
  b.avatar.root.visible = false
  b.avatar.root.scale.setScalar(0.32)
  g.setRig(g.dog, gaitMod.DOG_NAMES)
  if (!tool.body.placeholder) tool.body.line = `the network drives its own 27 bone skeleton; ${tool.body.name} is not retargeted. the gait tool walks a dropped quadruped.`
}

// the caption carries the weights line while the built in body stands
watch(line, (l) => { if (tool.body.placeholder) tool.body.line = l })
watch(() => tool.body.placeholder, (p) => { if (p) tool.body.line = line.value })

watch(() => opts.style, (s) => save((d) => { d.style = s }))
watch(() => opts.show, (s) => save((d) => { d.show = s }))
watch(() => opts.bake, (b) => {
  if (net.value) net.value.bakeSeconds = b
  if (gait.value) gait.value.bakeSeconds = b
  save((d) => { d.bake = b })
})

// ------------------------------------------------------------- export

const name = computed(() => `dog-${showNet.value ? 'motion-net' : 'gait'}`)
const formats: HbExportFormat[] = [
  { key: 'clip', label: 'clip', ext: CLIP_EXT, note: 'the last seconds of the run at 30 fps: local rotations of every bone, the root track and the paw contacts. the procedural dog when the network is not running.' },
  { key: 'doc', label: 'document', ext: netKind.ext, note: 'the style chip, the view and the bake length. weights and body files are never in it.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'source', value: showNet.value ? `network, ${w.mode}` : 'procedural gait' },
  { label: 'baked', value: `${live.frames} frames, ${(live.frames / 30).toFixed(1)} s` },
])
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  const useNet = showNet.value && net.value
  const b = useNet ? net.value!.baked() : gait.value?.baked()
  if (!b?.frames) { tool.body.line = 'nothing baked yet. press play and walk a few steps.'; return }
  const clip = bakedClip(fname, useNet ? 'motion-net' : 'gait', 30, b.bones, b.rotations, b.root, useNet ? [...PAWS] : ['LF', 'RF', 'LH', 'RH'], b.contacts)
  saveFile(`${fname}${CLIP_EXT}`, JSON.stringify(clip), 'application/json')
  tool.body.line = `${fname}${CLIP_EXT} saved, ${b.frames} frames.`
  logEvent('note', `motion-net: baked ${b.frames} frames`)
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === NET_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('motion-net')
  const d = doc.body.value
  if (d) Object.assign(opts, { style: d.style, show: d.show, bake: d.bake })
  const [g, n, s] = await Promise.all([import('../gait/bind.ts'), import('./bind.ts'), import('../stage/steer')])
  await g.ready()
  gaitMod = g
  netMod = n
  sm = s
  void refreshStored()
})

watch(
  () => tool.walk.value,
  async (st) => {
    if (!st) return
    while (!gaitMod || !netMod) await new Promise((r) => setTimeout(r, 20))
    const g = new gaitMod.GaitRig(st.stage.scene, { stance: tone('--hb-ink') || '#1a1a1a', swing: tone('--hb-pink') || '#e0457b', ground: tone('--hb-sunk') || '#efe9db' }, tone('--hb-raised') || '#e8e0d0')
    g.bakeSeconds = opts.bake
    gait.value = g
    gaitDiscs = st.stage.scene.children.filter((o) => o.name.startsWith('contact '))
    const n = new netMod.NetRig(st.stage.scene, { body: tone('--hb-pink') || '#e0457b', stance: tone('--hb-ink') || '#1a1a1a' })
    n.bakeSeconds = opts.bake
    net.value = n
    st.stage.on('loaded', () => adoptBody())
    adoptBody()
    tool.view.value = 'side'
    last = st.stage.loop.time
    const prev = st.stage.scene.onBeforeRender
    st.stage.scene.onBeforeRender = (...a) => { prev.apply(st.stage.scene, a); frame() }
    offPose = () => { st.stage.scene.onBeforeRender = prev }
  },
)

onBeforeUnmount(() => {
  abort?.abort()
  offPose?.()
  gait.value?.dispose()
  net.value?.dispose()
})

// for the smoke: the tool handle on the stage host, no global
watch([net, gait], ([n, g]) => {
  const el = tool.host.value as (HTMLElement & { motionnet?: unknown }) | null
  if (el && n && g) {
    el.motionnet = {
      live, w, opts,
      failNext: () => { failNext = true },
      root: () => (showNet.value && n.host ? { x: n.host.root.x, z: n.host.root.z } : { x: g.pose.x, z: g.pose.z }),
      pose: () => (n.host ? Array.from(n.host.positions) : []),
    }
  }
})

</script>

<template>
  <StageTool :tool="tool" title="motion-net">
    <template #band>
      <HbChipGroup v-model="opts.show" :options="[...SHOWS]" label="what walks" />
    </template>

    <template #rack>
      <HbFold v-model="open.weights" :num="0" summary="weights" persist-key="net-weights">
        <p class="hb-hint" data-line="weights" role="status">{{ line }}</p>
        <HbLoader
          v-model:url="w.url"
          title="quadruped codebook network"
          instrument
          url-label="weights url (the manifest sits beside it as .json)"
          drop-hint="or drop the .json manifest and the .bin together"
          accept=".json,.bin"
          multiple
          :size-m-b="WEIGHTS_MB"
          size-source="vendor"
          :licence="WEIGHT_LICENCE"
          :commercial="false"
          :expected-sha256="w.url === UPSTREAM.bin ? UPSTREAM.binSha256 : ''"
          :sha256="w.sha256"
          :loaded="w.loaded"
          :total="w.total"
          :state="w.state === 'loading' ? 'running' : w.state === 'ready' && w.mode !== 'stub' ? 'done' : w.state === 'failed' ? 'failed' : 'idle'"
          :error="w.state === 'failed' ? w.error : ''"
          :load-label="w.stored ? 'load from this browser' : 'load'"
          @load="load"
          @cancel="cancel"
          @resume="load(w.url)"
          @files="dropped"
        >
          <template #actions>
            <HbButton v-if="w.state === 'ready'" variant="secondary" size="sm" @click="unload">unload</HbButton>
          </template>
        </HbLoader>
        <HbKv label="source" :value="sourceOf(w.url)" />
        <HbKv label="size" :value="`${WEIGHTS_MB} mb (vendor)`" />
        <p v-if="w.licence" class="hb-hint">{{ w.licence }}</p>
      </HbFold>

      <HbFold v-model="open.network" :num="1" summary="network" persist-key="net-network">
        <div class="hb-instrument" data-pane="network">
          <HbChipGroup v-model="opts.style" :options="styleOptions" toggle label="style" />
          <HbKv label="body source" :value="live.source" />
          <HbKv label="engine" :value="w.state === 'ready' ? (w.fallback ? `${w.mode}, ${w.fallback}` : w.mode) : 'none'" />
          <HbKv label="inference" data-infer :value="showNet ? `${live.evalMs.toFixed(2)} ms (measured)` : 'not running'" />
          <HbKv label="latency" :value="showNet ? `${live.latencyMs.toFixed(1)} ms (measured)` : 'not running'" />
          <HbKv label="style now" :value="live.style ? live.style.toLowerCase() : 'none'" />
          <HbKv label="speed" :value="`${live.speed.toFixed(2)} m/s`" />
          <HbKv label="turn rate" :value="`${live.turn.toFixed(2)} rad/s`" />
          <HbKv label="predictions" :value="showNet ? `${live.received}, the last ${live.age.toFixed(2)} s old` : 'none'" />
          <p class="hb-hint">a new prediction is asked for every 0.1 s and covers 16 frames. auto picks idle, walk, trot or canter by speed; the other styles are held, and the readme says nothing measures how they look.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.paws" :num="2" summary="phase and contacts" persist-key="net-paws">
        <div class="hb-instrument" data-pane="paws">
          <HbTable :columns="[{ key: 'paw', label: 'paw' }, { key: 'phase', label: 'phase', numeric: true }, { key: 'contact', label: 'contact', numeric: true }, { key: 'foot', label: 'foot' }]" :rows="pawRows" />
          <p class="hb-hint">phase is the share of the stride since touchdown. a paw pins above a contact of 0.8 and lets go below 0.6 (DEFAULT_TUNING).</p>
        </div>
      </HbFold>

      <HbFold v-model="open.export" :num="3" summary="export" persist-key="net-export">
        <HbParamRow
          :model-value="opts.bake" label="bake the last" :min="1" :max="30" :step="1" unit="s" :default-value="6"
          @update:model-value="(v) => (opts.bake = Number(v))"
        />
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="net ? '' : 'the stage is starting.'" label="motion-net" @export="onExport" />
      </HbFold>

      <HbHow v-bind="how" persist-key="net-how" />
    </template>
  </StageTool>
</template>
