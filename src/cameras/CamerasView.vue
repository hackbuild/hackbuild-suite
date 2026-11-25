<script setup lang="ts">
// The cameras tool (design 3.12): every rig of `@hackbuild/cameras` on a
// moving target. Camera chips on the stage as toggles (P-STAGE-5, the room
// original's follow and map toggles; the slate of the director cut,
// P-STAGE-11, as the rig readout), keys printed where they act (P-KEY-6).
// New here: touch orbit (drag, pinch) and the pad takes the body. Split
// follows each target in its own viewport; shake kicks a seeded offset
// that decays.
import { computed, onBeforeUnmount, onMounted, reactive, shallowRef, watch } from 'vue'
import {
  HbButton, HbChip, HbExportPanel, HbFold, HbHow, HbKv, HbParamRow, useHotkeys,
  type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import type { Rng } from '@hackbuild/organic'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { seededLayout } from '../agents/props.ts'
import { CAMERAS_COPY, CAMERAS_KIND, RIGS, Walker, camerasKind, seededLoop, type CamerasBody, type Rig } from './kind.ts'
import type { CameraRig } from './rig.ts'
import how from '@hackbuild/cameras/how'

if (!kinds.get(CAMERAS_KIND)) registerKind(camerasKind)

const SCENERY = ['shelf', 'table', 'chair', 'box'] as const
const tool = useStageTool({
  id: 'cameras',
  empty: CAMERAS_COPY.empty,
  tunables: (reg) => {
    reg.define({ key: 'walk.speed', group: 'body', label: 'walk speed', def: 1.2, min: 0.2, max: 3, step: 0.1, unit: 'm/s', note: 'speed of the body on the pad and on its loop.', source: 'inferred' })
    reg.define({ key: 'shake.kick', group: 'shake', label: 'kick', def: 0.25, min: 0.05, max: 1, step: 0.05, unit: 'm', note: 'trauma one shake adds; kicks add up to 1 m.', source: 'vendor', cite: 'library page 0.25' })
  },
  restart: (rng) => begin(rng),
  tick: (dt) => frame(dt),
  hints: (base) => [...base.filter((h) => h.keys !== '1 to 4'), { keys: '1 to 4', label: 'rig' }, { keys: 'v', label: 'split' }, { keys: 'k', label: 'shake' }, { keys: 'drag', label: 'orbit' }],
})

const doc = useDocument<CamerasBody>(CAMERAS_KIND)
const opts = reactive<CamerasBody>(camerasKind.create())
const open = reactive({ rig: true, orbit: true, shake: true, export: false })
const rig = shallowRef<CameraRig | null>(null)
const live = reactive({ x: 0, y: 0, z: 0, dist: 0, drawn: 0, amp: 0, pulled: false })
let walkers: Walker[] = []
let mod: typeof import('./rig.ts') | null = null
let fromDoc = true

const kick = computed(() => tool.values['shake.kick'] ?? 0.25)
const speed = computed(() => tool.values['walk.speed'] ?? 1.2)

function save(fn: (d: CamerasBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

// ------------------------------------------------------------- run

function begin(rng: Rng) {
  const w = tool.walk.value
  if (!w || !mod) return
  const things = seededLayout(rng, SCENERY)
  walkers = [new Walker(seededLoop(rng), speed.value), new Walker(seededLoop(rng), speed.value * 0.8)]
  if (!rig.value) {
    rig.value = new mod.CameraRig(w.stage, things, rng, tone('--hb-slime') || '#8f6')
    rig.value.stats = read
  } else rig.value.restart(things, rng)
  const r = rig.value
  if (fromDoc) {
    Object.assign(r.orbit, { yaw: opts.orbit.yaw, pitch: opts.orbit.pitch, dist: opts.orbit.dist })
    fromDoc = false
  }
  apply()
  w.place(walkers[0]!.x, walkers[0]!.z, 0)
  tool.body.line = CAMERAS_COPY.empty
}

function frame(dt: number) {
  const w = tool.walk.value
  const r = rig.value
  if (!w || !r || walkers.length < 2) return
  const [a, b] = walkers as [Walker, Walker]
  const m = tool.move.value
  if (m.x || m.y) {
    // the pad has the body: the loop picks up from where it stands
    const p = w.position()
    a.x = p.x
    a.z = p.z
  } else {
    a.step(dt)
    w.place(a.x, a.z, a.heading)
  }
  b.step(dt)
  r.place2(b.x, b.z, b.heading)
}

function read() {
  const r = rig.value
  const c = tool.walk.value?.stage.camera
  if (!r || !c) return
  live.x = c.position.x
  live.y = c.position.y
  live.z = c.position.z
  live.dist = r.rig === 'orbit' ? r.orbit.dist : r.rig === 'group' ? r.group.dist : r.rig === 'follow' ? r.follow.dist : 0
  live.pulled = r.rig === 'follow' && r.follow.dist < r.follow.o.distance - 1e-3
  live.drawn = r.drawn
  live.amp = r.shake.amplitude
}

/** The document's choices onto the rig. */
function apply() {
  const r = rig.value
  if (!r) return
  r.rig = opts.rig
  r.second = opts.second
  r.split = opts.split
  r.friend.visible = opts.second
  tool.walk.value?.stage.loop.invalidate()
}

function pick(v: Rig) {
  opts.rig = v
  if (opts.split) opts.split = false
  logEvent('note', `cameras: ${v}`)
}
function toggleSplit() {
  if (!opts.split && !opts.second) { tool.body.line = CAMERAS_COPY.noSecond; return }
  opts.split = !opts.split
  tool.body.line = opts.split ? 'split: the body on the left, the second target on the right.' : `${opts.rig} camera.`
}
function toggleSecond() {
  opts.second = !opts.second
  if (!opts.second && opts.split) { opts.split = false; tool.body.line = CAMERAS_COPY.noSecond }
}
function shake() {
  rig.value?.kick(kick.value)
  logEvent('note', `cameras: shake ${kick.value} m`)
}

watch(() => [opts.rig, opts.split, opts.second] as const, ([rg, sp, se]) => {
  apply()
  save((d) => { d.rig = rg; d.split = sp; d.second = se })
})
watch(kick, (k) => save((d) => { d.kick = k }))

useHotkeys([
  { keys: 'v', label: 'split view on or off', group: 'stage', run: toggleSplit },
  { keys: 'k', label: 'shake the camera', group: 'stage', run: shake },
  { keys: 'q', label: 'orbit left', group: 'stage', run: () => turn(-0.15, 0) },
  { keys: 'e', label: 'orbit right', group: 'stage', run: () => turn(0.15, 0) },
  { keys: '-', label: 'orbit out', group: 'stage', run: () => zoom(1.1) },
  { keys: '=', label: 'orbit in', group: 'stage', run: () => zoom(0.9) },
])

// ------------------------------------------------------------- touch orbit

function turn(dy: number, dp: number) {
  const r = rig.value
  if (!r || opts.rig !== 'orbit' || opts.split) return
  r.orbit.rotate(dy, dp)
  orbitSaved()
}
function zoom(f: number) {
  const r = rig.value
  if (!r || opts.rig !== 'orbit' || opts.split) return
  r.orbit.zoom(f)
  orbitSaved()
}
let orbitT: ReturnType<typeof setTimeout> | null = null
function orbitSaved() {
  tool.walk.value?.stage.loop.invalidate()
  if (orbitT) clearTimeout(orbitT)
  orbitT = setTimeout(() => {
    const o = rig.value?.orbit
    if (o) save((d) => { d.orbit = { yaw: o.yaw, pitch: o.pitch, dist: o.dist } })
  }, 300)
}

// one pointer drags the orbit, two pinch the zoom (the library page's steps)
const held = new Map<number, { x: number; y: number }>()
let pinch = 0
function onDown(e: PointerEvent) {
  held.set(e.pointerId, { x: e.clientX, y: e.clientY })
  ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
}
function onMove(e: PointerEvent) {
  const p = held.get(e.pointerId)
  if (!p) return
  if (held.size === 1) turn((e.clientX - p.x) * 0.006, (e.clientY - p.y) * 0.004)
  p.x = e.clientX
  p.y = e.clientY
  if (held.size === 2) {
    const [a, b] = [...held.values()] as [{ x: number; y: number }, { x: number; y: number }]
    const d = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinch) zoom(pinch / Math.max(1, d))
    pinch = d
  }
}
function onUp(e: PointerEvent) {
  held.delete(e.pointerId)
  pinch = 0
}
function onWheel(e: WheelEvent) {
  if (opts.rig !== 'orbit' || opts.split) return
  e.preventDefault()
  zoom(e.deltaY > 0 ? 1.1 : 0.9)
}

watch(() => tool.host.value, (el, old) => {
  for (const [k, f] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp]] as const) {
    old?.removeEventListener(k, f as EventListener)
    el?.addEventListener(k, f as EventListener)
  }
  old?.removeEventListener('wheel', onWheel)
  el?.addEventListener('wheel', onWheel, { passive: false })
}, { immediate: true })

// ------------------------------------------------------------- export

const name = computed(() => `cameras-${tool.seed.value}`)
const formats: HbExportFormat[] = [
  { key: 'doc', label: 'document', ext: camerasKind.ext, note: 'the rig, split, second target, shake kick and the orbit.' },
]
const readout = computed<HbExportReadout[]>(() => [
  { label: 'rig', value: opts.split ? 'split' : opts.rig },
  { label: 'seed', value: String(tool.seed.value) },
])
async function onExport(req: HbExportRequest) {
  const d = doc.doc.value
  if (d) await exportDoc(d.id, { filename: req.filename || name.value })
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === CAMERAS_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('cameras')
  const d = doc.body.value
  if (d) Object.assign(opts, JSON.parse(JSON.stringify(d)))
  mod = await import('./rig.ts')
  // the stage may still be starting: the first restart then comes from it
  if (tool.walk.value) tool.restart()
})

// the stage started after the module: begin from its own restart
watch(() => tool.walk.value, (w) => { if (w && mod && !rig.value) tool.restart() })

onBeforeUnmount(() => {
  if (orbitT) clearTimeout(orbitT)
  rig.value?.dispose()
  rig.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(rig, (r) => {
  const el = tool.host.value as (HTMLElement & { cameras?: unknown }) | null
  if (el && r) el.cameras = { live, opts, rig: () => ({ rig: r.rig, split: r.split, drawn: r.drawn, amp: r.shake.amplitude, yaw: r.orbit.yaw }), kick: shake }
})

</script>

<template>
  <StageTool :tool="tool" title="cameras">
    <template #cams>
      <div class="hb-cams" role="group" aria-label="camera rig" data-rigs>
        <HbChip
          v-for="(v, i) in RIGS"
          :key="v"
          :model-value="!opts.split && opts.rig === v"
          toggle
          :hotkey="String(i + 1)"
          :hotkey-label="`${v} camera`"
          hotkey-group="stage"
          @click="pick(v)"
        >{{ v }}</HbChip>
      </div>
    </template>
    <template #band>
      <HbChip :model-value="opts.split" toggle data-split @click="toggleSplit">split</HbChip>
      <HbChip :model-value="opts.second" toggle data-second @click="toggleSecond">second target</HbChip>
      <HbButton variant="secondary" size="sm" aria-keyshortcuts="k" data-shake @click="shake">shake</HbButton>
    </template>

    <template #rack>
      <HbFold v-model="open.rig" :num="0" summary="rig" persist-key="cameras-rig">
        <div class="hb-instrument" data-pane="rig">
          <HbKv label="camera" :value="opts.split ? 'split: follow each target' : opts.rig" />
          <HbKv label="viewports" :value="live.drawn" />
          <HbKv label="at" :value="`${live.x.toFixed(2)}, ${live.y.toFixed(2)}, ${live.z.toFixed(2)} m`" />
          <HbKv v-if="live.dist" label="distance" :value="`${live.dist.toFixed(2)} m`" />
          <HbKv v-if="opts.rig === 'follow' && !opts.split" label="pulled in by a thing" :value="live.pulled ? 'yes' : 'no'" />
          <p class="hb-hint">follow trails the body and pulls in when furniture blocks the view. first person hides the head while it draws. group keeps both targets in frame.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.orbit" :num="1" summary="orbit" persist-key="cameras-orbit">
        <div class="hb-instrument" data-pane="orbit">
          <p class="hb-hint">drag the stage to turn, pinch or scroll to zoom, or q and e, minus and equals. the orbit is kept with the session.</p>
          <HbButton variant="secondary" size="sm" :disabled="opts.rig === 'orbit' && !opts.split" @click="pick('orbit')">use the orbit</HbButton>
        </div>
      </HbFold>

      <HbFold v-model="open.shake" :num="2" summary="shake" persist-key="cameras-shake">
        <div class="hb-instrument" data-pane="shake">
          <HbParamRow :model-value="kick" label="kick" :min="0.05" :max="1" :step="0.05" unit="m" :default-value="0.25" @update:model-value="(v) => tool.reg.set('shake.kick', Number(v))" />
          <HbKv label="amplitude now" :value="`${live.amp.toFixed(3)} m`" data-amp />
          <p class="hb-hint">seeded value noise on three axes; the amplitude decays by itself. it draws from its own stream, so the frame rate never changes the run.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.export" :num="3" summary="export" persist-key="cameras-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="rig ? '' : 'the stage is starting.'" label="cameras" @export="onExport" />
      </HbFold>

      <HbHow v-bind="how" persist-key="cameras-how" />
    </template>
  </StageTool>
</template>
