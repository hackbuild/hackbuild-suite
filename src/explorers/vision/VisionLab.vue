<script setup lang="ts">
// vision lab (rebuild plan 4): the arbor eyes tab and the hackle and mortise
// senses as one canvas and rail. The frame fills and what the models found
// is drawn on it; the rail picks what to look for (things at three detector
// sizes, a face, hands, a body, a gesture, a caption, a question); the rack
// holds what was found, the questions, the kept frames and the exports. A
// picture, the sample or the camera feeds it. Each look loads its model
// from the chip, or from the pink load button that names the size.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { HbButton, HbCanvasRail, HbHistoryStrip, HbInput, HbInstanceList, HbReadouts, HbSeg, HbToolRail, type HbHistoryItem, type HbRailTool, type HbReadoutRow } from '@virgilvox/hackbuild-ui'
import { instanceColour, saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { probe } from '@hackbuild/ai-env'
import { openWeightStore } from '@hackbuild/weights'
import { DETECT_SIZES } from '@hackbuild/vision'
import { jobLoader, jobRecords, storedIds, useModelPick, type AskFn, type DetectFn, type FrameBox, type FrameLandmarks, type FrameResults, type Job, type JobLoaderOptions, type ModelPick } from '@hackbuild/ai-views'
import { mountCameraFeed, type CameraFeed } from '@hackbuild/ai-views/elements'
import { FrameView } from '@hackbuild/ai-views/vue'
import { chipPick } from '../../shell/chip'
import { sampleCanvas } from './scene'

const STUB = new URLSearchParams(location.search).has('stub')

// one pick per job, on one shared hub
const OPTS: JobLoaderOptions = {}
const mk = (job: Job) => useModelPick(job, { loader: jobLoader(job, OPTS) })
const picks: Record<'detect' | 'landmarks' | 'vision', ModelPick> = { detect: mk('detect'), landmarks: mk('landmarks'), vision: mk('vision') }
const tick = ref(0)
const offs = Object.values(picks).map((p) => p.subscribe(() => tick.value++))

type Look = 'detect' | 'face' | 'hand' | 'pose' | 'gesture' | 'caption' | 'ask'
type Kind = 'face' | 'hand' | 'pose' | 'gesture'
const MARK: Record<Kind, string> = { face: 'face-landmarker', hand: 'hand-landmarker', pose: 'pose-landmarker-lite', gesture: 'gesture-recognizer' }
const TOOLS: HbRailTool[] = [
  { id: 'detect', label: 'find things', icon: 'crosshairs', key: 'd', hint: 'boxes round every thing the detector knows.' },
  { id: 'face', label: 'face points', icon: 'user', key: 'f', hint: 'the points of each face.' },
  { id: 'hand', label: 'hand points', icon: 'paw', key: 'h', hint: 'the joints of each hand.' },
  { id: 'pose', label: 'body points', icon: 'users', key: 'p', hint: 'the joints of each body.' },
  { id: 'gesture', label: 'gestures', icon: 'wave', key: 'g', hint: 'what each hand is doing.' },
  { id: 'caption', label: 'caption', icon: 'comment', key: 'c', hint: 'one line about the picture.' },
  { id: 'ask', label: 'ask', icon: 'question', key: 'q', hint: 'a question about the picture, in the ask tab.' },
]
const tool = ref<Look>('detect')
const jobOf = (t: Look) => (t === 'detect' ? 'detect' : t === 'caption' || t === 'ask' ? 'vision' : 'landmarks')
const pick = computed(() => picks[jobOf(tool.value)])
const snap = computed(() => (void tick.value, pick.value.snapshot()))
const row = computed(() => snap.value.row)
const loading = computed(() => row.value?.state === 'loading')
const ready = computed(() => !!snap.value.loaded)
function setTool(t: string) {
  tool.value = t as Look
  if (t in MARK) picks.landmarks.choose(MARK[t as Kind])
  chipPick.value = pick.value
  if (t === 'ask') tab.value = 'ask'
  else if (frame.value && ready.value) void look()
}

// detector sizes: yolov10 nano, small and medium (AGPL-3.0), sizes from the records
const SIZES = (Object.keys(DETECT_SIZES) as (keyof typeof DETECT_SIZES)[]).map((k) => {
  const r = jobRecords('detect').find((x) => x.id === DETECT_SIZES[k])
  const word = { n: 'nano', s: 'small', m: 'medium' }[k]
  return { label: `${word}${r?.sizeMB ? `, ${Math.round(r.sizeMB)} mb` : ''}`, value: DETECT_SIZES[k] }
})
const size = computed({
  get: () => (void tick.value, picks.detect.snapshot().chosen),
  set: (id: string) => {
    picks.detect.choose(id)
    if (frame.value && picks.detect.snapshot().loaded) void look()
  },
})

// the frame: a picture, the sample, or the camera
const frame = shallowRef<HTMLCanvasElement | null>(null)
const name = ref('')
const live = ref(false)
let feed: CameraFeed | null = null
const feedHost = ref<HTMLElement | null>(null)
const source = computed(() => (live.value && feed ? feed.video : frame.value))
const fileIn = ref<HTMLInputElement | null>(null)
function fit(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const k = Math.min(1, 1024 / Math.max(w, h))
  const c = document.createElement('canvas')
  c.width = Math.round(w * k)
  c.height = Math.round(h * k)
  c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height)
  return c
}
async function openFile(f: File | Blob | undefined, label = 'picture') {
  if (!f) return
  const url = URL.createObjectURL(f)
  try {
    const img = new Image()
    img.src = url
    await img.decode()
    show(fit(img, img.naturalWidth, img.naturalHeight), (f as File).name || label)
  } catch {
    note.value = 'that file does not open as a picture. try a png or a jpeg.'
  } finally {
    URL.revokeObjectURL(url)
  }
}
function show(c: HTMLCanvasElement, n: string) {
  if (live.value) stopCamera()
  frame.value = c
  name.value = n
  found.value = { boxes: [], marks: {}, caption: '' }
  answers.value = []
  if (ready.value && tool.value !== 'ask') void look()
}
const sample = () => show(sampleCanvas(), 'sample')
const onDrop = (e: DragEvent) => { e.preventDefault(); void openFile(e.dataTransfer?.files[0]) }
const onPaste = (e: ClipboardEvent) => { const f = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/')); if (f) void openFile(f, 'pasted') }

async function startCamera() {
  if (!feedHost.value) return
  feed ??= mountCameraFeed(feedHost.value, { fps: 6, tile: false, onFrame: (v) => step(v) })
  try {
    await feed.start()
    live.value = feed.live
    if (!live.value) note.value = 'the camera did not open. allow it in the address bar, or open a picture.'
    else { name.value = 'camera'; found.value = { boxes: [], marks: {}, caption: '' } }
  } catch (e) {
    note.value = `the camera did not open: ${e instanceof Error ? e.message : String(e)}. open a picture instead.`
  }
}
function stopCamera() {
  feed?.stop()
  live.value = false
}
/** Keep the live frame as a still with what was found on it. */
function keep() {
  const v = feed?.video
  if (!v?.videoWidth) return
  const c = fit(v, v.videoWidth, v.videoHeight)
  const r = found.value
  stopCamera()
  frame.value = c
  name.value = `camera ${new Date().toLocaleTimeString()}`
  found.value = r
  remember()
}

// what was found, drawn on the frame
interface Found { boxes: FrameBox[]; marks: Partial<Record<Kind, FrameLandmarks[]>>; caption: string; gestures?: string }
const found = shallowRef<Found>({ boxes: [], marks: {}, caption: '' })
const ms = ref<Partial<Record<Look, number>>>({})
const busy = ref(false)
const note = ref('')
const results = computed<FrameResults>(() => ({
  boxes: found.value.boxes,
  landmarks: Object.values(found.value.marks).flat() as FrameLandmarks[],
  ...(found.value.caption ? { caption: found.value.caption } : {}),
}))
const toMarks = (pts: [number, number, number][][], w: number, h: number, label: string): FrameLandmarks[] => pts.map((set) => ({ label, points: set.map(([x, y]) => ({ x: x * w, y: y * h })) }))
const dims = (s: HTMLCanvasElement | HTMLVideoElement) => (s instanceof HTMLVideoElement ? { w: s.videoWidth, h: s.videoHeight } : { w: s.width, h: s.height })

/** One look with the picked tool on a source; returns the new results. */
async function run(t: Look, src: HTMLCanvasElement | HTMLVideoElement, prev: Found): Promise<Found> {
  const m = pick.value.snapshot().loaded
  if (!m) return prev
  const t0 = performance.now()
  const { w, h } = dims(src)
  let next = prev
  if (t === 'detect') next = { ...prev, boxes: await (m as DetectFn)(src) }
  else if (t === 'caption') next = { ...prev, caption: (await (m as AskFn)(src)).trim() }
  else if (t !== 'ask') {
    const l = await (m as { detect(i: unknown): Promise<{ points: [number, number, number][][]; gestures?: ({ name: string; score: number } | null)[] }> }).detect(src)
    const g = (l.gestures ?? []).filter(Boolean).map((x) => `${x!.name.replace(/_/g, ' ').toLowerCase()} ${Math.round(x!.score * 100)}%`).join(', ')
    next = { ...prev, marks: { ...prev.marks, [t]: toMarks(l.points, w, h, t) }, ...(t === 'gesture' ? { gestures: g || 'no hand found' } : {}) }
  }
  ms.value = { ...ms.value, [t]: Math.round(performance.now() - t0) }
  return next
}
async function look() {
  const src = frame.value
  if (!src || busy.value || tool.value === 'ask') return
  busy.value = true
  try {
    found.value = await run(tool.value, src, found.value)
    note.value = ''
  } catch (e) {
    note.value = `${row.value?.name ?? 'the model'} failed on this picture: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}
let stepping = false
async function step(v: HTMLVideoElement) {
  if (stepping || tool.value === 'caption' || tool.value === 'ask' || !ready.value) return
  stepping = true
  try { found.value = await run(tool.value, v, found.value) } catch { /* a dropped frame */ } finally { stepping = false }
}
async function load() {
  note.value = `loading ${row.value?.name ?? 'the model'}, ${row.value?.size ?? 'size unknown'}.`
  try {
    await pick.value.load()
    note.value = pick.value.error(pick.value.snapshot().chosen) ?? ''
    if (frame.value) await look()
  } catch (e) {
    note.value = `the model did not load: ${e instanceof Error ? e.message : String(e)}.`
  }
}
const pinkLabel = computed(() => (loading.value ? `loading ${row.value?.name ?? ''}` : ready.value ? 'look again' : `load ${row.value?.name ?? 'a model'}, ${row.value?.size ?? 'size unknown'}`))
const pinkAct = () => (ready.value ? (live.value ? keep() : void look()) : void load())

// found list and timing
const items = computed(() => [
  ...found.value.boxes.map((b, i) => ({ id: `b${i}`, colour: instanceColour(i), label: b.label ?? 'thing', score: b.score ?? null })),
  ...Object.entries(found.value.marks).map(([k, sets], i) => ({ id: k, colour: instanceColour(found.value.boxes.length + i), label: `${k}, ${sets!.length} found, ${sets!.reduce((n, s) => n + s.points.length, 0)} points`, score: null })),
])
const timing = computed<HbReadoutRow[]>(() => Object.entries(ms.value).map(([k, v]) => ({ label: k, value: v ?? 0, unit: 'ms' })))

// ask: a question about the frame; the answer joins the caption on the frame
const question = ref('')
const answers = ref<{ q: string; a: string; ms: number }[]>([])
async function askNow() {
  const q = question.value.trim()
  const src = frame.value
  if (!q || !src) return
  if (!picks.vision.snapshot().loaded) {
    tool.value = 'ask'
    chipPick.value = picks.vision
    return void load()
  }
  busy.value = true
  const t0 = performance.now()
  try {
    const a = (await (picks.vision.snapshot().loaded as AskFn)(src, q)).trim()
    answers.value = [{ q, a, ms: Math.round(performance.now() - t0) }, ...answers.value]
    found.value = { ...found.value, caption: a }
    question.value = ''
  } catch (e) {
    note.value = `the question failed: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
  }
}

// kept frames: a press brings the frame and what was found back
const kept = ref<{ id: string; thumb: string; name: string; canvas: HTMLCanvasElement; found: Found }[]>([])
function remember() {
  const c = frame.value
  if (!c) return
  const t = fit(c, c.width, c.height)
  kept.value = [{ id: Date.now().toString(36), thumb: t.toDataURL('image/jpeg', 0.7), name: name.value, canvas: c, found: found.value }, ...kept.value].slice(0, 24)
}
const history = computed<HbHistoryItem[]>(() => kept.value.map((k) => ({ id: k.id, thumb: k.thumb, label: k.name, meta: `${k.found.boxes.length} found` })))
function restore(it: HbHistoryItem) {
  const k = kept.value.find((x) => x.id === it.id)
  if (!k) return
  stopCamera()
  frame.value = k.canvas
  name.value = k.name
  found.value = k.found
}

// exports: the frame with its marks drawn in, and the results as json
function seenPng() {
  const c = frame.value
  if (!c) return
  const o = fit(c, c.width, c.height)
  const x = o.getContext('2d')!
  x.lineWidth = Math.max(2, o.width / 320)
  x.font = `${Math.max(12, o.width / 40)}px monospace`
  found.value.boxes.forEach((b, i) => {
    x.strokeStyle = x.fillStyle = instanceColour(i)
    x.strokeRect(b.x, b.y, b.w, b.h)
    x.fillText(`${b.label ?? ''} ${Math.round((b.score ?? 0) * 100)}`, b.x + 4, b.y + 16)
  })
  results.value.landmarks?.forEach((l, i) => { x.fillStyle = instanceColour(found.value.boxes.length + i); for (const p of l.points) x.fillRect(p.x - 2, p.y - 2, 4, 4) })
  o.toBlob((b) => b && saveFile(`${name.value || 'frame'}.seen.png`, b))
}
const resultsJson = () => saveFile(`${name.value || 'frame'}.json`, new Blob([JSON.stringify({ name: name.value, ...found.value, answers: answers.value, ms: ms.value }, null, 2)], { type: 'application/json' }))
const hasResult = computed(() => items.value.length > 0 || !!found.value.caption)

const tab = ref('found')
const TABS = [
  { id: 'found', label: 'found' },
  { id: 'ask', label: 'ask' },
  { id: 'kept', label: 'kept' },
  { id: 'export', label: 'export' },
]

// keys: the rail letters, space looks again or keeps the live frame; m stays the bar's
function onKey(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey || e.altKey || (e.target as HTMLElement).closest?.('input,textarea,select,[contenteditable]')) return
  const k = e.key.toLowerCase()
  const t = TOOLS.find((x) => x.key === k)
  if (t) { e.preventDefault(); setTool(t.id) } else if (k === ' ' && frame.value) { e.preventDefault(); pinkAct() }
}

onMounted(async () => {
  chipPick.value = pick.value
  document.addEventListener('keydown', onKey)
  document.addEventListener('paste', onPaste)
  // the test hook, for smokes and gates only
  if (STUB || import.meta.env.DEV) (window as unknown as { hbExplorer?: unknown }).hbExplorer = { picks, sample, setTool, look, load, askNow, ask: (q: string) => ((question.value = q), askNow()), state: () => ({ tool: tool.value, found: found.value, answers: answers.value, kept: kept.value.length, ready: ready.value }), remember }
  if (STUB) {
    const s = await import('./stubs')
    for (const p of Object.values(picks)) p.update({ env: s.FIXTURE_ENV, loader: s.stubLoader })
    picks.detect.choose(DETECT_SIZES.n)
    return
  }
  const env = await probe()
  OPTS.env = env
  for (const p of Object.values(picks)) p.update({ env })
  const store = await openWeightStore().catch(() => null)
  if (store) for (const [j, p] of Object.entries(picks)) p.update({ stored: await storedIds(store, jobRecords(j as Job)) })
})
onBeforeUnmount(() => {
  offs.forEach((f) => f())
  stopCamera()
  feed?.dispose()
  document.removeEventListener('keydown', onKey)
  document.removeEventListener('paste', onPaste)
  if (chipPick.value && Object.values(picks).includes(chipPick.value)) chipPick.value = null
})
</script>

<template>
  <HbCanvasRail v-model:tab="tab" class="xv" :tabs="TABS" rack-label="vision lab" tools-label="what to look for">
    <template #tools>
      <HbToolRail :model-value="tool" :tools="TOOLS" :keys="false" label="what to look for" @update:model-value="setTool" />
    </template>
    <div class="xv-subject" @dragover.prevent @drop="onDrop">
      <div v-if="!frame && !live" class="hb-lay-empty">
        <span class="hb-lay-empty-name">drop an image</span>
        <p class="hb-lay-empty-note">or paste one, or turn the camera on. boxes, points and words land on the picture, which never leaves this tab.</p>
        <div class="hb-lay-empty-acts">
          <button type="button" class="hb-btn hb-btn-go" @click="fileIn?.click()">open an image</button>
          <button type="button" class="hb-btn" @click="sample">try the sample</button>
          <button type="button" class="hb-btn" @click="startCamera">camera</button>
        </div>
      </div>
      <FrameView v-show="frame || live" :source="source" :results="results" :mirror="live" />
      <div ref="feedHost" hidden />
      <input ref="fileIn" type="file" accept="image/*" hidden @change="openFile(($event.target as HTMLInputElement).files?.[0])">
    </div>
    <template v-if="frame || live" #verbs>
      <HbSeg v-if="tool === 'detect'" v-model="size" :options="SIZES" aria-label="detector size" />
      <HbButton variant="go" :loading="loading || busy" @click="pinkAct">{{ live && ready ? 'keep this frame' : pinkLabel }}</HbButton>
      <HbButton @click="live ? stopCamera() : startCamera()">{{ live ? 'camera off' : 'camera' }}</HbButton>
    </template>

    <template #tab-found>
      <p v-if="note" class="hb-note" role="status">{{ note }}</p>
      <p v-if="found.caption" class="xv-caption">{{ found.caption }}</p>
      <p v-if="found.gestures" class="hb-note">gesture: {{ found.gestures }}</p>
      <HbInstanceList :items="items" bare :empty="frame || live ? 'nothing found yet. pick a tool on the left, or look again.' : 'open an image, try the sample, or turn the camera on.'" />
      <HbReadouts v-if="timing.length" :rows="timing" />
      <HbButton v-if="frame && hasResult && !live" @click="remember">keep this frame</HbButton>
      <HbButton v-if="frame || live" @click="fileIn?.click()">another image</HbButton>
    </template>
    <template #tab-ask>
      <HbInput v-model="question" aria-label="a question about the picture" placeholder="what is on the desk" @keydown.enter="askNow" />
      <HbButton v-if="frame && question.trim()" :loading="busy" @click="askNow">ask</HbButton>
      <p v-if="!frame" class="hb-note">open an image first. the answer comes from {{ picks.vision.snapshot().row?.name ?? 'a vision model' }}, {{ picks.vision.snapshot().row?.size ?? 'size unknown' }}.</p>
      <dl class="xv-answers">
        <template v-for="a in answers" :key="a.q + a.ms"><dt>{{ a.q }}</dt><dd>{{ a.a }} <span class="hb-note">{{ a.ms }} ms</span></dd></template>
      </dl>
    </template>
    <template #tab-kept>
      <HbHistoryStrip :items="history" :current="null" empty="kept frames land here. a press brings one back with what was found." @restore="restore" />
    </template>
    <template #tab-export>
      <template v-if="frame && hasResult">
        <HbButton @click="seenPng">picture with marks, png</HbButton>
        <HbButton @click="resultsJson">results, json</HbButton>
      </template>
      <p v-else class="hb-note">exports appear once something is found.</p>
    </template>
    <template #detail>
      <p class="hb-note">keys: d things, f face, h hands, p body, g gestures, c caption, q ask, space looks again or keeps the live frame. the yolov10 detectors are agpl-3.0; face, hand and body points run on mediapipe (apache-2.0); captions and questions on smolvlm, lfm2-vl or gemma 4 e2b.</p>
    </template>
  </HbCanvasRail>
</template>

<style scoped>
.xv { height: calc(100dvh - 52px); }
.xv :deep(.hb-lay-verbs) { display: flex; gap: var(--hb-s-2, 8px); align-items: center; flex-wrap: wrap; }
.xv-subject { position: absolute; inset: 0; }
.xv-subject :deep(.hb-frameview) { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; padding: var(--hb-s-3, 12px) var(--hb-s-3, 12px) 72px; box-sizing: border-box; }
.xv-subject :deep(.hb-camtile) { width: min(100%, calc((100dvh - 148px) * (var(--hb-camtile-ar, 4 / 3)))); margin: 0; }
.xv-caption { margin: 0 0 var(--hb-s-3, 12px); font-family: var(--hb-note); font-size: 15px; line-height: 1.4; }
.xv-answers { margin: var(--hb-s-3, 12px) 0 0; }
.xv-answers dt { font-weight: 600; margin-top: var(--hb-s-2, 8px); }
.xv-answers dd { margin: 2px 0 0; }
</style>
