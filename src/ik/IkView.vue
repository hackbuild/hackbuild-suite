<script setup lang="ts">
// The ik tool (design 3.11): pose limbs by dragging targets on the stage
// (the character as its own control surface, P-STAGE-12; draggable
// targets with touch, gap 67). Chain and solver are chip rows (P-CAM-4);
// a target dragged is pinned, a released one follows the body; planted
// feet hold the floor through the foot lock while the hips move; the head
// turns to the look target. The rack reads reach and error for the chain
// in hand, and the pose exports as json by human bone.
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbChipGroup, HbExportPanel, HbFold, HbHow, HbKv, HbToggleRow,
  type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { CHAINS, CHAIN_TARGET, IK_KIND, SOLVERS, ikKind, poseFile, reachLine, type ChainId, type IkBody, type Solver, type TargetId } from './kind.ts'
import type { IkRig } from './bind.ts'

if (!kinds.get(IK_KIND)) registerKind(ikKind)

const tool = useStageTool({
  id: 'ik',
  empty: 'drag a dot to pose the mannequin: hands, feet, hips, and the look. a glb or vrm drops anywhere.',
})

const doc = useDocument<IkBody>(IK_KIND)
const fresh = ikKind.create()
const opts = reactive({ solver: fresh.solver as Solver, chain: fresh.chain as ChainId, plant: fresh.plant, look: fresh.look })
const open = reactive({ chain: true, floor: true, export: true })
const rig = shallowRef<IkRig | null>(null)
const live = reactive({ dist: 0, reach: 0, error: 0, pinned: false, planted: '' })
const coarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null
let bind: typeof import('./bind.ts') | null = null
let offPose: (() => void) | null = null
let offLoaded: (() => void) | null = null
let restored = false

const target = computed<TargetId>(() => CHAIN_TARGET[opts.chain])
const TARGET_WORDS: Record<TargetId, string> = { leftHand: 'left hand', rightHand: 'right hand', leftFoot: 'left foot', rightFoot: 'right foot', hips: 'hips', look: 'look' }
const CHAIN_OF: Partial<Record<TargetId, ChainId>> = Object.fromEntries(Object.entries(CHAIN_TARGET).map(([c, t]) => [t, c]))

function save(fn: (d: IkBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}
function saveTargets() {
  const r = rig.value
  if (r) save((d) => { d.targets = r.snapshot() })
}

const over = computed(() => (live.pinned && opts.chain !== 'spine' ? live.dist - live.reach : 0))
const overLine = computed(() => reachLine(over.value))

let frames = 0
let last = 0
function frame() {
  const r = rig.value
  const w = tool.walk.value
  if (!r || !w) return
  const t = w.stage.loop.time
  const dt = Math.min(0.1, Math.max(1 / 240, t - last))
  last = t
  r.selected = target.value
  r.solve(dt)
  if (frames++ % 6 === 0 || r.dragging) {
    const i = r.info.get(target.value)
    live.dist = i?.dist ?? 0
    live.reach = i?.reach ?? 0
    live.error = i?.error ?? 0
    live.pinned = r.targets.get(target.value)?.pinned ?? false
  }
}

function adopt() {
  const r = rig.value
  if (!r) return
  r.setBody()
  const d = doc.body.value
  if (d && !restored && tool.body.placeholder) r.restore(d.targets)
  restored = true
  tool.walk.value?.stage.loop.invalidate()
}

function release(id: TargetId = target.value) {
  rig.value?.pin(id, false)
  saveTargets()
}
function releaseAll() {
  for (const id of ['leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'hips', 'look'] as const) rig.value?.pin(id, false)
  saveTargets()
  tool.body.line = 'every target released. the body stands as its pose puts it.'
}

watch(() => ({ ...opts }), (o) => {
  const r = rig.value
  if (r) r.opts = { solver: o.solver, plant: o.plant, look: o.look }
  tool.walk.value?.stage.loop.invalidate()
  save((d) => Object.assign(d, o))
})
watch(overLine, (l) => { if (l) tool.body.line = l })

// ------------------------------------------------------------- export

const name = computed(() => `${tool.body.name}-pose`.replace(/[^\w.-]+/g, '-'))
const formats: HbExportFormat[] = [
  { key: 'pose', label: 'pose', ext: '.pose.json', note: 'each human bone\'s local rotation, the hips position and the pinned targets.' },
  { key: 'doc', label: 'document', ext: ikKind.ext, note: 'the targets, pins, solver and switches. body files are never in it.' },
]
const pinnedCount = ref(0)
const readout = computed<HbExportReadout[]>(() => [
  { label: 'body', value: tool.body.name },
  { label: 'pinned', value: `${pinnedCount.value} of 6 targets` },
  { label: 'solver', value: opts.solver },
])
function currentPose() {
  const r = rig.value!
  const p = r.pose()
  const targets: Partial<Record<TargetId, number[]>> = {}
  for (const [id, t] of r.targets) if (t.pinned) targets[id] = t.pos.toArray()
  return poseFile(tool.body.name, p.rotations, p.hips, targets)
}
async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  if (!rig.value) return
  saveFile(`${fname}.pose.json`, JSON.stringify(currentPose(), null, 1), 'application/json')
  tool.body.line = `${fname}.pose.json saved.`
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === IK_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('ik')
  const d = doc.body.value
  if (d) Object.assign(opts, { solver: d.solver, chain: d.chain, plant: d.plant, look: d.look })
  const m = await import('./bind.ts')
  await m.ready()
  bind = m
})

watch(
  () => tool.walk.value,
  async (w) => {
    if (!w) return
    while (!bind) await new Promise((r) => setTimeout(r, 20))
    const r = new bind.IkRig(w.stage, { pinned: tone('--hb-pink') || '#e0457b', free: tone('--hb-info') || '#3b82f6', look: tone('--hb-slime') || '#8f6' }, () => !!coarse?.matches)
    r.opts = { solver: opts.solver, plant: opts.plant, look: opts.look }
    r.onDrop = (id) => {
      const c = CHAIN_OF[id]
      if (c) opts.chain = c
      saveTargets()
      pinnedCount.value = [...r.targets.values()].filter((t) => t.pinned).length
      logEvent('note', `ik: ${TARGET_WORDS[id]} pinned`)
      tool.body.line = reachLine(over.value) ?? `${TARGET_WORDS[id]} pinned. release it in the rack to hand it back to the body.`
    }
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
  const el = tool.host.value as (HTMLElement & { ik?: unknown }) | null
  if (el && r) el.ik = { screenOf: (id: TargetId) => r.screenOf(id), where: (b: string) => r.where(b), target: (id: TargetId) => r.targets.get(id)!.pos.toArray(), live, opts }
})

const HOW = `import { load, pelvisDrop } from "@hackbuild/ik";
import { solveTwoBone, solveChain, lookAtChain, FootLock } from "@hackbuild/ik/three";

await load(); // the wasm core, inlined: works from file://
const lock = new FootLock();
function frame(dt) {
  // after the body's own pose
  lock.update(dt, footTarget, contact); // holds a planted foot
  solveTwoBone(b.leftUpperLeg, b.leftLowerLeg, b.leftFoot, footTarget, kneeForward);
  solveChain([b.leftUpperArm, b.leftLowerArm, b.leftHand], handTarget, { method: "fabrik" });
  lookAtChain([b.neck, b.head], [0.4, 0.6], lookTarget, body.quaternion);
}`
</script>

<template>
  <StageTool :tool="tool" title="ik">
    <template #rack>
      <HbFold v-model="open.chain" :num="0" summary="chain" persist-key="ik-chain">
        <div data-pane="chain">
          <HbChipGroup v-model="opts.chain" :options="[...CHAINS]" toggle label="chain" />
          <HbChipGroup v-model="opts.solver" :options="[...SOLVERS]" toggle label="solver" />
          <HbKv label="target" :value="`${TARGET_WORDS[target]}, ${live.pinned ? 'pinned' : 'free, follows the body'}`" />
          <HbKv v-if="opts.chain !== 'spine'" label="reach" :value="`${live.dist.toFixed(3)} of ${live.reach.toFixed(3)} m`" />
          <HbKv v-if="opts.chain !== 'spine'" label="error" :value="`${(live.error * 1000).toFixed(1)} mm (measured)`" />
          <p v-if="overLine" class="hb-hint" data-reach="over">{{ overLine }}</p>
          <p class="hb-hint">drag a dot on the stage to pin it there. pink is pinned, blue follows the body, green is the look.</p>
          <div class="hb-row">
            <HbButton variant="secondary" size="sm" :disabled="!live.pinned" @click="release()">release {{ TARGET_WORDS[target] }}</HbButton>
            <HbButton variant="secondary" size="sm" @click="releaseAll">release all</HbButton>
          </div>
        </div>
      </HbFold>

      <HbFold v-model="open.floor" :num="1" summary="feet and look" persist-key="ik-floor">
        <HbToggleRow v-model="opts.plant" label="plant the feet" description="a foot on the floor stays where it landed while the hips move; the hips drop to keep it in reach." />
        <HbToggleRow v-model="opts.look" label="look at the green dot" description="neck and head share the turn, clamped to what a neck can do." />
        <HbButton variant="secondary" size="sm" :disabled="tool.body.placeholder" @click="tool.walk.value?.stage.showPlaceholder()">back to the mannequin</HbButton>
      </HbFold>

      <HbFold v-model="open.export" :num="2" summary="export" persist-key="ik-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="rig ? '' : 'the stage is starting.'" label="ik" @export="onExport" />
      </HbFold>

      <HbHow
        :packages="['@hackbuild/ik', '@hackbuild/avatar-host']"
        install="npm i @hackbuild/ik three"
        :code="HOW"
        persist-key="ik-how"
      />
    </template>
  </StageTool>
</template>
