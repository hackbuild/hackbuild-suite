<script setup lang="ts">
// The masks tool (design 3.6, flow F-5). An image comes in through the
// slot or a drop; keep and leave out points and boxes on the prompt canvas
// decode a mask from one embedding per image; the mask is an instance with
// its colour and score. Erase and restore paint on the selected instance
// on the board; grow, shrink, smooth, invert and keep largest change it;
// saved masks are the history. Every change goes through the document, so
// undo reaches all of it.
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbArtboard, HbButton, HbChipGroup, HbHistoryStrip, HbHow, HbImageSlot, HbInset, HbInstanceList, HbPanel, HbPromptCanvas, HbSlider,
  HbStatusLine, HbTag, HbToolbar, HbViewport, useHotkeys,
  type ArtLayer, type ArtStroke, type ArtTool, type HbHistoryItem, type HbImageValue, type HbInstanceItem, type PromptTool,
} from '@virgilvox/hackbuild-ui'
import { applyStroke, instanceColour, saveFile, scorePct } from '@virgilvox/hackbuild-ui/vanilla'
import {
  cutoutPng, cutoutRgba, maskArea, maskDilate, maskErode, maskFeather, maskFromRle, maskInvert, maskLargestComponent, maskThreshold,
  maskToPng, maskToRgba, maskToRle, segment, type Mask,
} from '@hackbuild/vision'
import type { ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent } from '../shell/shell.ts'
import { exportDoc, pickFiles, useDocument, ws } from '../workspace/state'
import { readFrame, tone } from '../vision/frame.ts'
import { addVisionRuntimes, drawScene } from '../vision/runtimes.ts'
import {
  canDecode, hashText, INSTANCES_EXT, MASKS_KIND, mergeAll, newBody, readInstances, strokeInto, toSegmentPrompt, unionOf, withImage,
  withSaved, maskFromRgba, type Instance, type MasksBody, type Prompt,
} from './kind.ts'
import { registerMasks } from './register.ts'
import SendTo from '../shell/SendTo.vue'
import type { SendOffer } from '../workspace/sendto'

registerMasks()

const route = useRoute()
const doc = useDocument<MasksBody>(MASKS_KIND)
const body = computed<MasksBody>(() => doc.doc.value?.body ?? newBody())
const W = computed(() => body.value.width || 1)
const H = computed(() => body.value.height || 1)
const selId = ref<string | null>(null)
const sel = computed<Instance | null>(() => body.value.instances.find((i) => i.id === selId.value) ?? null)
const editSel = (fn: (i: Instance, b: MasksBody) => void) => {
  const id = selId.value
  doc.edit((b) => { const i = b.instances.find((x) => x.id === id); if (i) fn(i, b) })
}

const EMPTY = 'drop or paste an image, or take the sample scene.'
const status = ref<{ text: string; kind: 'none' | 'ok' | 'warn' | 'err' | 'info' | 'busy' }>({ text: EMPTY, kind: 'info' })
const say = (text: string, kind: typeof status.value.kind = 'info') => { status.value = { text, kind } }

// Tools: one table builds the chips, their letters and the hint (P-SEG-4, P-KEY-3).
type Tool = PromptTool | 'erase' | 'restore'
const TOOLS: { value: Tool; label: string; key: string; hint: string }[] = [
  { value: 'positive', label: 'keep', key: 'p', hint: 'press to keep what is under it. a right press leaves it out.' },
  { value: 'negative', label: 'leave out', key: 'n', hint: 'press on what the mask must leave out.' },
  { value: 'box', label: 'box', key: 'b', hint: 'drag a box around the object.' },
  { value: 'erase', label: 'erase', key: 'e', hint: 'paint out of the selected instance. esc goes back to keep.' },
  { value: 'restore', label: 'restore', key: 'r', hint: 'paint back into the selected instance. esc goes back to keep.' },
]
const tool = ref<Tool>('positive')
const toolOptions = TOOLS.map((t) => ({ label: t.label, value: t.value, key: t.key }))
const toolChip = computed({ get: () => tool.value as string, set: (v: string) => { tool.value = v as Tool } })
const refining = computed(() => tool.value === 'erase' || tool.value === 'restore')
const promptTool = computed({ get: () => (refining.value ? 'positive' : tool.value) as PromptTool, set: (v: PromptTool) => { tool.value = v } })
const artTool = computed({ get: (): ArtTool => (refining.value ? (tool.value as ArtTool) : 'move'), set: (v: ArtTool) => { tool.value = v === 'move' ? 'positive' : v } })
const hint = computed(() => {
  if (refining.value && !sel.value) return 'pick an instance in the list to refine it.'
  return TOOLS.find((t) => t.value === tool.value)!.hint
})
const brush = ref(24)

// The model: one record routed on the hub, loaded from a button that names its size.
const booted = ref(false)
const record = computed<ModelRecord | null>(() => {
  void hub.allRecords.value
  if (!booted.value) return null
  const env = hub.env.value
  return hub.registry.route({ provides: 'segment', ...(env ? { env } : {}) }) ?? null
})
const modelState = computed(() => (record.value ? hub.states.value[record.value.id]?.state ?? 'none' : 'none'))
const ready = computed(() => modelState.value === 'loaded' || modelState.value === 'stored')
const sizeWord = (r: ModelRecord) => (r.sizeMB === null ? 'size unknown' : `${Math.round(r.sizeMB)} mb (${r.sizeSource})`)
const loadLabel = computed(() => (record.value ? (modelState.value === 'downloading' ? 'loading the mask model' : `load the mask model, ${sizeWord(record.value)}`) : ''))
async function loadModel(): Promise<void> {
  const r = record.value
  if (!r) return say('no mask model runs here.', 'err')
  say(`loading the mask model, ${sizeWord(r)}, then one pass over your image.`, 'busy')
  await hub.load(r.id)
  if (modelState.value === 'fault') return say('the mask model failed. erase, restore and the mask operations still work.', 'err')
  if (body.value.image) {
    const t0 = performance.now()
    try {
      await segment(hub.hub(), await frameCanvas(), { points: [{ x: W.value / 2, y: H.value / 2, label: 1 }] }, { model: r.id, key: body.value.hash })
      say(`the mask model is ready. one pass over ${body.value.name} took ${Math.round(performance.now() - t0)} ms (measured). press on an object.`, 'ok')
    } catch (err) {
      say(`the mask model failed: ${err instanceof Error ? err.message : String(err)}. erase and restore still work.`, 'err')
    }
  } else say('the mask model is ready. drop an image.', 'ok')
}
const noGpu = computed(() => !!hub.env.value && !hub.env.value.webgpu)

// The frame the decoder reads and the cutout takes its colours from, once per image.
let frame: { hash: string; canvas: HTMLCanvasElement } | null = null
const pixels = shallowRef<ImageData | null>(null)
async function frameCanvas(): Promise<HTMLCanvasElement> {
  const b = body.value
  if (frame?.hash === b.hash) return frame.canvas
  const img = new Image()
  img.src = b.image!
  await img.decode()
  const c = document.createElement('canvas')
  c.width = b.width
  c.height = b.height
  const x = c.getContext('2d', { willReadFrequently: true })!
  x.drawImage(img, 0, 0, b.width, b.height)
  frame = { hash: b.hash, canvas: c }
  pixels.value = x.getImageData(0, 0, b.width, b.height)
  return c
}
watch(() => body.value.hash, (h) => { if (h && body.value.image) void frameCanvas() })

// Masks to images: alpha urls for the canvas, tints for the board, all cached by content.
const scratch = typeof document !== 'undefined' ? document.createElement('canvas') : null
function rgbaUrl(w: number, h: number, data: Uint8ClampedArray): string {
  scratch!.width = w
  scratch!.height = h
  scratch!.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0)
  return scratch!.toDataURL('image/png')
}
function tintUrl(m: Mask, hex = '#ffffff', a = 1): string {
  const rgb = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16))
  const d = new Uint8ClampedArray(m.width * m.height * 4)
  for (let i = 0; i < m.data.length; i++) {
    d[i * 4] = rgb[0]!
    d[i * 4 + 1] = rgb[1]!
    d[i * 4 + 2] = rgb[2]!
    d[i * 4 + 3] = m.data[i]! * a
  }
  return rgbaUrl(m.width, m.height, d)
}
const urls = new Map<string, string>()
function cached(key: string, make: () => string): string {
  let u = urls.get(key)
  if (!u) {
    if (urls.size > 200) urls.clear()
    u = make()
    urls.set(key, u)
  }
  return u
}
const rleKey = (i: { id: string; rle: { counts: number[] } }) => `${i.id}:${hashText(i.rle.counts.join(','))}`

const canvasMasks = computed(() =>
  body.value.instances.map((i) => ({ id: i.id, colour: instanceColour(i.colour), src: cached(`a:${rleKey(i)}`, () => tintUrl(maskFromRle(i.rle))), hidden: i.hidden })),
)
// The board while refining: each shown instance a locked tinted layer, the selected one takes the brush.
const layers = computed<ArtLayer[]>(() =>
  refining.value
    ? body.value.instances.filter((i) => !i.hidden || i.id === selId.value).map((i) => ({
      id: i.id, kind: 'image' as const, w: W.value, h: H.value, locked: true, label: `instance ${body.value.instances.indexOf(i) + 1}`,
      src: cached(`t:${rleKey(i)}:${i.colour}`, () => tintUrl(maskFromRle(i.rle), instanceColour(i.colour), i.id === selId.value ? 0.6 : 0.35)),
      transform: { x: W.value / 2, y: H.value / 2, scale: 1, rot: 0 },
    }))
    : [],
)
const artSel = computed({ get: () => selId.value, set: (v: string | number | null) => { if (v !== null) selId.value = String(v) } })

// Prompts: the canvas edits a live copy; a commit decodes and lands in the document.
const canvasPrompts = ref<Prompt[]>([])
watch(() => sel.value?.prompts, (p) => { canvasPrompts.value = p ? structuredClone(p) : [] }, { immediate: true })
const busy = ref(false)
let seq = 0
async function decode(ps: Prompt[]): Promise<Mask | null> {
  const r = record.value!
  const m = (await segment(hub.hub(), await frameCanvas(), toSegmentPrompt(ps), { model: r.id, key: body.value.hash }))[0]
  return m && m.width === body.value.width && m.height === body.value.height ? m : null
}
async function onCommit(ps: Prompt[]): Promise<void> {
  if (!body.value.image) return say(EMPTY, 'warn')
  if (!canDecode(ps)) {
    if (sel.value) editSel((i) => { i.prompts = ps })
    return say(ps.length ? 'add a keep point or a box. leave out points alone make no mask.' : 'prompts cleared.', 'info')
  }
  if (!ready.value) return say(record.value ? `load the mask model first, ${sizeWord(record.value)}.` : 'no mask model runs here.', 'warn')
  const n = ++seq
  busy.value = true
  preview.value = null
  const t0 = performance.now()
  try {
    const m = await decode(ps)
    if (n !== seq) return
    if (!m || !maskArea(maskThreshold(m))) return say('nothing under the pointer. press a different spot or draw a box.', 'warn')
    const ms = Math.round(performance.now() - t0)
    const rle = maskToRle(maskThreshold(m))
    const score = typeof m.score === 'number' ? m.score : null
    if (sel.value) editSel((i) => { i.prompts = ps; i.rle = rle; i.score = score; i.edited = false })
    else {
      const id = `m${Date.now().toString(36)}`
      doc.edit((b) => { b.instances.push({ id, colour: b.next, prompts: ps, rle, score, hidden: false, edited: false }); b.next += 1 })
      selId.value = id
    }
    const at = body.value.instances.findIndex((i) => i.id === selId.value) + 1
    say(`instance ${at}, ${scorePct(score) || 'no score'}, decoded in ${ms} ms (measured). add points to refine it, or press next instance.`, 'ok')
  } catch (err) {
    logEvent('fail', `masks: decode: ${err instanceof Error ? err.message : String(err)}`)
    say('the mask model failed. erase, restore and the mask operations still work.', 'err')
  } finally {
    if (n === seq) busy.value = false
  }
}
/** Hover decodes a preview with the selected instance's prompts and the point under the cursor (P-SEG-1). */
const preview = ref<string | null>(null)
let hoverSeq = 0
async function onHover(at: { x: number; y: number } | null): Promise<void> {
  const n = ++hoverSeq
  if (!at || tool.value !== 'positive' || !ready.value || !body.value.image || busy.value) { preview.value = null; return }
  try {
    const m = await decode([...(sel.value?.prompts ?? []), { kind: 'point', x: at.x, y: at.y, positive: true }])
    if (n === hoverSeq) preview.value = m ? tintUrl(m) : null
  } catch {
    preview.value = null
  }
}
const nextColour = computed(() => instanceColour(sel.value ? sel.value.colour : body.value.next))
function nextInstance(): void {
  selId.value = null
  canvasPrompts.value = []
  if (refining.value) tool.value = 'positive'
  say('the next press starts a new instance.', 'info')
}

// Refine: a stroke in layer pixels, which are image pixels here (P-DEPTH-5, P-SEG-7).
function onStroke(s: ArtStroke): void {
  const inst = body.value.instances.find((i) => i.id === String(s.id))
  if (!inst) return
  const c = document.createElement('canvas')
  c.width = W.value
  c.height = H.value
  const x = c.getContext('2d', { willReadFrequently: true })!
  applyStroke(x, { ...s, tool: 'erase' }, 1, '#ffffff')
  const m = strokeInto(maskFromRle(inst.rle), x.getImageData(0, 0, c.width, c.height).data, s.tool)
  editSel((i) => { i.rle = maskToRle(m); i.edited = true })
  say(`${s.tool === 'erase' ? 'erased from' : 'restored into'} the instance. ctrl+z takes it back.`, 'ok')
}

// Mask operations on the selected instance.
const OPS: { key: string; label: string; run: (m: Mask) => Mask }[] = [
  { key: 'grow', label: 'grow', run: (m) => maskDilate(m, 4) },
  { key: 'shrink', label: 'shrink', run: (m) => maskErode(m, 4) },
  { key: 'smooth', label: 'smooth', run: (m) => maskThreshold(maskFeather(m, 3)) },
  { key: 'invert', label: 'invert', run: (m) => maskInvert(m) },
  { key: 'largest', label: 'keep largest', run: (m) => maskLargestComponent(m) },
]
function runOp(op: (typeof OPS)[number]): void {
  const i = sel.value
  if (!i) return say('pick an instance in the list first.', 'warn')
  editSel((x) => { x.rle = maskToRle(op.run(maskFromRle(i.rle))); x.edited = true })
  say(`${op.label} on the instance.`, 'ok')
}

// Instances (P-SEG-2).
const items = computed<HbInstanceItem[]>(() => body.value.instances.map((i, n) => ({
  id: i.id, colour: instanceColour(i.colour), label: `instance ${n + 1}${i.edited ? ', edited' : ''}`, score: i.score, hidden: i.hidden,
})))
const listSel = computed({ get: () => selId.value, set: (v: string | number | null) => { selId.value = v === null ? null : String(v) } })
const toggle = (it: HbInstanceItem) => doc.edit((b) => { const i = b.instances.find((x) => x.id === it.id); if (i) i.hidden = !i.hidden })
function remove(it: HbInstanceItem): void {
  doc.edit((b) => { b.instances = b.instances.filter((x) => x.id !== it.id) })
  if (selId.value === it.id) nextInstance()
}
function merge(): void {
  if (body.value.instances.length < 2) return say('merge needs two instances.', 'warn')
  doc.edit((b) => mergeAll(b))
  selId.value = body.value.instances[0]?.id ?? null
  say('every instance merged into one.', 'ok')
}
function clearAll(): void {
  doc.edit((b) => { b.instances = [] })
  nextInstance()
}

// Preview of the selected instance, or of every shown one (P-SEG-3).
const look = ref('cutout')
// Send to (design 1.2): the image, and the shown instances as one mask that limits a relief.
const offers = computed<SendOffer[]>(() => {
  const b = body.value
  const frame = b.image ? { image: b.image, width: b.width, height: b.height } : null
  return [
    { type: 'image', what: 'image', ready: !!frame, get: () => (frame ? { type: 'image', name: b.name, frame } : null) },
    { type: 'mask', what: 'mask', ready: !!frame && b.instances.some((x) => !x.hidden), get: () => (frame ? { type: 'mask', name: `${b.name} mask`, frame, mask: maskToRle(unionOf(b)) } : null) },
  ]
})
const lookMask = computed(() => (sel.value ? maskFromRle(sel.value.rle) : body.value.instances.length ? unionOf(body.value) : null))
const lookUrl = computed(() => {
  const m = lookMask.value
  if (!m) return null
  if (look.value === 'mask') return rgbaUrl(m.width, m.height, maskToRgba(m))
  if (look.value === 'alpha') return tintUrl(m)
  const p = pixels.value
  return p && p.width === m.width ? rgbaUrl(m.width, m.height, cutoutRgba(p, m)) : null
})

// Saved masks are the history (P-SEG-5).
function saveMask(): void {
  if (!body.value.instances.some((i) => !i.hidden)) return say('nothing to save. make an instance first.', 'warn')
  const n = body.value.saved.length + 1
  doc.edit((b) => withSaved(b, { id: `s${Date.now().toString(36)}`, name: `mask ${n}`, at: Date.now(), rle: maskToRle(unionOf(b)) }))
  say(`saved as mask ${n}.`, 'ok')
}
const history = computed<HbHistoryItem[]>(() => body.value.saved.map((s) => ({
  id: s.id, thumb: cached(`s:${s.id}`, () => rgbaUrl(s.rle.size[1], s.rle.size[0], maskToRgba(maskFromRle(s.rle)))), label: s.name, meta: new Date(s.at).toLocaleTimeString(),
})))
function restoreSaved(it: HbHistoryItem): void {
  const s = body.value.saved.find((x) => x.id === it.id)
  if (!s) return
  const id = `m${Date.now().toString(36)}`
  doc.edit((b) => { b.instances = [{ id, colour: b.next, prompts: [], rle: s.rle, score: null, hidden: false, edited: true }]; b.next += 1 })
  selId.value = id
  say(`${s.name} is back as the only instance.`, 'ok')
}
const removeSaved = (it: HbHistoryItem) => doc.edit((b) => { b.saved = b.saved.filter((x) => x.id !== it.id) })

// Input.
const input = shallowRef<HbImageValue | null>(null)
const sample = ref<{ url: string; name: string } | null>(null)
const slotInfo = computed(() => (body.value.image ? `${body.value.width} by ${body.value.height}, ${body.value.instances.length} ${body.value.instances.length === 1 ? 'instance' : 'instances'}` : ''))
watch(input, async (v) => {
  if (!v) return
  try {
    await docReady
    const f = await readFrame(v.blob ?? v.url)
    const name = (v.name || 'image').replace(/\.[a-z0-9]+$/i, '')
    doc.edit(() => withImage(name, f))
    nextInstance()
    say(ready.value ? `${name} is in. press on an object.` : `${name} is in. load the mask model, then press on an object.`, 'ok')
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'err')
  }
})

// Masks from files: a mask png as one instance, an instances file as its instances.
const maskInput = ref<HTMLInputElement | null>(null)
async function addMaskFiles(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement
  const files = [...(el.files ?? [])]
  el.value = ''
  if (!body.value.image) return say(EMPTY, 'warn')
  for (const file of files) {
    try {
      const add: { rle: ReturnType<typeof maskToRle>; score: number | null; prompts: Prompt[] }[] = []
      if (file.name.toLowerCase().endsWith('.json')) add.push(...readInstances(await file.text(), W.value, H.value))
      else {
        const url = URL.createObjectURL(file)
        try {
          const img = new Image()
          img.src = url
          await img.decode()
          const c = document.createElement('canvas')
          c.width = W.value
          c.height = H.value
          const x = c.getContext('2d', { willReadFrequently: true })!
          x.drawImage(img, 0, 0, c.width, c.height)
          add.push({ rle: maskToRle(maskFromRgba(c.width, c.height, x.getImageData(0, 0, c.width, c.height).data)), score: null, prompts: [] })
        } catch {
          throw new Error(`${file.name} does not decode as an image.`)
        } finally {
          URL.revokeObjectURL(url)
        }
      }
      doc.edit((b) => {
        for (const a of add) { b.instances.push({ id: `m${Date.now().toString(36)}${b.next}`, colour: b.next, prompts: a.prompts, rle: a.rle, score: a.score, hidden: false, edited: true }); b.next += 1 }
      })
      say(`${add.length} ${add.length === 1 ? 'mask' : 'masks'} added from ${file.name}.`, 'ok')
    } catch (err) {
      say(err instanceof Error ? err.message : String(err), 'err')
    }
  }
}

// Export: mask png, cutout png, instances json, the document (P-SEG-8).
async function exportPng(kind: 'mask' | 'cutout'): Promise<void> {
  const b = body.value
  if (!b.instances.some((i) => !i.hidden)) return say('nothing to export. make an instance first.', 'warn')
  const m = unionOf(b)
  if (kind === 'cutout') await frameCanvas()
  const png = kind === 'mask' ? await maskToPng(m) : await cutoutPng(pixels.value!, m)
  saveFile(`${b.name}.${kind}.png`, png as Uint8Array<ArrayBuffer>, 'image/png')
}
const exportInstances = () => doc.doc.value && void exportDoc(doc.doc.value.id, { format: 'instances' })
const exportSession = () => doc.doc.value && void exportDoc(doc.doc.value.id)

// Keys: the tool letters come from the chips; h hides, delete removes the selected instance.
useHotkeys([
  { keys: 'h', label: 'hide or show the instance', group: 'tool', run: () => { const i = sel.value; if (i) toggle({ id: i.id, colour: '' }) } },
  { keys: 'delete', label: 'remove the instance', group: 'tool', run: () => { const i = sel.value; if (i) remove({ id: i.id, colour: '' }) } },
])

const HOW = `import { probe } from "@hackbuild/ai-env";
import { createHub, createRegistry } from "@hackbuild/models";
import { loadTransformers } from "@hackbuild/devices";
import { attachVision, segment, maskToRle, maskToPng } from "@hackbuild/vision";

const hub = createHub({ registry: createRegistry(), env: await probe() });
attachVision(hub, await loadTransformers());
const [mask] = await segment(hub, image, {
  points: [{ x: 320, y: 200, label: 1 }, { x: 300, y: 120, label: 0 }],
}, { key: "image hash" });
const json = JSON.stringify(maskToRle(mask));
const png = await maskToPng(mask);`

let docDone!: () => void
const docReady = new Promise<void>((r) => { docDone = r })
watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) { selId.value = null; void doc.open(id) } })
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
    const all = (await ws.docs()).filter((d) => d.kind === MASKS_KIND)
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
    else await doc.create('masks')
  }
  docDone()
  await loadModels()
  await addVisionRuntimes()
  booted.value = true
  if (body.value.image) say(`${body.value.name}: ${slotInfo.value}.${ready.value ? '' : ' load the mask model to add more.'}`)
  logEvent('note', 'masks: ready.')
})
</script>

<template>
  <div class="hb-toolpage is-split">
    <HbPanel heading="input" class="is-side">
      <HbImageSlot v-model="input" label="image" :sources="['upload', 'paste', 'sample']" :sample="sample" :info="slotInfo" :info-tone="body.instances.length ? 'ok' : ''" />
      <HbButton v-if="record && !ready" variant="secondary" size="sm" :loading="modelState === 'downloading'" @click="loadModel">{{ loadLabel }}</HbButton>
      <p v-if="noGpu" class="hb-hint">no webgpu adapter. the mask model runs one slow pass on cpu, then picking is instant.</p>
      <HbChipGroup v-model="toolChip" :options="toolOptions" keys label="tool" />
      <p class="hb-hint">{{ hint }}</p>
      <HbSlider v-if="refining" v-model="brush" label="brush" :min="4" :max="80" unit="px" />
      <HbToolbar>
        <HbButton v-for="op in OPS" :key="op.key" variant="secondary" size="sm" :disabled="!sel" @click="runOp(op)">{{ op.label }}</HbButton>
      </HbToolbar>
    </HbPanel>

    <div class="hb-toolpage">
      <HbPanel :heading="doc.doc.value?.name ?? 'masks'">
        <HbViewport
          v-if="body.image"
          :aspect="`${W}/${H}`"
          :label="`${body.name}, ${body.instances.length} instances`"
          :cover-title="modelState === 'downloading' ? 'loading the mask model' : undefined"
          :cover-note="modelState === 'downloading' && record ? `${sizeWord(record)}, then one pass over your image.` : undefined"
        >
          <HbArtboard v-model:selected="artSel" v-model:tool="artTool" fill :width="W" :height="H" :image="refining ? body.image : undefined" :layers="layers" :brush="{ size: brush }" :label="`${body.name} board`" @stroke="onStroke">
            <HbPromptCanvas
              v-if="!refining"
              v-model:prompts="canvasPrompts"
              v-model:tool="promptTool"
              bare
              :image="body.image"
              :width="W"
              :height="H"
              :masks="canvasMasks"
              :preview="preview"
              :preview-colour="nextColour"
              :label="body.name"
              @hover="onHover"
              @commit="onCommit"
            />
          </HbArtboard>
          <template #tl><HbTag>{{ refining ? `${tool}, ${sel ? 'instance selected' : 'no instance'}` : `${canvasPrompts.length} prompts` }}</HbTag></template>
        </HbViewport>
        <HbStatusLine :text="status.text" :kind="busy ? 'busy' : status.kind" />
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :disabled="!body.image" @click="nextInstance">next instance</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!body.instances.length" @click="saveMask">save mask</HbButton>
          <SendTo from="masks" :offers="offers" />
          <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
        </HbToolbar>
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :disabled="!body.instances.length" @click="exportPng('mask')">mask png</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!body.instances.length" @click="exportPng('cutout')">cutout png</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!body.instances.length" @click="exportInstances">instances json</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!body.image" @click="maskInput?.click()">add mask</HbButton>
          <HbButton variant="secondary" size="sm" @click="exportSession">export</HbButton>
          <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
        </HbToolbar>
        <input ref="maskInput" type="file" :accept="`.png,image/png,${INSTANCES_EXT}`" multiple hidden aria-label="add a mask png or an instances file" @change="addMaskFiles">
      </HbPanel>

      <HbPanel heading="instances">
        <HbInstanceList v-model:selected="listSel" :items="items" empty="no instances yet. load the mask model and press on an object." @toggle="toggle" @remove="remove" @merge="merge" @clear="clearAll" />
      </HbPanel>

      <HbPanel heading="preview">
        <HbInset v-if="lookUrl" v-model:mode="look" :modes="['mask', 'alpha', 'cutout']" :title="sel ? `instance ${body.instances.indexOf(sel) + 1}` : 'shown instances'" :ratio="`${W} / ${H}`">
          <img :src="lookUrl" :alt="`the ${look} of ${sel ? 'the selected instance' : 'the shown instances'}`">
        </HbInset>
        <p v-else class="hb-hint">the mask, its alpha and the cutout show here once there is an instance.</p>
      </HbPanel>

      <HbPanel heading="saved masks">
        <HbHistoryStrip :items="history" empty="save mask keeps the shown instances as one mask here." @restore="restoreSaved" @remove="removeSaved" />
      </HbPanel>

      <HbHow
        :packages="['@hackbuild/vision', '@hackbuild/models', '@hackbuild/devices', '@hackbuild/ai-env']"
        install="npm i @hackbuild/vision @hackbuild/models @hackbuild/devices @hackbuild/ai-env"
        :code="HOW"
        persist-key="masks-how"
      />
    </div>
  </div>
</template>
