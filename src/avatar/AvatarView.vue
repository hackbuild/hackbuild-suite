<script setup lang="ts">
// The avatar tool (design 3.11): load any character file and inspect it.
// The shared stage toolbar holds the body, the seed, the transport and the
// tune drawer; the numbered rack (live2d-bench, P-STAGE-14, with the VRM
// console's drop) fills from the model: source and licence, what the body
// can do, the rig tree, blendshapes, expressions and gaze, clips the
// transport plays and scrubs, the scene, the wardrobe, and pose and clip
// files out and back in. Image light for a scene is fetched only from a
// press that names where it comes from.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbChipGroup, HbExportPanel, HbFold, HbHow, HbInput, HbKv, HbParamRow, HbSeg, HbToggleRow, HbTree,
  type HbTreeNode,
  type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { PRESETS, studio, type EnvironmentPreset } from '@hackbuild/environment'
import type { Body } from '@hackbuild/avatar-host/three'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { SPEED } from '../stage/walk'
import { exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { AVATAR_KIND, POSES_CAP, avatarKind, type AvatarBody, type GazeModeName } from './kind.ts'
import { CLIP_EXT, POSE_EXT, clipFile, clipSeconds, poseClip, poseFile, readClip, readPose, type ClipData } from './pose.ts'
import type { Driver, Inspection } from './inspect.ts'
import how from '@hackbuild/avatar-host/how'

if (!kinds.get(AVATAR_KIND)) registerKind(avatarKind)

const IDLE_SECONDS = 10

const tool = useStageTool({
  id: 'avatar',
  empty: 'this is the built in rig. drop a glb, vrm, pmx or pmd anywhere to use your own.',
  duration: IDLE_SECONDS,
  tunables(reg) {
    reg.define({ key: 'walk.speed', group: 'walk', label: 'speed', def: SPEED, min: 0.2, max: 3, step: 0.1, unit: 'm/s', note: 'walking speed at full stick.', source: 'inferred' })
    reg.define({ key: 'start.spread', group: 'start', label: 'spread', def: 0.5, min: 0, max: 4, step: 0.1, unit: 'm', note: 'how far from the spot the seed may start the body.', source: 'inferred' })
  },
  restart(rng, _seed, { walk, reg }) {
    const r = reg.get('start.spread') * Math.sqrt(rng())
    const a = rng() * Math.PI * 2
    walk.place(r * Math.cos(a), r * Math.sin(a), (rng() - 0.5) * Math.PI)
  },
})

const doc = useDocument<AvatarBody>(AVATAR_KIND)
const saved = computed(() => doc.body.value)

// ------------------------------------------------------------- the body

const body = shallowRef<Body | null>(null)
const info = shallowRef<Inspection | null>(null)
// every branch starts open, as the flat list was; the tree scrolls in its cap
const treeOpen = ref<string[]>([])
const openIds = (ns: HbTreeNode[]): string[] => ns.flatMap((n) => (n.children ? [n.id, ...openIds(n.children)] : []))
const extra = shallowRef<ClipData[]>([])
const clip = ref<string | null>(null)
const morphs = reactive<Record<string, number>>({})
const filter = ref('')
const expression = ref<string | null>(null)
const gaze = ref(true)
const mode = ref<GazeModeName>('listen')
const parts = reactive<Record<string, boolean>>({})
const open = reactive({ source: true, model: true, rig: true, shapes: true, face: true, clips: true, scene: false, wardrobe: false, export: true })
let driver: Driver | null = null
let mod: typeof import('./inspect.ts') | null = null
let offLoaded: (() => void) | null = null

const clips = computed<ClipData[]>(() => (info.value ? [...info.value.builtin, ...info.value.fileClips, ...extra.value] : []))
const current = computed(() => clips.value.find((c) => c.name === clip.value) ?? null)

function adopt(b: Body) {
  driver?.dispose()
  if (!mod) return
  body.value = b
  info.value = mod.inspect(b)
  treeOpen.value = openIds(info.value.tree)
  driver = mod.drive(b, () => tool.transport.time)
  extra.value = []
  for (const k of Object.keys(morphs)) delete morphs[k]
  for (const k of Object.keys(parts)) delete parts[k]
  for (const p of info.value.parts) parts[p.id] = p.visible
  // what the document holds goes back on where this body has it
  const d = saved.value
  if (d) {
    for (const [k, w] of Object.entries(d.morphs)) if (info.value.morphs.includes(k)) setMorph(k, w)
    gaze.value = d.gaze
    mode.value = d.mode
    expression.value = d.expression && info.value.expressions.includes(d.expression) ? d.expression : null
  }
  applyFace()
  pick(d?.clip && clips.value.some((c) => c.name === d.clip) ? d.clip : null)
}

function applyFace() {
  const b = body.value
  if (!b) return
  b.gazeOn = gaze.value && b.caps.gaze
  b.setGazeMode(mode.value)
  b.setExpression(expression.value)
  tool.walk.value?.stage.loop.invalidate()
}

function pick(name: string | null) {
  clip.value = name
  const c = current.value
  driver?.setClip(c)
  tool.transport.duration = c ? Math.max(clipSeconds(c), 1 / c.fps) : IDLE_SECONDS
  tool.seek(0)
}

function setMorph(name: string, w: number) {
  morphs[name] = w
  driver?.morphs.set(name, w)
  tool.walk.value?.stage.loop.invalidate()
}

function resetMorphs() {
  for (const k of Object.keys(morphs)) delete morphs[k]
  driver?.morphs.clear()
  // hand the faces back to the face driver at zero
  body.value?.avatar.root.traverse((o) => {
    const m = o as { morphTargetInfluences?: number[] }
    if (m.morphTargetInfluences) m.morphTargetInfluences.fill(0)
  })
  save((d) => { d.morphs = {} })
  tool.walk.value?.stage.loop.invalidate()
}

const shownMorphs = computed(() => {
  const f = filter.value.trim().toLowerCase()
  const all = info.value?.morphs ?? []
  return f ? all.filter((m) => m.toLowerCase().includes(f)) : all
})

function save(fn: (d: AvatarBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

watch([gaze, mode, expression], () => {
  applyFace()
  save((d) => { d.gaze = gaze.value; d.mode = mode.value; d.expression = expression.value })
})
watch(clip, (c) => save((d) => { d.clip = c }))

function wear(id: string, on: boolean) {
  parts[id] = on
  body.value?.setPartVisible(id, on)
  tool.walk.value?.stage.loop.invalidate()
}

function placeholder() {
  tool.walk.value?.stage.showPlaceholder()
}

const caps = computed(() => {
  const b = body.value
  const i = info.value
  if (!b || !i) return []
  const c = b.caps
  return [
    { label: 'format', value: `${i.format}, ${i.dialect} rig` },
    { label: 'bones', value: `${i.mapped} human, ${i.nodes} nodes` },
    { label: 'blendshapes', value: i.morphs.length },
    { label: 'expressions', value: c.expressions.length },
    { label: 'clips', value: `${i.fileClips.length} in the file, ${i.builtin.length} built in` },
    { label: 'parts', value: c.parts },
    { label: 'mouth', value: c.mouth ? 'lip sync shapes found' : 'no mouth shapes' },
    { label: 'blink', value: c.blink ? 'yes' : 'no blink shape' },
    { label: 'gaze', value: c.gaze ? 'head and eyes turn' : 'off: the head does not rest upright' },
  ]
})

// ------------------------------------------------------------- scenes

interface Scene {
  id: string
  label: string
  /** An image light preset: kit models left out, the studio floor kept. */
  preset?: EnvironmentPreset
}
const LIGHT_NAMES: Record<string, string> = { room: 'room light', cafe: 'cafe light', outdoors: 'sky' }
const SCENES: Scene[] = [
  { id: 'plain', label: 'plain' },
  { id: 'studio', label: 'studio' },
  ...PRESETS.filter((p) => p.hdri).map((p) => {
    const id = `${p.id}-light`
    const label = LIGHT_NAMES[p.id] ?? p.id
    return { id, label, preset: { ...p, id, label, layout: { ...p.layout, items: [], ground: p.layout.ground ?? studio.ground }, kitLicence: null } }
  }),
]
const scene = ref('studio')
const asked = ref<string | null>(null)
const sceneBusy = ref(false)
const askedScene = computed(() => SCENES.find((s) => s.id === asked.value) ?? null)

/** Where an image light file comes from: Poly Haven's download host (vendor). */
function hdriUrl(file: string): string {
  const base = file.replace(/^hdri\//, '')
  const res = /_(\d+k)\.hdr$/.exec(base)?.[1] ?? '1k'
  return `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${res}/${base}`
}

async function chooseScene(s: Scene) {
  const stage = tool.walk.value?.stage
  if (!stage) return
  if (s.preset) {
    asked.value = s.id
    return
  }
  asked.value = null
  await stage.showEnvironment(s.id === 'plain' ? null : s.id)
  scene.value = s.id
  save((d) => { d.scene = s.id })
}

async function fetchLight() {
  const s = askedScene.value
  const stage = tool.walk.value?.stage
  if (!s?.preset || !stage) return
  sceneBusy.value = true
  tool.body.line = `fetching the ${s.label} image from poly haven.`
  try {
    const { start, weights } = await import('../models/hub')
    await start()
    const store = weights()
    const ok = await stage.showEnvironment({ preset: s.preset, resolve: (file) => store.get({ url: hdriUrl(file), key: `hdri:${file}`, licence: 'CC0' }) })
    if (ok) {
      scene.value = s.id
      asked.value = null
      tool.body.line = `${s.label} on the stage. the image is kept in this browser for next time.`
      save((d) => { d.scene = s.id })
      logEvent('note', `avatar: ${s.label} image light`)
    }
  } catch (e) {
    tool.body.line = `the ${s.label} image did not load. ${e instanceof Error ? e.message : String(e)}`
  } finally {
    sceneBusy.value = false
  }
}

// ------------------------------------------------------------- files

const name = computed(() => (body.value?.name ?? 'body').replace(/[^\w.-]+/g, '-') || 'body')

function currentPose() {
  const b = body.value
  if (!b || !driver) return null
  return poseFile(current.value?.name ?? 'rest', b.names, driver.pose(), { ...morphs }, expression.value)
}

const formats: HbExportFormat[] = [
  { key: 'pose', label: 'pose', ext: POSE_EXT, note: 'the bones as drawn now, the blendshapes you hold and the expression.', copy: true },
  { key: 'clip', label: 'clip', ext: CLIP_EXT, note: 'the chosen clip, every frame, by human bone name.' },
  { key: 'doc', label: 'document', ext: avatarKind.ext, note: 'what this inspector is set to and the saved poses. the body file is never in it.' },
  { key: 'png', label: 'still', ext: '.png', note: 'one frame of the stage as an image.' },
]
const readout = computed<HbExportReadout[]>(() => {
  const i = info.value
  if (!i) return []
  return [
    { label: 'bones', value: i.names.length },
    { label: 'clip', value: current.value ? `${current.value.name}, ${current.value.frames} frames at ${current.value.fps} fps` : 'none chosen' },
    { label: 'held shapes', value: Object.keys(morphs).length },
    { label: 'saved poses', value: saved.value?.poses.length ?? 0 },
  ]
})
const exportBusy = computed(() => (!body.value ? 'the stage is starting.' : ''))

async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  if (req.format === 'png') {
    const blob = await tool.walk.value?.stage.snapshot()
    if (!blob) return void (tool.body.line = 'the stage gave no image. try again once it draws.')
    saveFile(`${fname}.png`, blob, 'image/png')
    return
  }
  if (req.format === 'clip') {
    const c = current.value
    if (!c || !body.value) return void (tool.body.line = 'choose a clip first. the rest stance is not a clip.')
    saveFile(`${fname}-${c.name.replace(/\s+/g, '-')}${CLIP_EXT}`, JSON.stringify(clipFile(c, body.value.names)), 'application/json')
    tool.body.line = `${c.name} saved as a clip file.`
    return
  }
  const p = currentPose()
  if (!p) return
  saveFile(`${fname}${POSE_EXT}`, JSON.stringify(p, null, 2), 'application/json')
  save((d) => { d.poses = [...d.poses, p].slice(-POSES_CAP) })
  tool.body.line = `pose saved, ${Object.keys(p.bones).length} bones.`
}

async function onCopy() {
  const p = currentPose()
  if (p) await navigator.clipboard?.writeText(JSON.stringify(p, null, 2)).catch(() => undefined)
}

async function copyMorphs() {
  await navigator.clipboard?.writeText(JSON.stringify(morphs, null, 2)).catch(() => undefined)
  tool.body.line = `${Object.keys(morphs).length} held blendshapes copied as json.`
}

async function importFile(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  const b = body.value
  const i = info.value
  if (!f || !b || !i) return
  try {
    const raw = JSON.parse(await f.text()) as { format?: string }
    if (raw.format === 'hackbuild.pose') {
      const p = readPose(raw)
      const { clip: c, matched } = poseClip(p, b.names, i.rest)
      extra.value = [...extra.value.filter((x) => x.name !== c.name), c]
      // the chip exists before it is lit
      await nextTick()
      for (const [k, w] of Object.entries(p.morphs)) if (i.morphs.includes(k)) setMorph(k, w)
      if (p.expression && i.expressions.includes(p.expression)) expression.value = p.expression
      pick(c.name)
      tool.pause()
      tool.body.line = `${f.name}: ${matched} of ${b.names.length} bones matched by name.`
    } else {
      const { clip: c, matched } = readClip(raw, b.names, i.rest)
      extra.value = [...extra.value.filter((x) => x.name !== c.name), c]
      await nextTick()
      pick(c.name)
      tool.body.line = `${f.name}: ${matched} of ${b.names.length} bones matched by name. press play.`
    }
  } catch (err) {
    tool.body.line = `${f.name} did not read. ${err instanceof Error ? err.message : String(err)}`
  }
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === AVATAR_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('avatar')
  mod = await import('./inspect.ts')
})

watch(
  () => tool.walk.value,
  async (w) => {
    if (!w) return
    while (!mod) await new Promise((r) => setTimeout(r, 20))
    offLoaded?.()
    offLoaded = w.stage.on('loaded', (e) => adopt(e.body))
    if (w.stage.body) adopt(w.stage.body)
    const s = saved.value?.scene
    // built in scenes only come back by themselves; image light waits for a press
    if (s === 'plain') await chooseScene(SCENES[0]!)
    else scene.value = 'studio'
  },
)

onBeforeUnmount(() => {
  offLoaded?.()
  driver?.dispose()
  driver = null
})

</script>

<template>
  <StageTool :tool="tool" title="avatar">
    <template #rack>
      <HbFold v-model="open.source" :num="0" summary="source" persist-key="avatar-source">
        <HbKv label="body" :value="body?.name ?? 'starting'" />
        <HbKv v-if="tool.body.local" label="kept" value="local only, on this device. never stored or exported." />
        <p class="hb-hint">{{ info?.licence ?? 'the stage is starting.' }}</p>
        <p v-for="w in info?.warnings ?? []" :key="w" class="hb-hint">{{ w }}</p>
        <HbButton variant="secondary" size="sm" :disabled="!body || tool.body.placeholder" @click="placeholder">back to the mannequin</HbButton>
      </HbFold>

      <HbFold v-model="open.model" :num="1" summary="model" persist-key="avatar-model">
        <HbKv v-for="c in caps" :key="c.label" :label="c.label" :value="c.value" />
      </HbFold>

      <HbFold v-model="open.rig" :num="2" summary="rig" persist-key="avatar-rig">
        <div class="hb-instrument" data-pane="rig">
          <p class="hb-hint">{{ info?.bonesLine }}</p>
          <HbTree v-model:expanded="treeOpen" :nodes="info?.tree ?? []" label="rig" />
        </div>
      </HbFold>

      <HbFold v-model="open.shapes" :num="3" summary="blendshapes" persist-key="avatar-shapes">
        <div class="hb-instrument" data-pane="shapes">
          <template v-if="info?.morphs.length">
            <HbInput v-model="filter" placeholder="filter blendshapes" aria-label="filter blendshapes" />
            <div class="hb-row">
              <HbButton variant="secondary" size="sm" :disabled="!Object.keys(morphs).length" @click="resetMorphs">reset</HbButton>
              <HbButton variant="secondary" size="sm" :disabled="!Object.keys(morphs).length" @click="copyMorphs">copy json</HbButton>
            </div>
            <HbParamRow
              v-for="m in shownMorphs"
              :key="m"
              :model-value="morphs[m] ?? 0"
              :label="m"
              :min="0"
              :max="1"
              :step="0.01"
              :default-value="0"
              @update:model-value="(v) => setMorph(m, Number(v))"
              @commit="(v) => save((d) => { d.morphs = { ...d.morphs, [m]: Number(v) } })"
            />
            <p v-if="!shownMorphs.length" class="hb-hint">no blendshape matches {{ filter }}.</p>
          </template>
          <p v-else class="hb-hint">this body has no blendshapes. expressions and lip sync need them.</p>
        </div>
      </HbFold>

      <HbFold v-model="open.face" :num="4" summary="face and gaze" persist-key="avatar-face">
        <HbChipGroup
          v-if="info?.expressions.length"
          :options="info.expressions"
          :model-value="expression ?? ''"
          off="neutral"
          label="expressions"
          toggle
          @update:model-value="(v) => (expression = (v as string) || null)"
        />
        <p v-else class="hb-hint">no expressions in this body. the face stays as it is.</p>
        <HbToggleRow v-model="gaze" label="gaze" :disabled="!body?.caps.gaze" :description="body?.caps.gaze ? 'head and eyes follow the pointer, then you.' : 'off: this head does not rest upright and facing forward.'" />
        <HbSeg v-model="mode" :options="['listen', 'talk', 'think']" toggle />
      </HbFold>

      <HbFold v-model="open.clips" :num="5" summary="clips" persist-key="avatar-clips">
        <HbChipGroup
          :options="clips.map((c) => c.name)"
          :model-value="clip ?? ''"
          off="rest"
          label="clips"
          toggle
          @update:model-value="(v) => pick((v as string) || null)"
        />
        <p class="hb-hint">{{ current ? `${current.name}: ${clipSeconds(current).toFixed(2)} s, ${current.frames} frames. the transport plays and scrubs it.` : 'the rest stance breathes on its own. pick a clip to play and scrub it.' }}</p>
        <HbButton as="label" variant="secondary" size="sm">
          open a pose or clip file
          <input type="file" accept=".json,application/json" hidden data-import="pose-clip" @change="importFile">
        </HbButton>
      </HbFold>

      <HbFold v-model="open.scene" :num="6" summary="scene and light" persist-key="avatar-scene">
        <HbChipGroup
          :options="SCENES.map((x) => ({ label: x.label, value: x.id }))"
          :model-value="asked ?? scene"
          label="scene"
          toggle
          @update:model-value="(v) => chooseScene(SCENES.find((x) => x.id === v)!)"
        />
        <template v-if="askedScene?.preset?.hdri">
          <p class="hb-hint">{{ askedScene.label }} lights the body from a photo of a real place: {{ askedScene.preset.hdri.file.replace('hdri/', '') }}, {{ askedScene.preset.hdri.licence }}, from {{ askedScene.preset.hdri.source }}. the size is unknown until the server answers. it is kept in this browser.</p>
          <HbButton size="sm" :loading="sceneBusy" @click="fetchLight">fetch {{ askedScene.label }}</HbButton>
        </template>
        <p v-else class="hb-hint">plain and studio are made in code and fetch nothing.</p>
      </HbFold>

      <HbFold v-model="open.wardrobe" :num="7" summary="wardrobe" persist-key="avatar-wardrobe">
        <HbToggleRow v-for="p in info?.parts ?? []" :key="p.id" :model-value="parts[p.id]" :label="p.name || p.id" @update:model-value="(v) => wear(p.id, v)" />
        <p v-if="!info?.parts.length" class="hb-hint">no separate parts in this body.</p>
      </HbFold>

      <HbFold v-model="open.export" :num="8" summary="export" persist-key="avatar-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="exportBusy" label="avatar" @export="onExport" @copy="onCopy" />
      </HbFold>

      <HbHow v-bind="how" persist-key="avatar-how" />
    </template>
  </StageTool>
</template>
