<script setup lang="ts">
// The relief tool (design 3.5, flow F-4 up to the export step; the print
// reality sliders and the multi colour 3MF stay in the print bench). A
// photo comes in through the slot or a drop and depth runs on it with no
// second click once the model is in; the depth map is stored in the
// document so it never reruns (P-DEPTH-1). Height from depth, brightness
// or an inflated silhouette (P-DEPTH-3); the bench's rows preview on input
// and commit on release (P-DEPTH-4); the erase and restore brush paints
// on the shaded relief (P-DEPTH-5); the photo and its depth compare under
// a wipe; the export block carries a readout and checks (P-DEPTH-11).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbArtboard, HbButton, HbChipGroup, HbExportPanel, HbHow, HbImageSlot, HbMethodCard, HbPanel, HbParamRow, HbRange2, HbSlider, HbSplit,
  HbStatusLine, HbTag, HbToolbar, HbViewport,
  type ArtLayer, type ArtStroke, type ArtTool, type HbExportCheck, type HbExportFormat, type HbExportReadout, type HbExportRequest,
  type HbImageValue, type HbParamValue,
} from '@virgilvox/hackbuild-ui'
import { applyStroke, saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import {
  bounds, HEIGHT_SOURCES, openEdges, photoRelief, toObj, toPly, toStl, volume,
  type DepthGrid, type DepthMesh, type HeightSourceName, type PhotoRelief, type ReliefParams,
} from '@hackbuild/depth-mesh'
import { depth, depthToRgba, maskFromRle, maskToRle, type Mask } from '@hackbuild/vision'
import type { ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent } from '../shell/shell.ts'
import { core } from '../cores.ts'
import { exportDoc, pickFiles, useDocument, ws } from '../workspace/state'
import { readFrame, tone } from '../vision/frame.ts'
import { addVisionRuntimes, drawScene } from '../vision/runtimes.ts'
import { strokeInto } from '../masks/kind.ts'
import { clampParams, newBody, RELIEF_KIND, withImage, type ReliefBody } from './kind.ts'
import { provideDepthMesh, registerRelief } from './register.ts'
import type { ReliefPreview } from './preview3d.ts'
import SendTo from '../shell/SendTo.vue'
import type { SendOffer } from '../workspace/sendto'
import how from '@hackbuild/depth-mesh/how'

registerRelief()
provideDepthMesh()

const route = useRoute()
const doc = useDocument<ReliefBody>(RELIEF_KIND)
const body = computed<ReliefBody>(() => doc.doc.value?.body ?? newBody())
const W = computed(() => body.value.width || 1)
// Send to (design 1.2): the photo as an image, the depth map as depth.
const offers = computed<SendOffer[]>(() => {
  const b = body.value
  const frame = b.image ? { image: b.image, width: b.width, height: b.height } : null
  return [
    { type: 'image', what: 'photo', ready: !!frame, get: () => (frame ? { type: 'image', name: b.name, frame } : null) },
    { type: 'depth', what: 'depth', ready: !!frame && !!b.depth, get: () => (frame && b.depth ? { type: 'depth', name: `${b.name} depth`, frame, depth: b.depth, model: b.depthModel } : null) },
  ]
})
const H = computed(() => body.value.height || 1)

const EMPTY = 'drop a photo and it becomes a relief. or take the sample scene.'
const status = ref<{ text: string; kind: 'none' | 'ok' | 'warn' | 'err' | 'info' | 'busy' }>({ text: EMPTY, kind: 'info' })
const say = (text: string, kind: typeof status.value.kind = 'info') => { status.value = { text, kind } }

// The depth model: one record routed on the hub, loaded from a button that names its size.
const booted = ref(false)
const record = computed<ModelRecord | null>(() => {
  void hub.allRecords.value
  if (!booted.value) return null
  const env = hub.env.value
  return hub.registry.route({ provides: 'depth', ...(env ? { env } : {}) }) ?? null
})
const modelState = computed(() => (record.value ? hub.states.value[record.value.id]?.state ?? 'none' : 'none'))
const ready = computed(() => modelState.value === 'loaded' || modelState.value === 'stored')
const sizeWord = (r: ModelRecord) => (r.sizeMB === null ? 'size unknown' : `${Math.round(r.sizeMB)} mb (${r.sizeSource})`)
const loadLabel = computed(() => (record.value ? (modelState.value === 'downloading' ? 'loading the depth model' : `load the depth model, ${sizeWord(record.value)}`) : ''))
const depthBusy = ref(false)

async function loadModel(): Promise<void> {
  const r = record.value
  if (!r) return say('no depth model runs here. brightness and inflate still work.', 'err')
  say(`loading ${r.label}, ${sizeWord(r)}. brightness works now if you would sooner not wait.`, 'busy')
  await hub.load(r.id)
  if (modelState.value === 'fault') return say('depth failed: the model did not load. height from brightness and inflate still work.', 'err')
  if (body.value.image) await runDepth()
  else say('the depth model is ready. drop a photo.', 'ok')
}

// Pixels: the photo and the stored depth map, decoded once per url.
async function decode(url: string, w: number, h: number): Promise<ImageData> {
  const img = new Image()
  img.src = url
  await img.decode()
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.drawImage(img, 0, 0, w, h)
  return x.getImageData(0, 0, w, h)
}
const memo = new Map<string, Promise<unknown>>()
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  let p = memo.get(key) as Promise<T> | undefined
  if (!p) {
    if (memo.size > 6) memo.clear()
    p = make()
    memo.set(key, p)
  }
  return p
}
const photoPixels = () => once(`p:${body.value.image}`, () => decode(body.value.image!, W.value, H.value))
const depthGrid = (url: string): Promise<DepthGrid> => once(`d:${url}`, async () => {
  const d = await decode(url, W.value, H.value)
  return { width: d.width, height: d.height, data: Float32Array.from({ length: d.width * d.height }, (_, i) => d.data[i * 4]! / 255) }
})
function toPngUrl(w: number, h: number, data: Uint8ClampedArray): string {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0)
  return c.toDataURL('image/png')
}

/** Depth on the photo; the map lands in the document as a grey png (P-DEPTH-1). */
async function runDepth(): Promise<void> {
  const r = record.value
  if (!body.value.image) return say(EMPTY, 'warn')
  if (!r) return say('no depth model runs here. brightness and inflate still work.', 'err')
  if (!ready.value) return say(`depth needs ${r.label}, ${sizeWord(r)}, once. load it, or use brightness.`, 'warn')
  depthBusy.value = true
  say(`depth runs on ${body.value.name}.`, 'busy')
  const t0 = performance.now()
  try {
    const p = await photoPixels()
    const c = document.createElement('canvas')
    c.width = p.width
    c.height = p.height
    c.getContext('2d')!.putImageData(p, 0, 0)
    const m = await depth(hub.hub(), c, { model: r.id })
    const url = toPngUrl(m.width, m.height, depthToRgba(m))
    doc.edit((b) => { b.depth = url; b.depthModel = r.id; b.source = 'depth' })
    say(`depth took ${Math.round(performance.now() - t0)} ms (measured). the map is stored with the design.`, 'ok')
  } catch (err) {
    logEvent('fail', `relief: depth: ${err instanceof Error ? err.message : String(err)}`)
    say('depth failed: the model did not run. height from brightness and inflate still work.', 'err')
  } finally {
    depthBusy.value = false
  }
}

// Height source cards (P-DEPTH-3): the model beside two that need none.
const sources = computed(() => HEIGHT_SOURCES.map((s) => {
  const r = record.value
  const model = s.needsModel
  return {
    name: s.name,
    label: s.label,
    trade: model ? (body.value.depth ? 'depth map stored with the design' : 'estimated from the photo by a model') : s.name === 'brightness' ? 'light is high, no model' : 'domes the outline, no model',
    sizeMB: model ? (body.value.depth ? 0 : r?.sizeMB ?? null) : 0,
    state: (model && !body.value.depth ? (modelState.value === 'downloading' ? 'loading' : modelState.value === 'fault' ? 'failed' : ready.value ? 'stored' : 'download') : 'ready') as 'ready' | 'stored' | 'download' | 'loading' | 'failed',
    time: model ? '' : 'instant',
  }
}))
function pickSource(name: HeightSourceName): void {
  if (name === body.value.source) return
  doc.edit((b) => { b.source = name })
  if (name === 'depth' && !body.value.depth) void runDepth()
}

// The bench's rows: a draft previews on input, a commit is one undo step (P-DEPTH-4).
const draft = ref<ReliefParams>({ ...newBody().params })
watch(() => body.value.params, (p) => { draft.value = { ...p } }, { immediate: true, deep: true })
const setDraft = (k: keyof ReliefParams, v: HbParamValue) => { draft.value = { ...draft.value, [k]: typeof v === 'string' ? Number(v) : v } }
function commit(): void {
  const p = clampParams(draft.value)
  doc.edit((b) => { b.params = p })
}
const fmtMm = (v: number) => `${v.toFixed(2)} mm`
const rows = computed(() => {
  const inflate = body.value.source === 'inflate'
  return [
    { k: 'width', label: 'width', min: 6, max: 100, step: 0.5, unit: 'mm' },
    inflate ? { k: 'threshold', label: 'threshold', min: 0.05, max: 0.95, step: 0.05, unit: '' } : { k: 'bgcut', label: 'background cut', min: 0, max: 0.9, step: 0.01, unit: '' },
    { k: 'gamma', label: 'gamma', min: 0.3, max: 3, step: 0.05, unit: '' },
    { k: 'smooth', label: 'smoothing', min: 0, max: 2, step: 0.05, unit: 'mm' },
  ] as { k: keyof ReliefParams; label: string; min: number; max: number; step: number; unit: string }[]
})
const DEFAULTS = newBody().params

// The relief, rebuilt from the draft on the depth-mesh core.
const result = shallowRef<PhotoRelief | null>(null)
const building = ref(false)
let seq = 0
let timer: ReturnType<typeof setTimeout> | undefined
async function build(): Promise<void> {
  clearTimeout(timer)
  const b = body.value
  if (!b.image) { result.value = null; return }
  const n = ++seq
  building.value = true
  try {
    const [dm, img, dg] = await Promise.all([core<DepthMesh>('depth-mesh'), photoPixels(), b.depth ? depthGrid(b.depth) : Promise.resolve(undefined)])
    const r = await photoRelief(dm, img, {
      ...clampParams(draft.value), source: b.source, keepLargest: b.keepLargest,
      ...(dg ? { depth: dg } : {}), ...(b.keep ? { mask: maskFromRle(b.keep) } : {}),
    })
    if (n !== seq) return
    result.value = r
    preview?.set(r.mesh)
  } catch (err) {
    if (n === seq) say(`the relief did not build: ${err instanceof Error ? err.message : String(err)}`, 'err')
  } finally {
    if (n === seq) building.value = false
  }
}
const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void build(), 120) }
watch([draft, () => body.value.source, () => body.value.depth, () => body.value.image, () => body.value.keep, () => body.value.keepLargest], schedule, { deep: true })

// The shaded relief: the face the brush paints on, erased cells in red (P-DEPTH-5, P-DEPTH-9).
const shadeUrl = computed(() => {
  const r = result.value
  if (!r) return ''
  const { cols, rows: rws, heights, px } = r
  const keep = body.value.keep ? maskFromRle(body.value.keep) : null
  const top = heights.reduce((a, h) => Math.max(a, h), 0) || 1
  const d = new Uint8ClampedArray(cols * rws * 4)
  for (let j = 0; j < rws; j++)
    for (let i = 0; i < cols; i++) {
      const p = j * cols + i
      const h = heights[p]!
      const dx = (heights[j * cols + Math.min(cols - 1, i + 1)]! - heights[j * cols + Math.max(0, i - 1)]!) / (2 * px)
      const dy = (heights[Math.min(rws - 1, j + 1) * cols + i]! - heights[Math.max(0, j - 1) * cols + i]!) / (2 * px)
      const lit = Math.max(0, Math.min(1, 0.55 + (-dx - dy) * 0.35 + (h / top) * 0.25))
      let v = h > 0 ? 40 + lit * 200 : 16
      let red = v
      if (keep && !keep.data[Math.min(keep.height - 1, Math.floor(((j + 0.5) / rws) * keep.height)) * keep.width + Math.min(keep.width - 1, Math.floor(((i + 0.5) / cols) * keep.width))]) { red = 200; v = v * 0.4 }
      d[p * 4] = red
      d[p * 4 + 1] = d[p * 4 + 2] = v
      d[p * 4 + 3] = 255
    }
  return toPngUrl(cols, rws, d)
})

// The view: the 3D part or the shaded face with the brush.
const view = ref<'3d' | 'face'>('3d')
const viewChip = computed({ get: () => view.value as string, set: (v: string) => { view.value = v as '3d' | 'face' } })
const VIEWS = [{ label: '3d', value: '3d', key: '3' }, { label: 'face', value: 'face', key: 'f' }]
const tool = ref<ArtTool>('move')
const TOOLS = [{ label: 'look', value: 'move', key: 'v' }, { label: 'erase', value: 'erase', key: 'e' }, { label: 'restore', value: 'restore', key: 'r' }]
const toolChip = computed({ get: () => tool.value as string, set: (v: string) => { tool.value = v as ArtTool; if (v !== 'move') view.value = 'face' } })
const brush = ref(28)
const layers = computed<ArtLayer[]>(() => (shadeUrl.value ? [{
  id: 'relief', kind: 'image', w: W.value, h: H.value, locked: true, label: 'relief', src: shadeUrl.value, transform: { x: W.value / 2, y: H.value / 2, scale: 1, rot: 0 },
}] : []))
const artSel = ref<string | number | null>('relief')
function onStroke(s: ArtStroke): void {
  const c = document.createElement('canvas')
  c.width = W.value
  c.height = H.value
  const x = c.getContext('2d', { willReadFrequently: true })!
  applyStroke(x, { ...s, tool: 'erase' }, 1, '#ffffff')
  const full: Mask = { width: W.value, height: H.value, data: new Uint8Array(W.value * H.value).fill(255) }
  const m = strokeInto(body.value.keep ? maskFromRle(body.value.keep) : full, x.getImageData(0, 0, c.width, c.height).data, s.tool)
  doc.edit((b) => { b.keep = maskToRle(m) })
  say(`${s.tool === 'erase' ? 'erased from' : 'restored into'} the relief. ctrl+z takes it back.`, 'ok')
}
const clearBrush = () => doc.edit((b) => { b.keep = null })

// The 3D part, on three.js imported at first use.
const stageEl = ref<HTMLElement | null>(null)
let preview: ReliefPreview | null = null
let gone = false
async function startPreview(): Promise<void> {
  if (preview || !stageEl.value) return
  const { createReliefPreview } = await import('./preview3d.ts')
  if (gone || !stageEl.value || preview) return
  try {
    preview = createReliefPreview(stageEl.value, tone)
    if (result.value) preview.set(result.value.mesh)
  } catch {
    say('no webgl here. the face view and every export still work.', 'warn')
  }
}
watch(() => !!body.value.image, (on) => { if (on) setTimeout(() => void startPreview(), 0) })
watch(view, (v) => preview?.setActive(v === '3d'))
onBeforeUnmount(() => { gone = true; clearTimeout(timer); preview?.dispose(); preview = null })

// Compare wipe: the photo against the depth map, or the shaded relief with no map.
const split = ref(0.5)
const rightUrl = computed(() => (body.value.source === 'depth' && body.value.depth) || shadeUrl.value)

// Export: readout and checks under the buttons (P-DEPTH-11).
const formats: HbExportFormat[] = [
  { key: 'stl', label: 'stl', ext: '.stl', note: 'the closed solid in mm, binary.' },
  { key: 'obj', label: 'obj', ext: '.obj', note: 'the solid as text.' },
  { key: 'ply', label: 'ply', ext: '.ply', note: 'the solid, binary.' },
  { key: 'depth', label: 'depth png', ext: '.depth.png', note: 'the stored depth map, nearer is lighter.' },
  { key: 'doc', label: 'design', ext: '.hbrelief.json', note: 'the photo, the depth map, the brush and every setting.' },
]
const stats = computed(() => {
  const r = result.value
  if (!r) return null
  const b = bounds(r.mesh.positions)
  return { size: [0, 1, 2].map((k) => b.max[k]! - b.min[k]!), vol: volume(r.mesh), tris: r.mesh.indices.length / 3, open: openEdges(r.mesh.indices) }
})
const readout = computed<HbExportReadout[]>(() => {
  const s = stats.value
  const r = result.value
  if (!s || !r) return []
  return [
    { label: 'size', value: `${s.size.map((v) => v.toFixed(1)).join(' by ')} mm (computed)` },
    { label: 'volume', value: `${(s.vol / 1000).toFixed(2)} cm3 (computed)` },
    { label: 'triangles', value: s.tris },
    { label: 'grid', value: `${r.cols} by ${r.rows} cells, ${r.px.toFixed(3)} mm` },
  ]
})
const checks = computed<HbExportCheck[]>(() => {
  const s = stats.value
  const r = result.value
  if (!s || !r) return []
  const out: HbExportCheck[] = r.notes.map(([level, text]) => ({ tone: level, text }))
  out.push(s.open ? { tone: 'err', text: `open edges: ${s.open}. the solid is not closed. raise the base.` } : { tone: 'ok', text: 'closed solid, 0 open edges.' })
  return out
})
const exportBusy = computed(() => (!body.value.image ? 'drop a photo first.' : building.value ? 'the relief is building.' : ''))
async function onExport(req: HbExportRequest): Promise<void> {
  const d = doc.doc.value
  if (!d) return
  const name = req.filename || body.value.name
  if (req.format === 'doc') return void exportDoc(d.id, { filename: name })
  if (req.format === 'depth') {
    if (!body.value.depth) return say('no depth map yet. load the depth model or pick depth anything.', 'warn')
    return void exportDoc(d.id, { format: 'depth', filename: name })
  }
  await build()
  const r = result.value
  if (!r) return say(EMPTY, 'warn')
  if (req.format === 'stl') saveFile(`${name}.stl`, toStl(r.mesh) as Uint8Array<ArrayBuffer>, 'model/stl')
  else if (req.format === 'obj') saveFile(`${name}.obj`, toObj(r.mesh, name), 'text/plain')
  else saveFile(`${name}.ply`, toPly(r.mesh) as Uint8Array<ArrayBuffer>, 'application/octet-stream')
  say(`${name}.${req.format} saved.`, 'ok')
}

// Input.
const input = shallowRef<HbImageValue | null>(null)
const sample = ref<{ url: string; name: string } | null>(null)
const slotInfo = computed(() => (body.value.image ? `${body.value.width} by ${body.value.height}, ${body.value.depth ? 'depth stored' : 'no depth map yet'}` : ''))
watch(input, async (v) => {
  if (!v) return
  try {
    await docReady
    const f = await readFrame(v.blob ?? v.url)
    const name = (v.name || 'photo').replace(/\.[a-z0-9]+$/i, '')
    doc.edit((b) => withImage(b, name, f))
    if (ready.value) await runDepth()
    else say(record.value ? `${name} is in, from brightness. depth needs ${record.value.label}, ${sizeWord(record.value)}, once. load it, or use brightness.` : `${name} is in, from brightness.`, 'ok')
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'err')
  }
})


let docDone!: () => void
const docReady = new Promise<void>((r) => { docDone = r })
watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void doc.open(id) })
onMounted(async () => {
  const c = document.createElement('canvas')
  c.width = 640
  c.height = 480
  drawScene(c, tone)
  sample.value = { url: c.toDataURL('image/png'), name: 'sample scene' }
  await ws.ready()
  const q = route.query.doc
  if (typeof q === 'string') await doc.open(q)
  else {
    const all = (await ws.docs()).filter((d) => d.kind === RELIEF_KIND)
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
    else await doc.create('relief')
  }
  docDone()
  await loadModels()
  await addVisionRuntimes()
  booted.value = true
  if (body.value.image) say(`${body.value.name}: ${slotInfo.value}.`)
  logEvent('note', 'relief: ready.')
})
</script>

<template>
  <div class="hb-toolpage is-split">
    <HbPanel heading="photo" class="is-side">
      <HbImageSlot v-model="input" label="photo" :sources="['upload', 'paste', 'sample']" :sample="sample" :info="slotInfo" :info-tone="body.depth ? 'ok' : ''" :ratio="body.image ? `${W} / ${H}` : undefined" />
      <HbButton v-if="record && !ready" variant="secondary" size="sm" :loading="modelState === 'downloading'" @click="loadModel">{{ loadLabel }}</HbButton>
      <div class="hb-methods" role="radiogroup" aria-label="height from">
        <HbMethodCard
          v-for="s in sources" :key="s.name" :label="s.label" :trade="s.trade" :size-m-b="s.sizeMB" :state="s.state" :time="s.time"
          :active="body.source === s.name" @pick="pickSource(s.name)"
        />
      </div>
      <HbRange2
        v-model:lo="draft.base" v-model:hi="draft.height" label="height range" :min="0" :max="12" :step="0.04" :gap="0.12" :names="['base', 'top']"
        :format="fmtMm" hint="base is the lowest relief, top the highest." @commit="commit"
      />
      <HbParamRow
        v-for="r in rows" :key="r.k" :label="r.label" :min="r.min" :max="r.max" :step="r.step" :unit="r.unit" :default-value="DEFAULTS[r.k]"
        :model-value="draft[r.k]" @update:model-value="setDraft(r.k, $event)" @commit="commit" @reset="commit"
      />
      <HbParamRow label="invert" type="switch" :model-value="draft.invert" :help="body.source === 'inflate' ? 'light art on dark is the silhouette.' : 'far or dark is high.'" @update:model-value="setDraft('invert', $event)" @commit="commit" />
      <HbParamRow label="keep largest" type="switch" :model-value="body.keepLargest" help="drops every island but the main one." @update:model-value="doc.edit((b) => { b.keepLargest = !!$event })" />
      <HbChipGroup v-model="toolChip" :options="TOOLS" keys label="brush" />
      <HbSlider v-if="tool !== 'move'" v-model="brush" label="brush" :min="4" :max="120" unit="px" />
      <p class="hb-hint">{{ tool === 'move' ? 'erase paints out stray corners of the photo; they drop out of the relief.' : 'paint on the face view. v puts the brush down.' }}</p>
    </HbPanel>

    <div class="hb-toolpage">
      <HbPanel :heading="doc.doc.value?.name ?? 'relief'">
        <HbChipGroup v-if="body.image" v-model="viewChip" :options="VIEWS" keys label="view" />
        <HbViewport
          v-if="body.image"
          :aspect="view === 'face' ? `${W}/${H}` : '4/3'"
          :label="`${body.name} relief`"
          :cover-title="modelState === 'downloading' ? 'loading the depth model' : undefined"
          :cover-note="modelState === 'downloading' && record ? `${sizeWord(record)}. brightness works now.` : undefined"
        >
          <div v-show="view === '3d'" ref="stageEl" class="hb-viewport-host" />
          <HbArtboard
            v-if="view === 'face'" v-model:selected="artSel" v-model:tool="tool" fill :width="W" :height="H" :layers="layers" :brush="{ size: brush }"
            caption="face, shaded relief" :label="`${body.name} face`" @stroke="onStroke"
          />
          <template #tl><HbTag>{{ result ? `${result.source}, ${result.cols} by ${result.rows}` : 'building' }}</HbTag></template>
        </HbViewport>
        <HbStatusLine :text="status.text" :kind="depthBusy ? 'busy' : status.kind" />
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :disabled="!body.image || !ready || depthBusy" @click="runDepth">run depth</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!body.keep" @click="clearBrush">clear erase</HbButton>
          <SendTo from="relief" :offers="offers" />
          <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
          <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
        </HbToolbar>
      </HbPanel>

      <HbPanel heading="compare">
        <HbSplit v-if="body.image && rightUrl" v-model="split" :labels="['photo', body.source === 'depth' && body.depth ? 'depth' : 'relief']" :ratio="`${W} / ${H}`">
          <template #left><img :src="body.image" alt="the photo"></template>
          <template #right><img :src="rightUrl" :alt="body.source === 'depth' && body.depth ? 'the depth map' : 'the shaded relief'"></template>
        </HbSplit>
        <p v-else class="hb-hint">the photo and its depth compare here under a wipe once a photo is in.</p>
      </HbPanel>

      <HbPanel heading="export">
        <HbExportPanel :formats="formats" :name="body.name" :readout="readout" :checks="checks" :busy="exportBusy" label="relief" @export="onExport" />
      </HbPanel>

      <HbHow v-bind="how" persist-key="relief-how" />
    </div>
  </div>
</template>
