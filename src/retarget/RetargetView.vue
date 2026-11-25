<script setup lang="ts">
// The retarget tool (design 3.11): put a bvh or vmd clip on your character.
// The shared stage toolbar holds the target body, the transport and the
// tune drawer; the source plays as a stick figure beside the body or over
// it (CALIPER's source and processed views side by side, P-CAM-3, on one
// stage); the transport plays and scrubs both (DOLLY, P-STAGE-13). The
// numbered rack holds the source with the motion findings, the target, the
// bone map with hand edits, the floor and scale fixes, and the export.
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbExportPanel, HbFold, HbHow, HbKv, HbSeg, HbSelect, HbTable, HbToggleRow,
  type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { isBodyFile } from '../stagekit/body'
import { claimDrops, exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import { CLIP_EXT } from '../avatar/pose.ts'
import { RETARGET_KIND, UNITS, retargetKind, type RetargetBody, type RetargetOpts } from './kind.ts'
import { BODY_BONES, BUILTIN, SOURCE_ACCEPT, isClipFile, type MapEdits } from './source.ts'
import type { MapRow, Result, Retargeter, Source } from './bind.ts'
import how from '@hackbuild/retarget/how'

if (!kinds.get(RETARGET_KIND)) registerKind(retargetKind)

const tool = useStageTool({
  id: 'retarget',
  empty: 'the built in walk on the mannequin. drop a bvh, vmd or hbm clip, or a glb or vrm body, anywhere.',
  duration: BUILTIN.seconds,
})

const doc = useDocument<RetargetBody>(RETARGET_KIND)
const fresh = retargetKind.create()
const edits = ref<MapEdits>({})
const opts = reactive<RetargetOpts>({ ...fresh.opts })
const layout = ref<'side' | 'overlay'>(fresh.layout)
const open = reactive({ source: true, target: true, map: true, fixes: true, export: true })

const rt = shallowRef<Retargeter | null>(null)
const source = shallowRef<Source | null>(null)
const result = shallowRef<Result | null>(null)
const rows = shallowRef<MapRow[]>([])
const target = reactive({ name: 'starting', line: '' })
const failure = ref('')
let mod: typeof import('./bind.ts') | null = null
let offLoaded: (() => void) | null = null

function save(fn: (d: RetargetBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

/** Runs the retarget with the edits and fixes as they stand, and fits the transport to it. */
function run() {
  const r = rt.value
  if (!r?.body) return
  try {
    result.value = r.apply(edits.value, { ...opts })
    failure.value = ''
    tool.transport.duration = Math.max(result.value.duration, 1 / 30)
    if (tool.transport.time > tool.transport.duration) tool.seek(0)
  } catch (e) {
    result.value = null
    const msg = e instanceof Error ? e.message : String(e)
    const miss = /missing humanoid bones: (.+)/.exec(msg)?.[1]
    failure.value = miss
      ? `${r.source.name} has no ${miss.toLowerCase()} the mapper can read. pick the joint by hand in the bone map.`
      : `${r.source.name} did not retarget. ${msg}`
    tool.body.line = failure.value
  }
  rows.value = r.rows(BODY_BONES, edits.value)
  tool.walk.value?.stage.loop.invalidate()
}

function useSource(s: Source, keepEdits = false) {
  const r = rt.value
  if (!r) return
  r.setSource(s)
  source.value = s
  if (!keepEdits) edits.value = {}
  run()
  tool.seek(0)
  save((d) => { d.source = s.kind === 'builtin' ? null : { name: s.name, kind: s.kind }; d.edits = { ...edits.value } })
}

async function takeSource(files: File[]) {
  const f = files[0]
  if (!f || !mod) return
  tool.body.line = `reading ${f.name}.`
  try {
    const s = await mod.readSource(f)
    useSource(s)
    tool.body.line = failure.value || `${f.name} on ${tool.body.name}. ${result.value?.notes[0] ?? ''}`.trim()
    logEvent('note', `retarget: ${f.name} as the source`)
  } catch (e) {
    tool.body.line = `${f.name} did not read. ${e instanceof Error ? e.message : String(e)}`
    logEvent('fail', `retarget: ${f.name} did not read`)
  }
}

function pickSource(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) void takeSource(files)
}

function builtin() {
  if (mod) useSource(mod.builtinSource())
}

function fit() {
  const s = tool.walk.value?.stage
  if (s) rt.value?.fit(s)
}

function adopt() {
  const r = rt.value
  const b = tool.walk.value?.stage.body
  if (!r || !b) return
  const t = r.setTarget(b)
  target.name = tool.body.placeholder ? 'mannequin' : b.name
  target.line = t.bonesLine
  run()
  fit()
}

// ------------------------------------------------------------- bone map

const sourceOptions = computed(() => [{ label: 'none', value: '' }, ...(source.value?.skeleton.names ?? []).map((n) => ({ label: n, value: n }))])
const handCount = computed(() => Object.keys(edits.value).length)
const mapLine = computed(() => {
  const all = rows.value
  const s = all.filter((r) => r.source).length
  const t = all.filter((r) => r.target).length
  return `${s} of ${BODY_BONES.length} body bones found on the source, ${t} on the target${handCount.value ? `, ${handCount.value} set by hand` : ''}.`
})

function remap(bone: string, joint: string) {
  const next = { ...edits.value }
  const was = rows.value.find((r) => r.bone === bone)?.source
  if (was && was !== joint) next[was] = ''
  if (joint) next[joint] = bone
  edits.value = next
  run()
  save((d) => { d.edits = { ...next } })
}

function resetMap() {
  edits.value = {}
  run()
  save((d) => { d.edits = {} })
}

watch([() => ({ ...opts }), layout], () => {
  if (rt.value) rt.value.layout = layout.value
  run()
  fit()
  save((d) => { d.opts = { ...opts }; d.layout = layout.value })
}, { deep: true })

const findingsLine = computed(() => {
  const f = result.value?.findings
  if (!f) return failure.value || 'the motion core is starting.'
  return `${f.tags.join(', ') || 'no tags'}; ${f.duration.toFixed(2)} s${f.looping ? ', loops' : ''}${f.pose ? ', a still pose' : ''}.`
})

// ------------------------------------------------------------- export

const name = computed(() => `${source.value?.name ?? 'clip'}-on-${tool.body.name}`.replace(/[^\w.-]+/g, '-'))
const formats: HbExportFormat[] = [
  { key: 'hbm', label: 'motion', ext: '.hbm', note: 'the retargeted motion by humanoid bone, the compact hbm1 form. it opens here again as a source.' },
  { key: 'clip', label: 'clip', ext: CLIP_EXT, note: 'every frame on this body\'s bones by human bone name. the avatar tool opens it.' },
  { key: 'glb', label: 'glb', ext: '.glb', note: 'the body with the clip as a glb animation. the body file goes in it: share it only if its licence allows.' },
  { key: 'doc', label: 'document', ext: retargetKind.ext, note: 'the bone map edits, the fixes and the layout. clip and body files are never in it.' },
]
const readout = computed<HbExportReadout[]>(() => {
  const r = result.value
  if (!r) return []
  return [
    { label: 'frames', value: `${r.frames} at ${r.fps} fps` },
    { label: 'bones', value: Object.keys(r.motion.rotations).length },
    { label: 'hips track', value: r.motion.hips ? 'yes' : 'none' },
    { label: 'floor shift', value: `${(r.shift * 1000).toFixed(0)} mm` },
  ]
})
const exportBusy = computed(() => (!result.value ? failure.value || 'the stage is starting.' : ''))

async function onExport(req: HbExportRequest) {
  const r = rt.value
  const fname = req.filename || name.value
  if (!r) return
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  if (req.format === 'hbm') {
    const b = r.hbm()
    if (b) saveFile(`${fname}.hbm`, new Blob([b as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }), 'application/octet-stream')
  } else if (req.format === 'clip') {
    const c = r.clipJson(source.value?.name ?? 'clip')
    if (c) saveFile(`${fname}${CLIP_EXT}`, JSON.stringify(c), 'application/json')
  } else if (req.format === 'glb') {
    tool.body.line = 'writing the glb.'
    const g = await r.glb()
    if (!g) return
    saveFile(`${fname}.glb`, new Blob([g], { type: 'model/gltf-binary' }), 'model/gltf-binary')
  }
  tool.body.line = `${fname} saved as ${req.format}.`
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === RETARGET_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('retarget')
  const d = doc.body.value
  if (d) {
    Object.assign(opts, d.opts)
    layout.value = d.layout
  }
  const m = await import('./bind.ts')
  await m.ready()
  mod = m
})

watch(
  () => tool.walk.value,
  async (w) => {
    if (!w) return
    while (!mod) await new Promise((r) => setTimeout(r, 20))
    const r = new mod.Retargeter(w.stage.scene, () => tool.transport.time, tone('--hb-info') || '#3b82f6')
    r.layout = layout.value
    rt.value = r
    offLoaded?.()
    offLoaded = w.stage.on('loaded', () => adopt())
    adopt()
    const d = doc.body.value
    useSource(mod.builtinSource())
    if (d?.edits && d.source === null) {
      edits.value = { ...d.edits }
      run()
    }
    if (d?.source) tool.body.line = `${d.source.name} was not kept: files stay in the tab they were dropped on. the built in walk stands in.`
  },
)

// a clip dropped anywhere goes to the source, a body to the stage
claimDrops({
  accept: (f) => isClipFile(f) || isBodyFile(f),
  take: (files) => {
    const clips = files.filter(isClipFile)
    if (clips.length) void takeSource(clips)
    else void tool.showBody(files)
  },
})

onBeforeUnmount(() => {
  claimDrops(null)
  offLoaded?.()
  rt.value?.dispose()
  rt.value = null
})

// for the smoke: the tool handle on the stage host, no global
watch(rt, (r) => {
  const el = tool.host.value as (HTMLElement & { retarget?: unknown }) | null
  if (el && r) el.retarget = { dir: (w: 'source' | 'target', b: string) => r.boneDir(w, b), result, edits }
})

</script>

<template>
  <StageTool :tool="tool" title="retarget">
    <template #rack>
      <HbFold v-model="open.source" :num="0" summary="source" persist-key="retarget-source">
        <HbKv label="clip" :value="source ? `${source.name}, ${source.kind}` : 'starting'" />
        <HbKv label="joints" :value="source?.skeleton.names.length ?? 0" />
        <HbKv label="frames" :value="result ? `${result.frames} at ${result.fps} fps, ${result.duration.toFixed(2)} s` : 'none'" />
        <HbKv label="findings" :value="findingsLine" />
        <p v-for="n in result?.notes ?? []" :key="n" class="hb-hint">{{ n }}</p>
        <div class="hb-row">
          <HbButton as="label" variant="secondary" size="sm">
            open a clip
            <input type="file" :accept="SOURCE_ACCEPT" hidden data-import="source" @change="pickSource">
          </HbButton>
          <HbButton variant="secondary" size="sm" :disabled="source?.kind === 'builtin'" @click="builtin">built in walk</HbButton>
        </div>
        <p class="hb-hint">bvh, vmd, a glb that carries an animation (an fbx turned to glb works), or an hbm motion. the source draws as lines.</p>
      </HbFold>

      <HbFold v-model="open.target" :num="1" summary="target" persist-key="retarget-target">
        <HbKv label="body" :value="target.name" />
        <p class="hb-hint">{{ target.line }}</p>
        <HbButton variant="secondary" size="sm" :disabled="tool.body.placeholder" @click="tool.walk.value?.stage.showPlaceholder()">back to the mannequin</HbButton>
      </HbFold>

      <HbFold v-model="open.map" :num="2" summary="bone map" persist-key="retarget-map">
        <div class="hb-instrument" data-pane="map">
          <p class="hb-hint">{{ mapLine }}</p>
          <HbTable :columns="[{ key: 'bone', label: 'bone' }, { key: 'source', label: 'source joint' }, { key: 'target', label: 'target' }]" :rows="rows as unknown as Record<string, unknown>[]">
            <template #cell-bone="{ row }"><span :data-bone="row.bone">{{ row.bone }}{{ row.edited ? ' *' : '' }}</span></template>
            <template #cell-source="{ row }">
              <HbSelect
                :model-value="(row.source as string | null) ?? ''"
                :options="sourceOptions"
                :aria-label="`source joint for ${row.bone}`"
                @update:model-value="(v) => remap(row.bone as string, String(v))"
              />
            </template>
            <template #cell-target="{ row }">{{ row.target ?? 'none' }}</template>
          </HbTable>
          <HbButton variant="secondary" size="sm" :disabled="!handCount" @click="resetMap">back to the auto map</HbButton>
        </div>
      </HbFold>

      <HbFold v-model="open.fixes" :num="3" summary="floor and scale" persist-key="retarget-fixes">
        <HbToggleRow v-model="opts.settle" label="settle on the floor" :description="result ? `the lowest foot touches the floor; moved ${(result.shift * 1000).toFixed(0)} mm.` : 'the lowest foot touches the floor.'" />
        <HbToggleRow v-model="opts.origin" label="start at the origin" description="the hips travel starts where the body stands." />
        <HbToggleRow v-model="opts.inPlace" label="in place" description="keep the bounce, drop the travel across the floor." />
        <HbSelect v-model="opts.units" label="source units" :options="UNITS.map((u) => ({ label: u === 'auto' ? 'auto, from the rig' : u, value: u }))" />
        <p class="hb-hint">travel scales by hip height, so a short body takes short steps. units: {{ result ? `${result.srcUnit} m each` : 'unknown' }}.</p>
        <HbSeg v-model="layout" :options="[{ label: 'side by side', value: 'side' }, { label: 'overlaid', value: 'overlay' }]" toggle />
      </HbFold>

      <HbFold v-model="open.export" :num="4" summary="export" persist-key="retarget-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="exportBusy" label="retarget" @export="onExport" />
      </HbFold>

      <HbHow v-bind="how" persist-key="retarget-how" />
    </template>
  </StageTool>
</template>
