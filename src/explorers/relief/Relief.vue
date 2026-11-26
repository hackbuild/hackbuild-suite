<script setup lang="ts">
// relief (rebuild plan 4): the bail bench's art step as one canvas and rail.
// A photo or a 3d model becomes a relief: depth from the model on the chip,
// brightness or an inflated outline with none, or a posed glb read as depth.
// The rail holds look, erase and restore; the face canvas takes the brush and
// the 3d views show each colour body. The rack: art, relief, colour, print,
// with a multi colour 3mf, an stl zip and the faces as png.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { HbArtboard, HbButton, HbCanvasRail, HbCheckbox, HbChipGroup, HbFold, HbSelect, HbSlider, HbToolRail, type ArtLayer, type ArtStroke, type HbRailTool } from '@virgilvox/hackbuild-ui'
import { applyStroke, saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { probe } from '@hackbuild/ai-env'
import { openWeightStore } from '@hackbuild/weights'
import { jobLoader, jobRecords, storedIds, useModelPick, type DepthFn } from '@hackbuild/ai-views'
import {
  bounds, depthImage, glbMesh, loadDepthMesh, modelDepth, openEdges, photoRelief, reliefParts, RELIEF_DEFAULTS, toObj, toStl, toThreeMf, volume, zipStore,
  type DepthGrid, type DepthMesh, type HeightSourceName, type Mesh, type ModelPose, type PhotoRelief, type ReliefParams, type ThreeMfPart,
} from '@hackbuild/depth-mesh'
import { clusterMasks, colourClusters } from '@hackbuild/vision'
import { chipPick } from '../../shell/chip'
import { samplePhoto } from './sample'
import type { Stage, View3d } from './stage3d'

const STUB = new URLSearchParams(location.search).has('stub')

// the depth model, from the chip or on its own when depth is wanted
const pick = useModelPick('depth', { loader: jobLoader('depth') })
const depthFn = shallowRef<DepthFn | null>(null)
const tick = ref(0)
const offPick = pick.subscribe((s) => { tick.value++; if (s.loaded && s.loaded !== depthFn.value) depthFn.value = s.loaded as DepthFn })
const depthRow = computed(() => (void tick.value, pick.snapshot().row))
const depthLoading = computed(() => depthRow.value?.state === 'loading')
const depthLabel = computed(() => (depthLoading.value ? 'loading depth' : `load depth, ${depthRow.value?.size ?? 'size unknown'}`))
const note = ref('')
async function wantDepth() {
  const r = pick.snapshot().row
  note.value = `loading ${r?.name ?? 'the depth model'}, ${r?.size ?? 'size unknown'}. height comes from brightness until it lands.`
  try {
    await pick.load()
    note.value = pick.error(pick.snapshot().chosen) ?? ''
  } catch (e) {
    note.value = `the depth model did not load: ${e instanceof Error ? e.message : String(e)}. brightness and inflate still work.`
  }
}

// the art: a photo, or a posed model read as depth
type Img = { width: number; height: number; data: Uint8ClampedArray }
const name = ref('relief')
const kind = ref<'photo' | 'model' | null>(null)
const img = shallowRef<Img | null>(null)
const depth = shallowRef<DepthGrid | null>(null)
const model = shallowRef<Mesh | null>(null)
const pose = ref<Required<ModelPose>>({ up: 'y', yaw: 0, pitch: 0, roll: 0 })
const MAXW = 640
function fromCanvas(c: HTMLCanvasElement | HTMLImageElement, n: string) {
  const w0 = 'naturalWidth' in c ? c.naturalWidth : c.width, h0 = 'naturalHeight' in c ? c.naturalHeight : c.height
  const k = Math.min(1, MAXW / w0)
  const t = document.createElement('canvas')
  t.width = Math.round(w0 * k)
  t.height = Math.round(h0 * k)
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height)
  reset(n, 'photo')
  img.value = t.getContext('2d')!.getImageData(0, 0, t.width, t.height)
  void runDepth()
}
function reset(n: string, k: 'photo' | 'model') {
  name.value = n
  kind.value = k
  depth.value = null
  model.value = null
  erase.value = restore.value = null
  past.length = future.length = 0
}
async function runDepth() {
  const f = depthFn.value, p = img.value
  if (!f || !p || kind.value !== 'photo') return
  const c = document.createElement('canvas')
  c.width = p.width
  c.height = p.height
  c.getContext('2d')!.putImageData(new ImageData(p.data as Uint8ClampedArray<ArrayBuffer>, p.width, p.height), 0, 0)
  try {
    depth.value = await f(c)
  } catch (e) {
    note.value = `depth failed: ${e instanceof Error ? e.message : String(e)}. brightness still works.`
  }
}
watch(depthFn, () => void runDepth())
function openModel(bytes: ArrayBuffer, n: string) {
  try {
    const m = glbMesh(bytes)
    reset(n, 'model')
    model.value = m
    source.value = 'depth'
    posed()
  } catch (e) {
    note.value = `that model did not open: ${e instanceof Error ? e.message : String(e)}`
  }
}
function posed() {
  if (!model.value) return
  const d = modelDepth(model.value, { width: 384, pose: pose.value })
  depth.value = d
  img.value = depthImage(d)
}
watch(pose, posed, { deep: true })
const fileIn = ref<HTMLInputElement | null>(null)
async function takeFile(f: File | undefined) {
  if (!f) return
  const n = f.name.replace(/\.[a-z0-9]+$/i, '')
  if (/\.glb$/i.test(f.name)) return openModel(await f.arrayBuffer(), n)
  const im = new Image()
  im.src = URL.createObjectURL(f)
  try { await im.decode(); fromCanvas(im, n) } catch { note.value = `${f.name} is not an image or a glb.` } finally { URL.revokeObjectURL(im.src) }
}
const sample = () => fromCanvas(samplePhoto(), 'sample')

// the settings, one undo step per release
const source = ref<HeightSourceName>('depth')
const params = ref<ReliefParams>({ ...RELIEF_DEFAULTS })
const keepLargest = ref(false)
const colours = ref(3)
const split = ref<'height' | 'colours'>('height')
const erase = shallowRef<Uint8Array | null>(null)
const restore = shallowRef<Uint8Array | null>(null)
type Snap = { p: ReliefParams; s: HeightSourceName; k: boolean; n: number; sp: string; e: Uint8Array | null; r: Uint8Array | null }
const snap = (): Snap => ({ p: { ...params.value }, s: source.value, k: keepLargest.value, n: colours.value, sp: split.value, e: erase.value, r: restore.value })
const past: Snap[] = [], future: Snap[] = []
const hist = ref(0)
let last = snap()
function commit() { past.push(last); future.length = 0; last = snap(); hist.value++ }
function put(s: Snap) {
  params.value = { ...s.p }; source.value = s.s; keepLargest.value = s.k; colours.value = s.n; split.value = s.sp as 'height'; erase.value = s.e; restore.value = s.r
  last = s
  hist.value++
}
const undo = () => { const s = past.pop(); if (s) future.push(snap()), put(s) }
const redo = () => { const s = future.pop(); if (s) past.push(snap()), put(s) }
const canUndo = computed(() => (hist.value, past.length > 0))
const canRedo = computed(() => (hist.value, future.length > 0))

// the brush: erase cuts, restore brings back, both at the art's size
const tool = ref<'move' | 'erase' | 'restore'>('move')
const TOOLS: HbRailTool[] = [
  { id: 'move', label: 'look', icon: 'hand', key: 'v', hint: 'drag pans, the wheel zooms.' },
  { id: 'erase', label: 'erase', icon: 'eraser', key: 'e', hint: 'paint out stray corners; they drop out of the relief.' },
  { id: 'restore', label: 'restore', icon: 'brush', key: 'r', hint: 'paint back what the erase or the background cut took.' },
]
const brush = ref(28)
function onStroke(s: ArtStroke) {
  const p = img.value
  if (!p) return
  const c = document.createElement('canvas')
  c.width = p.width
  c.height = p.height
  const x = c.getContext('2d', { willReadFrequently: true })!
  applyStroke(x, { ...s, tool: 'erase' }, 1, '#ffffff')
  const d = x.getImageData(0, 0, c.width, c.height).data
  const n = p.width * p.height
  const on = s.tool === 'erase' ? (erase.value ? new Uint8Array(erase.value) : new Uint8Array(n)) : restore.value ? new Uint8Array(restore.value) : new Uint8Array(n)
  const off = s.tool === 'erase' ? restore.value && new Uint8Array(restore.value) : erase.value && new Uint8Array(erase.value)
  for (let i = 0; i < on.length; i++) if (d[i * 4 + 3]! > 0) { on[i] = 1; if (off) off[i] = 0 }
  if (s.tool === 'erase') (erase.value = on), (restore.value = off)
  else (restore.value = on), (erase.value = off)
  commit()
}
const clearBrush = () => { erase.value = restore.value = null; commit() }

// the relief, rebuilt on the depth-mesh core
let core: Promise<DepthMesh> | null = null
const dm = () => (core ??= import('@hackbuild/depth-mesh/inline').then(({ DEPTH_MESH_WASM_BASE64 }) => loadDepthMesh({ base64: DEPTH_MESH_WASM_BASE64 })))
const result = shallowRef<PhotoRelief | null>(null)
const parts = shallowRef<ThreeMfPart[]>([])
const err = ref('')
const ms = ref(0)
const colourChecks = shallowRef<[string, string][]>([])
let seq = 0, timer = 0
const grid = (m: Uint8Array | null) => m && img.value ? { width: img.value.width, height: img.value.height, data: m } : undefined
async function build() {
  const p = img.value
  if (!p) return
  const n = ++seq, t0 = performance.now()
  try {
    const core = await dm()
    const r = await photoRelief(core, p, {
      ...params.value, source: source.value, keepLargest: keepLargest.value,
      ...(depth.value ? { depth: depth.value } : {}), ...(erase.value ? { erase: grid(erase.value)! } : {}), ...(restore.value ? { restore: grid(restore.value)! } : {}),
    })
    if (n !== seq) return
    const k = colours.value
    let ps: ThreeMfPart[]
    let cc: [string, string][] = []
    if (k < 2) ps = [{ name: 'relief', mesh: r.mesh, filament: 1 }]
    else if (split.value === 'colours' && kind.value === 'photo') {
      const c = colourClusters(p, { k })
      const ms = clusterMasks(c)
      const labels = [ms[c.background]!, ...ms.filter((_, i) => i !== c.background)]
      ps = reliefParts(core, r, { by: 'mask', labels })
      cc = colourWidth(r, labels)
    } else {
      const top = r.heights.reduce((a, h) => Math.max(a, h), 0)
      const step = (top - params.value.base) / k
      ps = reliefParts(core, r, { by: 'height', breaks: Array.from({ length: k - 1 }, (_, i) => params.value.base + step * (i + 1)) })
      cc = [step < 2 * LAYER ? ['warn', `terraces are ${step.toFixed(2)} mm apart, under two ${LAYER} mm layers: a colour change will hardly show. raise the top.`] : ['ok', `terraces are ${step.toFixed(2)} mm apart, ${Math.floor(step / LAYER)} layers of ${LAYER} mm each.`]]
    }
    colourChecks.value = cc
    result.value = r
    parts.value = ps
    err.value = ''
    ms.value = Math.round(performance.now() - t0)
    stage?.set(ps.map((x) => ({ ...x.mesh, color: fil.value[x.filament - 1] ?? '#fffdf7' })))
  } catch (e) {
    if (n === seq) err.value = `the relief did not build: ${e instanceof Error ? e.message : String(e)}`
  }
}
// the colour width check: per colour cell, the narrower of its row and column
// run on the grid reliefParts cuts by; a strip under one nozzle line prints thin
function colourWidth(r: PhotoRelief, masks: { width: number; height: number; data: ArrayLike<number> }[]): [string, string][] {
  const { cols, rows, heights, px } = r
  const lab = new Uint8Array(cols * rows)
  masks.forEach((m, k) => {
    for (let j = 0; j < rows; j++)
      for (let i = 0; i < cols; i++) {
        const v = m.data[Math.floor(((j + 0.5) / rows) * m.height) * m.width + Math.floor(((i + 0.5) / cols) * m.width)]!
        if (v >= 128 || v === 1) lab[j * cols + i] = k
      }
  })
  const run = (q: number, d: number, n: number, at: (t: number) => number) => {
    let a = 0, b = 0
    while (at(-a - 1) >= 0 && at(-a - 1) < n && lab[q - (a + 1) * d] === lab[q] && heights[q - (a + 1) * d]! > 0) a++
    while (at(b + 1) >= 0 && at(b + 1) < n && lab[q + (b + 1) * d] === lab[q] && heights[q + (b + 1) * d]! > 0) b++
    return a + b + 1
  }
  const need = Math.ceil(NOZZLE / px)
  let thin = 0, coloured = 0
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const q = j * cols + i
      if (!lab[q] || !(heights[q]! > 0)) continue
      coloured++
      if (Math.min(run(q, 1, cols, (t) => i + t), run(q, cols, rows, (t) => j + t)) < need) thin++
    }
  if (!coloured) return []
  const share = Math.round((thin / coloured) * 100)
  return [share > 5 ? ['warn', `${share}% of the colour is in strips under one ${NOZZLE} mm line; they print thin or drop out. fewer colours or a wider print helps.`] : ['ok', `colour strips are at least one ${NOZZLE} mm line wide${thin ? `, but for ${share}%` : ''}.`]]
}
const schedule = () => { clearTimeout(timer); timer = window.setTimeout(() => void build(), 120) }
watch([img, depth, source, params, keepLargest, erase, restore, colours, split], schedule, { deep: true })

// filament colours, the original's ink, pink, cream and a fourth
const FIL = ['#1a1a1a', '#fe0386', '#f4ecd8', '#2f5fa7']
const fil = ref<string[]>((() => { try { const v = JSON.parse(localStorage.getItem('hb-relief-fil') ?? 'null'); return Array.isArray(v) && v.length === 4 ? v : FIL } catch { return FIL } })())
watch(fil, (v) => { try { localStorage.setItem('hb-relief-fil', JSON.stringify(v)) } catch { /* private window */ } schedule() }, { deep: true })

// the face: the shaded relief the brush paints on, erased cells in red
const shade = computed(() => {
  const r = result.value, p = img.value
  if (!r || !p) return ''
  const { cols, rows, heights, px } = r
  const top = heights.reduce((a, h) => Math.max(a, h), 0) || 1
  const d = new Uint8ClampedArray(cols * rows * 4)
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const q = j * cols + i, h = heights[q]!
      const dx = (heights[j * cols + Math.min(cols - 1, i + 1)]! - heights[j * cols + Math.max(0, i - 1)]!) / (2 * px)
      const dy = (heights[Math.min(rows - 1, j + 1) * cols + i]! - heights[Math.max(0, j - 1) * cols + i]!) / (2 * px)
      const lit = Math.max(0, Math.min(1, 0.55 + (-dx - dy) * 0.35 + (h / top) * 0.25))
      const v = h > 0 ? 40 + lit * 200 : 16
      const e = erase.value?.[Math.floor(((j + 0.5) / rows) * p.height) * p.width + Math.floor(((i + 0.5) / cols) * p.width)]
      d[q * 4] = e ? 200 : v
      d[q * 4 + 1] = d[q * 4 + 2] = e ? v * 0.4 : v
      d[q * 4 + 3] = 255
    }
  const c = document.createElement('canvas')
  c.width = cols
  c.height = rows
  c.getContext('2d')!.putImageData(new ImageData(d, cols, rows), 0, 0)
  return c.toDataURL('image/png')
})
const layers = computed<ArtLayer[]>(() => (shade.value && img.value ? [{
  id: 'relief', kind: 'image', w: img.value.width, h: img.value.height, locked: true, label: 'relief', src: shade.value, transform: { x: img.value.width / 2, y: img.value.height / 2, scale: 1, rot: 0 },
}] : []))
// the brush paints on the selected layer; looking leaves it unselected, so no handles show
const sel = ref<string | number | null>(null)
watch(tool, (t) => { sel.value = t === 'move' ? null : 'relief' })

// the views, a row on the stage as the original's: the face, or the 3d part
// from six sides; on a wide screen the face sits beside the iso part
const view = ref<'face' | View3d>('face')
const VIEWS = ['face', 'iso', 'front', 'side', 'back', 'explode', 'cut'] as const
const setView = (v: string) => { view.value = v as View3d; if (v !== 'face') tool.value = 'move' }
const wideQ = matchMedia('(min-width: 1024px)')
const wide = ref(wideQ.matches)
const onWide = () => { wide.value = wideQ.matches }
wideQ.addEventListener('change', onWide)
const split3d = computed(() => view.value === 'face' && wide.value)
const stageEl = ref<HTMLElement | null>(null)
let stage: Stage | null = null
watch([view, stageEl, wide], async ([v, el, w]) => {
  if ((v === 'face' && !w) || !el) return
  if (!stage) {
    const { createStage } = await import('./stage3d')
    stage = createStage(el)
    void build()
  }
  stage.view(v === 'face' ? 'iso' : v)
})
const setTool = (t: string) => { tool.value = t as 'move'; if (t !== 'move') view.value = 'face' }

// the print card: size, volume, triangles, and the reality checks
const stats = computed(() => {
  const r = result.value
  if (!r) return null
  const b = bounds(r.mesh.positions)
  return { size: [0, 1, 2].map((k) => b.max[k]! - b.min[k]!), vol: volume(r.mesh), tris: r.mesh.indices.length / 3, open: openEdges(r.mesh.indices) }
})
const NOZZLE = 0.4, LAYER = 0.2
const bare = (t: string) => t.replace(/ \((computed|measured|vendor|inferred|unknown)\)/g, '')
const checks = computed(() => {
  const s = stats.value, r = result.value
  if (!s || !r) return []
  const out: [string, string][] = r.notes.map(([l, t]) => [l, bare(t)])
  out.push(s.open ? ['err', `${s.open} open edges: the solid is not closed. raise the base.`] : ['ok', 'closed solid, no open edges.'])
  out.push(r.px < NOZZLE / 2 ? ['warn', `cells are ${r.px.toFixed(2)} mm, finer than half a ${NOZZLE} mm nozzle. detail under that will not print.`] : ['ok', `cells are ${r.px.toFixed(2)} mm, fine for a ${NOZZLE} mm nozzle.`])
  if (params.value.height - params.value.base < 2 * LAYER) out.push(['warn', `under ${2 * LAYER} mm of relief: two layers at ${LAYER} mm show little.`])
  return [...out, ...colourChecks.value]
})
const PRINTERS = [
  { label: 'the slicer keeps its own', value: '' },
  { label: 'flashforge creator 5 pro, 0.4 nozzle', value: 'Flashforge Creator 5 Pro 0.4 nozzle|0.20mm Standard @Flashforge Creator 5 Pro' },
]
const printer = ref('')

// exports
const blob = (d: Uint8Array, type: string) => new Blob([d as BlobPart], { type })
// the print card: the part beside its settings, filaments and checks, one png
async function cardPng(): Promise<Blob | null> {
  const r = result.value, s = stats.value
  if (!r || !s) return null
  const src = stage ? stage.png() : shade.value
  const art = new Image()
  art.src = src
  await art.decode().catch(() => undefined)
  const W = 1200, H = 720, c = document.createElement('canvas')
  c.width = W
  c.height = H
  const x = c.getContext('2d')!
  x.fillStyle = '#fffdf7'
  x.fillRect(0, 0, W, H)
  x.fillStyle = '#e9e2d0'
  x.fillRect(0, 0, 640, H)
  if (art.naturalWidth) {
    const k = Math.min(600 / art.naturalWidth, 680 / art.naturalHeight)
    x.drawImage(art, 20 + (600 - art.naturalWidth * k) / 2, 20 + (680 - art.naturalHeight * k) / 2, art.naturalWidth * k, art.naturalHeight * k)
  }
  x.fillStyle = '#1a1a1a'
  x.font = 'bold 34px monospace'
  x.fillText(name.value, 670, 64)
  x.font = '20px monospace'
  const lines = [
    `size ${s.size.map((v) => v.toFixed(1)).join(' x ')} mm`,
    `base ${mm(params.value.base)}, top ${mm(params.value.height)}`,
    `height from ${result.value?.source ?? source.value}`,
    `${parts.value.length} bodies, ${s.tris} triangles`,
    `printer ${PRINTERS.find((p) => p.value === printer.value)?.label ?? 'the slicer keeps its own'}`,
  ]
  lines.forEach((l, i) => x.fillText(l, 670, 116 + i * 34))
  fil.value.slice(0, Math.max(1, colours.value)).forEach((f, i) => {
    const y = 300 + i * 44
    x.fillStyle = f
    x.fillRect(670, y, 32, 32)
    x.strokeStyle = '#1a1a1a'
    x.lineWidth = 2
    x.strokeRect(670, y, 32, 32)
    x.fillStyle = '#1a1a1a'
    x.fillText(`${i + 1} ${i === 0 ? 'base' : split.value === 'height' ? `terrace ${i}` : `colour ${i + 1}`}, petg, ${f}`, 716, y + 23)
  })
  x.font = '16px monospace'
  checks.value.slice(0, 6).forEach(([t, l], i) => x.fillText(`${t === 'ok' ? 'ok' : t === 'warn' ? 'check' : 'fault'} ${l}`.slice(0, 58), 670, 500 + i * 28))
  return (await fetch(c.toDataURL('image/png'))).blob()
}
async function exportAs(k: '3mf' | 'stl' | 'zip' | 'obj' | 'face' | 'depth' | 'design' | 'card'): Promise<Blob | null> {
  await build()
  const r = result.value
  if (!r) return null
  if (k === 'card') return cardPng()
  const [pr, pc] = printer.value.split('|')
  if (k === '3mf') return blob(toThreeMf([{ name: name.value, parts: parts.value }], fil.value.slice(0, Math.max(1, colours.value)).map((color) => ({ color, type: 'PETG' })), { title: name.value, ...(pr ? { printer: pr, process: pc! } : {}) }), 'model/3mf')
  if (k === 'stl') return blob(toStl(r.mesh), 'model/stl')
  if (k === 'zip') return blob(zipStore(Object.fromEntries(parts.value.map((p, i) => [`${name.value}-${i + 1}.stl`, toStl(p.mesh)])), new Date()), 'application/zip')
  if (k === 'obj') return new Blob([toObj(r.mesh, name.value)], { type: 'text/plain' })
  if (k === 'design') return new Blob([JSON.stringify({ kind: 'hb-relief', name: name.value, source: source.value, params: params.value, keepLargest: keepLargest.value, colours: colours.value, split: split.value, filaments: fil.value })], { type: 'application/json' })
  const url = k === 'face' ? (view.value !== 'face' && stage ? stage.png() : shade.value) : depthUrl()
  return url ? (await fetch(url)).blob() : null
}
function depthUrl() {
  const d = depth.value
  if (!d) return ''
  const c = document.createElement('canvas')
  c.width = d.width
  c.height = d.height
  const px = new Uint8ClampedArray(d.width * d.height * 4)
  for (let i = 0; i < d.data.length; i++) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = Math.round(d.data[i]! * 255), (px[i * 4 + 3] = 255)
  c.getContext('2d')!.putImageData(new ImageData(px, d.width, d.height), 0, 0)
  return c.toDataURL('image/png')
}
const EXT = { '3mf': '.3mf', stl: '.stl', zip: '-stl.zip', obj: '.obj', face: '-face.png', depth: '-depth.png', design: '.hbrelief.json', card: '-card.png' }
async function save(k: keyof typeof EXT) {
  const b = await exportAs(k)
  if (b) saveFile(`${name.value}${EXT[k]}`, b)
}
async function openDesign(f: File | undefined) {
  if (!f) return
  try {
    const d = JSON.parse(await f.text())
    if (d.kind !== 'hb-relief') throw new Error('not a relief design')
    params.value = { ...RELIEF_DEFAULTS, ...d.params }; source.value = d.source; keepLargest.value = !!d.keepLargest; colours.value = d.colours; split.value = d.split
    if (Array.isArray(d.filaments)) fil.value = d.filaments
    commit()
  } catch (e) { note.value = `that design did not open: ${e instanceof Error ? e.message : String(e)}` }
}

const tab = ref('art')
const TABS = [{ id: 'art', label: 'art' }, { id: 'relief', label: 'relief' }, { id: 'colour', label: 'colour' }, { id: 'print', label: 'print' }]
const SOURCES = [{ label: 'depth anything', value: 'depth' }, { label: 'brightness', value: 'brightness' }, { label: 'inflate', value: 'inflate' }]
const setSource = (v: string | string[]) => { source.value = v as HeightSourceName; commit(); if (v === 'depth' && !depthFn.value && kind.value === 'photo') void wantDepth() }
const mm = (v: number) => `${v.toFixed(2)} mm`
const WORD: Record<string, string> = { depth: 'the depth model', brightness: 'brightness', inflate: 'the inflated outline' }
const usedSource = computed(() => result.value?.source ?? source.value)
const needDepth = computed(() => kind.value === 'photo' && source.value === 'depth' && !depthFn.value)
const heightNote = computed(() => (kind.value === 'model' ? 'height from the posed model.' : needDepth.value ? 'depth is not loaded, so height comes from brightness for now.' : `height from ${WORD[usedSource.value] ?? usedSource.value}.`))

function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest?.('input,textarea,select,[contenteditable]')) return
  const t = TOOLS.find((x) => x.key === e.key.toLowerCase())
  if (t && img.value) { e.preventDefault(); setTool(t.id) }
}

onMounted(async () => {
  chipPick.value = pick
  document.addEventListener('keydown', onKey)
  // the test hook, for smokes and gates only
  if (STUB || import.meta.env.DEV) (window as unknown as { hbExplorer?: unknown }).hbExplorer = {
    pick, sample, openModel, exportAs, state: () => ({ kind: kind.value, source: result.value?.source, parts: parts.value.length, tris: stats.value?.tris ?? 0, open: stats.value?.open ?? -1, depth: !!depth.value, erased: erase.value?.reduce((a, v) => a + v, 0) ?? 0 }),
    set: (o: { colours?: number; split?: 'height' | 'colours'; source?: HeightSourceName }) => { if (o.colours) colours.value = o.colours; if (o.split) split.value = o.split; if (o.source) source.value = o.source; commit() },
  }
  if (STUB) {
    const s = await import('./stubs')
    pick.update({ env: s.FIXTURE_ENV, loader: s.stubLoader })
    return
  }
  pick.update({ env: await probe() })
  const store = await openWeightStore().catch(() => null)
  if (store) pick.update({ stored: await storedIds(store, jobRecords('depth')) })
})
onBeforeUnmount(() => {
  offPick(), clearTimeout(timer), stage?.dispose()
  wideQ.removeEventListener('change', onWide)
  document.removeEventListener('keydown', onKey)
  if (chipPick.value === pick) chipPick.value = null
})
</script>

<template>
  <HbCanvasRail v-model:tab="tab" class="xr" :tabs="TABS" rack-label="relief bench" tools-label="brush">
    <template #tools>
      <HbToolRail :model-value="tool" :tools="TOOLS" :keys="false" label="brush" @update:model-value="setTool" />
    </template>
    <input ref="fileIn" type="file" accept="image/*,.glb" hidden @change="takeFile(($event.target as HTMLInputElement).files?.[0])">
    <div v-if="!img" class="hb-lay-drop" @dragover.prevent @drop.prevent="takeFile($event.dataTransfer?.files[0])">
      <div class="hb-lay-empty">
        <p class="hb-lay-empty-name">a photo to a relief</p>
        <p class="hb-lay-empty-note">drop a photo or a glb model. depth, brightness or the model's own shape lifts it into a solid you can print in up to four colours. nothing leaves this tab.</p>
        <div class="hb-lay-empty-acts">
          <HbButton variant="go" @click="fileIn?.click()">open a photo or model</HbButton>
          <HbButton variant="secondary" @click="sample">try the sample</HbButton>
        </div>
      </div>
    </div>
    <template v-else>
      <div class="xr-views" :class="{ 'is-split': split3d }">
        <HbArtboard
          v-if="view === 'face'" v-model:selected="sel" v-model:tool="tool" class="xr-face" fill :width="img.width" :height="img.height" :layers="layers" :brush="{ size: brush }"
          :caption="`face, ${heightNote.replace(/\.$/, '')}`" :label="`${name} face`" @stroke="onStroke"
        />
        <div v-show="view !== 'face' || wide" ref="stageEl" class="xr-stage" />
      </div>
    </template>
    <template v-if="img" #inset>
      <div class="hb-cams xr-cams" role="group" aria-label="view">
        <button v-for="v in VIEWS" :key="v" type="button" :aria-pressed="view === v" @click="setView(v)">{{ v }}</button>
      </div>
    </template>

    <template v-if="img" #verbs>
      <HbButton v-if="canUndo" variant="ghost" size="sm" @click="undo">undo</HbButton>
      <HbButton v-if="canRedo" variant="ghost" size="sm" @click="redo">redo</HbButton>
      <HbButton v-if="needDepth" variant="go" size="sm" :loading="depthLoading" @click="wantDepth">{{ depthLabel }}</HbButton>
      <HbButton :variant="needDepth ? 'secondary' : 'go'" size="sm" @click="save('3mf')">save 3mf</HbButton>
    </template>

    <template #tab-art>
      <p v-if="note" class="hb-note" role="status">{{ note }}</p>
      <p v-if="err" class="hb-note is-err" role="alert">{{ err }}</p>
      <template v-if="img">
        <p class="hb-note">{{ name }}, {{ kind === 'model' ? 'a posed model' : `${img.width} by ${img.height}` }}. {{ heightNote }}</p>
        <HbChipGroup v-if="kind !== 'model'" :model-value="source" :options="SOURCES" label="height from" @update:model-value="setSource" />
        <HbButton v-if="needDepth" variant="go" size="sm" :loading="depthLoading" @click="wantDepth">{{ depthLabel }}</HbButton>
      </template>
      <p v-else class="hb-note">open a photo or a glb on the stage, or try the sample.</p>
      <template v-if="kind === 'model'">
        <HbChipGroup v-model="pose.up" :options="[{ label: 'y up', value: 'y' }, { label: 'z up', value: 'z' }]" label="up axis" />
        <HbSlider v-model="pose.yaw" label="turn" :min="-180" :max="180" :step="5" unit=" deg" />
        <HbSlider v-model="pose.pitch" label="tip" :min="-90" :max="90" :step="5" unit=" deg" />
        <HbSlider v-model="pose.roll" label="roll" :min="-180" :max="180" :step="5" unit=" deg" />
      </template>
      <HbButton v-if="img" variant="secondary" size="sm" @click="fileIn?.click()">open another</HbButton>
      <HbButton v-if="!img" variant="secondary" size="sm" @click="sample">try the sample</HbButton>
    </template>
    <template #tab-relief>
      <HbSlider v-model="params.width" label="width" :min="6" :max="100" :step="0.5" unit=" mm" @commit="commit" />
      <HbSlider v-model="params.base" label="base" :min="0" :max="6" :step="0.04" :format="mm" @commit="commit" />
      <HbSlider v-model="params.height" label="top" :min="0.4" :max="12" :step="0.04" :format="mm" @commit="commit" />
      <HbSlider v-if="source === 'inflate'" v-model="params.threshold" label="threshold" :min="0.05" :max="0.95" :step="0.05" @commit="commit" />
      <HbSlider v-else v-model="params.bgcut" label="background cut" :min="0" :max="0.9" :step="0.01" @commit="commit" />
      <HbSlider v-model="params.gamma" label="gamma" :min="0.3" :max="3" :step="0.05" @commit="commit" />
      <HbSlider v-model="params.smooth" label="smoothing" :min="0" :max="2" :step="0.05" unit=" mm" @commit="commit" />
      <HbCheckbox v-model="params.invert" @update:model-value="commit">invert</HbCheckbox>
      <HbCheckbox v-model="keepLargest" @update:model-value="commit">keep largest piece</HbCheckbox>
      <HbSlider v-model="brush" label="brush" :min="4" :max="120" unit=" px" />
      <HbButton v-if="erase || restore" variant="secondary" size="sm" @click="clearBrush">clear erase</HbButton>
    </template>
    <template #tab-colour>
      <HbChipGroup :model-value="String(colours)" :options="['1', '2', '3', '4']" label="colours" @update:model-value="colours = Number($event); commit()" />
      <HbChipGroup v-if="colours > 1" :model-value="split" :options="kind === 'photo' ? [{ label: 'terraces by height', value: 'height' }, { label: 'photo colours', value: 'colours' }] : [{ label: 'terraces by height', value: 'height' }]" label="split" @update:model-value="split = $event as 'height'; commit()" />
      <label v-for="i in Math.max(1, colours)" :key="i" class="xr-fil">
        <input v-model="fil[i - 1]" type="color" :aria-label="`filament ${i}`">
        <span>{{ i }} {{ i === 1 ? 'base' : split === 'height' ? `terrace ${i - 1}` : `colour ${i}` }}, petg</span>
      </label>
      <p class="hb-note">{{ parts.length }} bodies, one per filament slot in the 3mf.</p>
    </template>
    <template #tab-print>
      <dl v-if="stats" class="hb-kv">
        <dt>size</dt><dd>{{ stats.size.map((v) => v.toFixed(1)).join(' by ') }} mm</dd>
        <dt>volume</dt><dd>{{ (stats.vol / 1000).toFixed(2) }} cm3</dd>
        <dt>triangles</dt><dd>{{ stats.tris }}</dd>
        <dt>build</dt><dd>{{ ms }} ms</dd>
      </dl>
      <ul class="xr-checks">
        <li v-for="([t, x], i) in checks" :key="i" :class="`is-${t}`">{{ x }}</li>
      </ul>
      <HbSelect v-model="printer" :options="PRINTERS" label="printer and process" />
      <div class="hb-toolbar">
        <HbButton variant="secondary" size="sm" @click="save('3mf')">3mf project</HbButton>
        <HbButton variant="secondary" size="sm" @click="save('zip')">stl zip</HbButton>
        <HbButton variant="secondary" size="sm" @click="save('stl')">stl</HbButton>
        <HbButton variant="secondary" size="sm" @click="save('obj')">obj</HbButton>
        <HbButton variant="secondary" size="sm" @click="save('face')">faces png</HbButton>
        <HbButton variant="secondary" size="sm" @click="save('card')">print card png</HbButton>
        <HbButton v-if="depth" variant="secondary" size="sm" @click="save('depth')">depth png</HbButton>
      </div>
      <HbFold summary="where the numbers come from">
        <p class="hb-note">size, volume, triangles and the checks are computed from the mesh in this tab; the build time is measured here. the {{ NOZZLE }} mm nozzle and {{ LAYER }} mm layers are the printer maker's defaults.</p>
      </HbFold>
      <HbFold summary="designs">
        <HbButton variant="secondary" size="sm" @click="save('design')">save this design</HbButton>
        <label class="hb-btn hb-btn-secondary hb-btn-sm">open a design<input type="file" accept=".json" hidden @change="openDesign(($event.target as HTMLInputElement).files?.[0])"></label>
      </HbFold>
    </template>
    <template #detail>
      <p class="hb-note">keys: v look, e erase, r restore. drag pans the face, the wheel zooms; drag turns the 3d views. the photo never leaves this tab.</p>
    </template>
  </HbCanvasRail>
</template>

<style scoped>
.xr { height: calc(100dvh - 52px); }
.xr :deep(.hb-lay-verbs) { display: flex; gap: var(--hb-s-2, 8px); align-items: center; flex-wrap: wrap; }
.xr-views { position: absolute; inset: 0; display: flex; }
.xr-views > * { position: relative; flex: 1 1 0; min-width: 0; }
.xr-views.is-split > .xr-stage { border-left: 1.5px solid var(--hb-ink, #1a1a1a); }
/* the view row sits on the stage as the original's cams, not as a card */
.xr :deep(.hb-lay-inset) { width: auto; right: var(--hb-s3, 12px); left: auto; max-width: calc(100% - 24px); background: none; border: 0; box-shadow: none; pointer-events: none; }
.xr-cams { justify-content: flex-end; }
@media (max-width: 640px) { .xr :deep(.hb-lay-inset) { top: auto; bottom: 72px; } }
.xr-cams > button { pointer-events: auto; }
/* the original's face canvas has no zoom buttons: the wheel zooms, a drag pans */
.xr :deep(.hb-ab-zoom) { display: none; }
.xr-fil { display: flex; gap: var(--hb-s-2, 8px); align-items: center; margin: 4px 0; font-family: var(--hb-mono); font-size: 13px; }
.xr-fil input { width: 44px; height: 32px; border: 1.5px solid var(--hb-ink, #1a1a1a); padding: 0; }
.xr-checks { list-style: none; padding: 0; margin: 8px 0; font-size: 13px; }
.xr-checks li::before { content: 'ok '; font-family: var(--hb-mono); }
.xr-checks li.is-warn::before { content: 'check '; color: var(--hb-pink, #fe0386); }
.xr-checks li.is-err::before { content: 'fault '; color: var(--hb-red, #c3251f); }
</style>
