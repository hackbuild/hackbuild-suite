<script setup lang="ts">
// mask studio (rebuild plan 4): mask-studio-sam and the segment everything
// page as one canvas and rail. The picture fills; the rail holds the click
// cut and the hand tools with their letters; the rack holds what was found,
// the mask settings with the no model modes, the saved masks and every
// export. The click and segment everything models load from the chip, or
// on their own the first time a tool needs one.
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { HbButton, HbCanvasRail, HbCheckbox, HbFold, HbSlider, HbToolRail, type HbRailTool } from '@virgilvox/hackbuild-ui'
import { MASK_TOOLS, saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { probe } from '@hackbuild/ai-env'
import { openWeightStore } from '@hackbuild/weights'
import { autoThresholdMask, clusterMasks, colourClusters, edgeMask, exportInstances, thresholdMask, type Instance } from '@hackbuild/vision'
import { jobLoader, jobRecords, storedIds, useModelPick } from '@hackbuild/ai-views'
import { MaskRack, MaskStudio, MaskVerbs } from '@hackbuild/ai-views/vue'
import type { MaskModels, MaskStudio as Studio, StudioState } from '@hackbuild/ai-views/elements'
import { chipPick } from '../../shell/chip'
import { sampleCanvas } from './scene'

const STUB = new URLSearchParams(location.search).has('stub')

// the model: click segment (SlimSAM) or segment everything (FastSAM), from the chip
const pick = useModelPick('masks', { loader: jobLoader('masks') })
const models = shallowRef<MaskModels>({})
const offPick = pick.subscribe((s) => {
  const m = (s.loaded ?? null) as MaskModels | null
  if (m && m !== models.value) models.value = m
})
const note = ref('')
async function want(kind: 'segment' | 'everything') {
  const r = pick.snapshot().row
  note.value = `loading ${r?.name ?? 'the mask model'}, ${r?.size ?? 'size unknown'}, for the ${kind === 'segment' ? 'click cut' : 'object finder'}.`
  try {
    await pick.load()
    note.value = pick.error(pick.snapshot().chosen) ?? ''
  } catch (e) {
    note.value = `the mask model did not load: ${e instanceof Error ? e.message : String(e)}. the hand tools still work.`
  }
}

// the studio and its state
const studio = shallowRef<Studio | null>(null)
const st = shallowRef<StudioState | null>(null)
let offStudio = () => {}
let shown = ''
const preview = ref('')
let previewT = 0
function setStudio(s: Studio) {
  studio.value = s
  offStudio = s.subscribe((v) => {
    st.value = v
    if (v.tool !== tool.value) tool.value = v.tool
    const key = `${v.coverage}:${v.canUndo}:${v.width}`
    if (key === shown) return
    shown = key
    clearTimeout(previewT)
    previewT = window.setTimeout(paintPreview, 250)
  })
}
// the live result: the cutout, small
function paintPreview() {
  const img = studio.value?.mask('cutout')
  if (!img || !st.value?.coverage) return void (preview.value = '')
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  c.getContext('2d')!.putImageData(img, 0, 0)
  const t = document.createElement('canvas')
  t.width = 320
  t.height = Math.round((320 * img.height) / img.width)
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height)
  preview.value = t.toDataURL('image/png')
}

// the rail: the click cut, then the hackbuild-ui mask tools with their letters
const TOOLS: HbRailTool[] = [
  { id: 'point', label: 'cut out a thing', icon: 'crosshairs', key: 'a', hint: 'press a thing to cut it out. shift takes it away.' },
  ...MASK_TOOLS.map((t) => ({ id: t.id, label: t.label, icon: t.icon, key: t.key, hint: t.hint, ...(t.group ? { group: t.group } : {}) })),
]
const tool = ref('wand')
const setTool = (t: string) => {
  tool.value = t
  studio.value?.setTool(t as StudioState['tool'])
}
// the letters: the canvas takes its own while focused; elsewhere the page does, but m stays the bar's model key
function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest?.('input,textarea,select,[contenteditable]')) return
  const k = e.key.toLowerCase()
  const onCanvas = document.activeElement?.classList.contains('hb-mask-canvas')
  const t = TOOLS.find((x) => x.key === k && (k === 'a' || (!onCanvas && k !== 'm')))
  if (t && st.value?.ready) setTool(t.id)
}

// segment everything settings, the FastSAM page's defaults (vendor)
const confidence = ref(0.4)
const iou = ref(0.9)
const minArea = ref(64)
const sigmoid = ref(true)
const findAll = () => studio.value?.everything({ confidence: confidence.value, iou: iou.value, minArea: minArea.value, sigmoid: sigmoid.value })

// no model modes, the original's sliders and defaults
const edge = ref(50)
const level = ref(128)
const clusters = ref(5)
const autoNote = ref('')
function auto(kind: 'edges' | 'threshold' | 'clusters' | 'auto') {
  const s = studio.value
  const px = s?.pixels()
  if (!s || !px) return
  if (kind === 'edges') s.setMask(edgeMask(px, edge.value).data)
  else if (kind === 'threshold') s.setMask(thresholdMask(px, level.value).data)
  else if (kind === 'auto') {
    const r = autoThresholdMask(px)
    s.setMask(r.mask.data)
    level.value = r.threshold
    autoNote.value = `auto threshold ${r.threshold}`
    return
  } else {
    const c = colourClusters(px, { k: clusters.value })
    const found = clusterMasks(c).map((m, i) => ({ mask: m.data, label: `colour ${i + 1}`, score: c.counts[i]! / (px.width * px.height) }))
    s.addFound(found.filter((_, i) => i !== c.background))
    autoNote.value = `${found.length - 1} colour groups, the largest left out as background`
    return
  }
  autoNote.value = ''
}

// one file per found object: cutout and mask pngs, then instances.json
async function perObject() {
  const s = studio.value
  const px = s?.pixels()
  if (!s || !px || !st.value) return
  const w = px.width
  const list: Instance[] = st.value.found.filter((f) => !f.hidden).map((f) => {
    let x0 = w, y0 = px.height, x1 = -1, y1 = -1, area = 0
    for (let i = 0; i < f.mask.length; i++) {
      if (!f.mask[i]) continue
      const x = i % w, y = (i / w) | 0
      area++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
    return { box: f.box ?? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, score: f.score, area, label: f.label, mask: { width: w, height: px.height, data: f.mask } }
  })
  for (const f of await exportInstances(px, list, { crop: true, prefix: 'object' })) saveFile(f.name, new Blob([f.data as BlobPart], { type: f.type }))
}

const sample = () => studio.value?.setImage(sampleCanvas())

const tab = ref('found')
const TABS = [
  { id: 'found', label: 'objects' },
  { id: 'mask', label: 'mask' },
  { id: 'saved', label: 'saved' },
  { id: 'export', label: 'export' },
]

onMounted(async () => {
  chipPick.value = pick
  document.addEventListener('keydown', onKey)
  ;(window as unknown as { hbExplorer?: unknown }).hbExplorer = { pick, studio: () => studio.value, sample, auto, findAll, perObject }
  if (STUB) {
    const s = await import('./stubs')
    pick.update({ env: s.FIXTURE_ENV, loader: s.stubLoader })
    return
  }
  pick.update({ env: await probe() })
  const store = await openWeightStore().catch(() => null)
  if (store) pick.update({ stored: await storedIds(store, jobRecords('masks')) })
})
onBeforeUnmount(() => {
  offPick(), offStudio(), clearTimeout(previewT)
  document.removeEventListener('keydown', onKey)
  if (chipPick.value === pick) chipPick.value = null
})
</script>

<template>
  <HbCanvasRail v-model:tab="tab" class="xm" :tabs="TABS" rack-label="mask studio" tools-label="mask tools">
    <template #tools>
      <HbToolRail :model-value="tool" :tools="TOOLS"  :keys="false" label="mask tools" @update:model-value="setTool" />
    </template>
    <MaskStudio :models="models" demand sample-label="try the sample" @studio="setStudio" @sample="sample" @want="want" />
    <template v-if="studio" #verbs>
      <MaskVerbs :studio="studio" />
    </template>

    <template #tab-found>
      <img v-if="preview" class="xm-preview" :src="preview" alt="the cutout so far">
      <p v-if="note" class="hb-note" role="status">{{ note }}</p>
      <MaskRack v-if="studio" :studio="studio" part="found" />
      <HbFold v-if="st?.ready" summary="finder settings">
        <HbSlider v-model="confidence" label="confidence" :min="0.05" :max="0.95" :step="0.05" />
        <HbSlider v-model="iou" label="overlap kept (nms iou)" :min="0.3" :max="0.95" :step="0.05" />
        <HbSlider v-model="minArea" label="smallest object" :min="0" :max="5000" :step="16" unit=" px" />
        <HbCheckbox v-model="sigmoid">sigmoid on the mask decode</HbCheckbox>
        <HbButton @click="findAll">find again</HbButton>
      </HbFold>
    </template>
    <template #tab-mask>
      <MaskRack v-if="studio" :studio="studio" part="mask" />
      <HbFold v-if="st?.ready" summary="no model: edges, threshold, colours">
        <div class="hb-toolbar">
          <HbButton @click="auto('edges')">edges</HbButton>
          <HbButton @click="auto('threshold')">threshold</HbButton>
          <HbButton @click="auto('clusters')">colours</HbButton>
          <HbButton @click="auto('auto')">auto</HbButton>
        </div>
        <HbSlider v-model="edge" label="edge sensitivity" :min="10" :max="150" :step="1" />
        <HbSlider v-model="level" label="threshold level" :min="0" :max="255" :step="1" />
        <HbSlider v-model="clusters" label="colour groups" :min="2" :max="10" :step="1" />
        <p v-if="autoNote" class="hb-note">{{ autoNote }}</p>
      </HbFold>
    </template>
    <template #tab-saved>
      <MaskRack v-if="studio" :studio="studio" part="saved" />
    </template>
    <template #tab-export>
      <MaskRack v-if="studio" :studio="studio" part="export" name="mask" />
      <HbButton v-if="st?.found.length" @click="perObject">one png per object</HbButton>
    </template>
    <template #detail>
      <p class="hb-note">keys: a cut, w wand, b brush, e eraser, l lasso, p polygon, m rectangle, o ellipse, g flood, h pan. x swaps add and take away, shift takes away for one press, [ and ] size the brush, space pans, ctrl z undoes, ctrl s saves the mask, delete clears it, + and - zoom, 0 fits. the picture never leaves this tab.</p>
    </template>
  </HbCanvasRail>
</template>

<style scoped>
.xm { height: calc(100dvh - 52px); }
.xm :deep(.hb-lay-verbs) { display: flex; gap: var(--hb-s-2, 8px); align-items: center; flex-wrap: wrap; }
.xm-preview { display: block; width: 100%; max-height: 180px; object-fit: contain; margin-bottom: var(--hb-s-3, 12px); background: repeating-conic-gradient(#e8e2d4 0 25%, #fffdf7 0 50%) 0 0 / 16px 16px; border: 1.5px solid var(--hb-ink, #1a1a1a); }
</style>
