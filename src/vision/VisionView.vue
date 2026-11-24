<script setup lang="ts">
// The vision tool (design 3.4). An image comes in through the slot
// (upload, camera capture, paste, the sample scene, or a drop anywhere);
// the tasks picked on the chips run on that exact frame and what they found
// is drawn over it. Live mode runs the detector on the camera through a
// perception loop with a cadence readout. Every frame and its results land
// in the session document, newest first.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbButton, HbCameraTile, HbChipGroup, HbHistoryStrip, HbHow, HbImageSlot, HbInput, HbInset, HbInstanceList, HbMonitorDock, HbPanel, HbSelect,
  HbStatusLine, HbStatusList, HbTimelineItem, HbToolbar, useHotkeys,
  type HbHistoryItem, type HbImageValue, type HbInstanceItem, type HbMonitorView, type HbStatusItem,
} from '@virgilvox/hackbuild-ui'
import { cameraFault, closeCamera, instanceColour, openCamera, saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { ask, caption, detect, landmarks, perceptionLoop, type Loop } from '@hackbuild/vision'
import type { ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, usePrimary, useStop } from '../shell/shell.ts'
import { exportDoc, pickFiles, useDocument, ws } from '../workspace/state'
import {
  bearing, capOf, captureMeta, LANDMARK_KINDS, newSession, TASKS, VISION_KIND, withCapture,
  type Capture, type Found, type LandmarkKind, type Task, type VisionBody,
} from './kind.ts'
import { drawSeen, fitCanvas, frameOf, readFrame, registerVision, tone } from './frame.ts'
import { addVisionRuntimes, drawScene } from './runtimes.ts'
import SendTo from '../shell/SendTo.vue'
import type { SendOffer } from '../workspace/sendto'

registerVision()

const route = useRoute()
const doc = useDocument<VisionBody>(VISION_KIND)
const body = computed<VisionBody>(() => doc.doc.value?.body ?? newSession())
const current = computed<Capture | null>(() => body.value.captures.find((c) => c.id === body.value.current) ?? body.value.captures[0] ?? null)
const editCapture = (id: string, fn: (c: Capture) => void) => doc.edit((b) => { const c = b.captures.find((x) => x.id === id); if (c) fn(c) })

const EMPTY = 'drop or paste an image, or turn the camera on. the sample scene needs neither.'
const status = ref<{ text: string; kind: 'none' | 'ok' | 'warn' | 'err' | 'info' | 'busy' }>({ text: EMPTY, kind: 'info' })
const say = (text: string, kind: typeof status.value.kind = 'info') => { status.value = { text, kind } }

// Tasks: chips with a distinct off chip (P-CAM-4), keys 1 to 4.
const taskOptions = TASKS.map((t, i) => ({ label: t, value: t, key: String(i + 1) }))
const tasks = computed({ get: () => body.value.tasks as string[], set: (v: string[]) => doc.edit((b) => { b.tasks = TASKS.filter((t) => v.includes(t)) }) })
const lmKind = computed({ get: () => body.value.landmarks, set: (v: LandmarkKind) => doc.edit((b) => { b.landmarks = v }) })
const lmOptions = LANDMARK_KINDS.map((k) => ({ value: k, label: k }))

// One record per task, routed on the hub; state dots per model (P-CAM-7).
const booted = ref(false)
const recordOf = (t: Task): ModelRecord | null => {
  void hub.allRecords.value
  if (!booted.value) return null
  const env = hub.env.value
  return hub.registry.route({ provides: capOf(t, body.value.landmarks), ...(env ? { env } : {}) }) ?? null
}
const stateOf = (r: ModelRecord | null) => (r ? hub.states.value[r.id]?.state ?? 'none' : 'none')
const ready = (t: Task) => ['loaded', 'stored'].includes(stateOf(recordOf(t)))
const sizeWord = (r: ModelRecord) => (r.sizeMB === null ? 'size unknown' : r.sizeMB === 0 ? 'no download' : `${Math.round(r.sizeMB)} mb (${r.sizeSource})`)
const lastMs = ref<Partial<Record<Task, number>>>({})
const taskRows = computed<HbStatusItem[]>(() =>
  (body.value.tasks as Task[]).map((t) => {
    const r = recordOf(t)
    const label = t === 'landmarks' ? `landmarks, ${body.value.landmarks}` : t
    if (!r) return { key: t, label, state: 'warn' as const, title: hub.env.value && !hub.env.value.webgpu && t !== 'detect' && t !== 'landmarks' ? 'no webgpu adapter. captions are off here.' : 'no model for this task here.' }
    const s = stateOf(r)
    const ms = lastMs.value[t]
    const fault = hub.states.value[r.id]?.error
    return {
      key: t,
      label,
      state: s === 'loaded' || s === 'stored' ? 'ok' as const : s === 'downloading' ? 'load' as const : s === 'fault' ? 'err' as const : 'off' as const,
      title: s === 'fault' ? `${fault ?? 'the model failed to load'}.` : `${r.label ?? r.id}, ${sizeWord(r)}.${ms === undefined ? '' : ` ${Math.round(ms)} ms a frame (measured).`}`,
    }
  }),
)
/** First use of a task loads its model from a button that names the size. */
const toLoad = computed(() =>
  (body.value.tasks as Task[]).map((t) => ({ t, r: recordOf(t) })).filter((x): x is { t: Task; r: ModelRecord } => !!x.r && !ready(x.t))
    .filter((x, i, all) => all.findIndex((y) => y.r.id === x.r.id) === i),
)
const loadLabel = (r: ModelRecord) => (stateOf(r) === 'downloading' ? `loading ${r.label ?? r.id}` : `load ${r.label ?? r.id}, ${sizeWord(r)}`)
function loadOne(r: ModelRecord): void {
  say(`loading ${r.label ?? r.id}, ${sizeWord(r)}. the other tasks wait for their own model.`, 'busy')
  void hub.load(r.id).then(() => {
    if (stateOf(r) === 'fault') say(`${r.label ?? r.id} failed to load. ${(body.value.tasks as Task[]).filter((t) => ready(t)).join(' and ') || 'nothing else'} still runs.`, 'err')
    else if (current.value) void runAll()
  })
}

// Input: the slot's value becomes a capture.
const input = shallowRef<HbImageValue | null>(null)
const sample = ref<{ url: string; name: string } | null>(null)
const slotInfo = computed(() => {
  const c = current.value
  if (!c) return ''
  return c.found.length ? `${c.found.length} found: ${[...new Set(c.found.map((f) => f.label))].join(', ')}` : c.caption ?? `${c.width} by ${c.height}`
})
watch(input, async (v) => {
  if (!v) return
  try {
    await docReady
    const f = await readFrame(v.blob ?? v.url)
    const c: Capture = { id: Date.now().toString(36), name: v.name || 'image', at: Date.now(), from: v.from, ...f, found: [], points: [], caption: null, answers: [], ms: {}, models: [] }
    doc.edit((b) => withCapture(b, c))
    await runAll()
  } catch (err) {
    say(err instanceof Error ? err.message : String(err), 'err')
  }
})

// Send to (design 1.2): the frame as an image, the caption as text.
const offers = computed<SendOffer[]>(() => {
  const c = current.value
  return [
    { type: 'image', what: 'image', ready: !!c, get: () => (c ? { type: 'image', name: c.name, frame: { image: c.image, width: c.width, height: c.height } } : null) },
    { type: 'text', what: 'caption', ready: !!c?.caption, get: () => (c?.caption ? { type: 'text', name: `${c.name} caption`, text: c.caption } : null) },
  ]
})

// Run: each picked task on the current frame; one that fails leaves the rest running.
const running = ref(false)
async function runAll(): Promise<void> {
  const c = current.value
  if (!c) return say(EMPTY)
  await bootReady
  const want = (body.value.tasks as Task[]).filter((t) => t !== 'ask')
  const go = want.filter(ready)
  const wait = want.filter((t) => !ready(t))
  if (!go.length) return say(want.length ? `load a model first: ${wait.join(', ')} ${wait.length === 1 ? 'waits' : 'wait'} for a press on its load button.` : 'pick a task: detect, landmarks or caption.', 'warn')
  running.value = true
  say(`running ${go.join(', ')} on ${c.name}.`, 'busy')
  const frame = await frameOf(c)
  const h = hub.hub()
  const failed: string[] = []
  for (const t of go) {
    const r = recordOf(t)!
    const t0 = performance.now()
    try {
      if (t === 'detect') {
        const d = await detect(h, frame, { model: r.id, scoreThreshold: 0.3, maxResults: 20 })
        const found: Found[] = d.map((x) => ({ label: x.label, score: x.score, box: x.box }))
        editCapture(c.id, (x) => { x.found = found })
      } else if (t === 'landmarks') {
        const kind = body.value.landmarks
        const l = await landmarks(h, kind, frame, { model: r.id })
        editCapture(c.id, (x) => { x.points = [...x.points.filter((p) => p.kind !== kind), { kind, sets: l.points, source: l.source }] })
      } else if (t === 'caption') {
        const text = await caption(h, frame, { model: r.id, maxTokens: 40 })
        editCapture(c.id, (x) => { x.caption = text.trim() })
      }
      const ms = performance.now() - t0
      lastMs.value = { ...lastMs.value, [t]: ms }
      editCapture(c.id, (x) => { x.ms[t] = Math.round(ms); if (!x.models.includes(r.id)) x.models.push(r.id) })
    } catch (err) {
      failed.push(t)
      logEvent('fail', `vision: ${t} on ${r.label ?? r.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  running.value = false
  await paint()
  const done = go.filter((t) => !failed.includes(t))
  const tail = wait.length ? ` ${wait.join(', ')} ${wait.length === 1 ? 'waits' : 'wait'} for its model.` : ''
  if (failed.length) say(`the ${failed.join(' and ')} model failed. ${done.length ? `${done.join(' and ')} still ran.` : 'drop another image or load another model.'}${tail}`, 'err')
  else say(`${current.value?.found.length ?? 0} found on ${c.name}${current.value?.caption ? `: ${current.value.caption}` : ''}.${tail}`, 'ok')
}

// Ask: a question about the frame; the step card shows the frame the model saw (P-TRACE-5).
const question = computed({ get: () => body.value.question, set: (v: string) => { if (v !== body.value.question) doc.edit((b) => { b.question = v }) } })
const asking = ref(false)
async function askNow(): Promise<void> {
  const c = current.value
  const q = body.value.question.trim()
  if (!c || !q) return say(c ? 'type a question about the frame.' : EMPTY, 'warn')
  if (!tasks.value.includes('ask')) tasks.value = [...tasks.value, 'ask']
  await bootReady
  const r = recordOf('ask')
  if (!r || !ready('ask')) return say(r ? `load ${r.label ?? r.id} first, ${sizeWord(r)}.` : 'no model answers questions here. captions need webgpu.', 'warn')
  asking.value = true
  const t0 = performance.now()
  try {
    const a = await ask(hub.hub(), await frameOf(c), q, { model: r.id, maxTokens: 64 })
    const ms = Math.round(performance.now() - t0)
    editCapture(c.id, (x) => { x.answers.push({ question: q, answer: a.trim(), at: Date.now(), ms, model: r.id }); if (!x.models.includes(r.id)) x.models.push(r.id) })
    say(`answered in ${ms} ms (measured).`, 'ok')
  } catch (err) {
    say(`the question model failed: ${err instanceof Error ? err.message : String(err)}. detection still runs.`, 'err')
  } finally {
    asking.value = false
  }
}

// The seen view: the frame with what was found drawn over it.
const seen = ref<HTMLCanvasElement | null>(null)
async function paint(): Promise<void> {
  await nextTick()
  const c = current.value
  if (!c || !seen.value || live.value) return
  drawSeen(seen.value, await frameOf(c), c.width, c.height, c.found, c.points)
}
watch(() => [current.value, seen.value], () => void paint())

// Found list beside the feed with bearing and score (P-CAM-8).
const foundItems = computed<HbInstanceItem[]>(() => {
  const list = live.value ? liveFound.value : current.value?.found ?? []
  const w = live.value ? liveSize.value.width : current.value?.width ?? 1
  return list.map((f, i) => ({ id: i, colour: instanceColour(i), label: `${f.label}, ${bearing(f.box, w)}`, score: f.score, hidden: !!f.hidden }))
})
const toggleFound = (it: HbInstanceItem) => current.value && editCapture(current.value.id, (c) => { const f = c.found[it.id as number]; if (f) f.hidden = !f.hidden })
const removeFound = (it: HbInstanceItem) => current.value && editCapture(current.value.id, (c) => { c.found.splice(it.id as number, 1) })

// Live: the camera through a perception loop with a cadence readout (P-CAM-3, P-CAM-5).
const live = ref(false)
const stream = shallowRef<MediaStream | null>(null)
const denied = ref(false)
const deniedText = ref('')
const liveFound = shallowRef<Found[]>([])
const liveSize = ref({ width: 1, height: 1 })
const cadence = ref('')
let loop: Loop | null = null
let work: HTMLCanvasElement | null = null
let spare: HTMLCanvasElement | null = null
const tileBox = ref<HTMLElement | null>(null)
const videoEl = () => tileBox.value?.querySelector('video') ?? null
async function startLive(): Promise<void> {
  if (live.value) return
  try {
    stream.value = await openCamera({ facingMode: 'user', width: { ideal: 640 } })
  } catch (err) {
    const f = cameraFault(err)
    denied.value = true
    deniedText.value = f.kind === 'denied' ? 'the camera is blocked for this site. allow it in the address bar, or drop an image.' : f.kind === 'missing' ? 'no camera found. drop or paste an image.' : f.text
    return say(deniedText.value, 'err')
  }
  denied.value = false
  live.value = true
  if (!open.value.includes('camera')) open.value = ['camera', ...open.value]
  await nextTick()
  await bootReady
  const r = recordOf('detect')
  if (!r || !ready('detect')) say(r ? `camera on. load ${r.label ?? r.id} to see boxes, ${sizeWord(r)}.` : 'camera on. no detector here.', 'warn')
  else say('camera on. space keeps a frame.', 'ok')
  let t0 = performance.now()
  loop = perceptionLoop<Found[] | null>({
    interval: (last) => Math.max(100, last * 1.5),
    step: async () => {
      const v = videoEl()
      if (!v || v.readyState < 2 || !v.videoWidth) return null
      // two canvases in turn: the one the models read is never the one being drawn
      const f = fitCanvas(v, v.videoWidth, v.videoHeight, spare)
      spare = work
      work = f
      liveSize.value = { width: f.width, height: f.height }
      const det = recordOf('detect')
      if (!det || !ready('detect')) return []
      const d = await detect(hub.hub(), f, { model: det.id, scoreThreshold: 0.3, maxResults: 20 })
      return d.map((x) => ({ label: x.label, score: x.score, box: x.box }))
    },
    onResult: (found, ms) => {
      if (!found || !work) return
      liveFound.value = found
      if (seen.value) drawSeen(seen.value, work, work.width, work.height, found, [])
      const now = performance.now()
      cadence.value = `${Math.round(1000 / Math.max(1, now - t0))} hz, ${Math.round(ms)} ms a step`
      t0 = now
    },
    onError: (err) => logEvent('fail', `vision: live step: ${err instanceof Error ? err.message : String(err)}`),
  })
}
function stopLive(): void {
  loop?.stop()
  loop = null
  closeCamera(stream.value)
  stream.value = null
  live.value = false
  liveFound.value = []
  cadence.value = ''
  open.value = open.value.filter((k) => k !== 'camera')
  void paint()
}
/** Keep the live frame as a capture with what the detector saw on it. */
function keepFrame(): void {
  if (!work) return say('the camera has no frame yet.', 'warn')
  const c: Capture = {
    id: Date.now().toString(36), name: `camera ${new Date().toLocaleTimeString()}`, at: Date.now(), from: 'live',
    image: work.toDataURL('image/jpeg', 0.85), width: work.width, height: work.height,
    found: liveFound.value, points: [], caption: null, answers: [], ms: {}, models: [],
  }
  doc.edit((b) => withCapture(b, c))
  say(`kept a frame with ${c.found.length} found.`, 'ok')
}
const tags = computed(() => ({
  tl: { text: 'camera on', tone: 'rec' as const },
  br: cadence.value ? { text: cadence.value, tone: 'ok' as const } : { text: 'detector off', tone: 'dim' as const },
}))

// Monitors: the camera and the model's view side by side from 768 px (P-CAM-3).
const open = ref<string[]>(['camera', 'seen'])
const ratio = computed(() => (live.value ? `${liveSize.value.width} / ${liveSize.value.height}` : current.value ? `${current.value.width} / ${current.value.height}` : '4 / 3'))
const views = computed<HbMonitorView[]>(() => [
  ...(live.value || denied.value ? [{ key: 'camera', title: 'camera', aux: live.value ? 'live' : 'blocked', ratio: '4 / 3' }] : []),
  { key: 'seen', title: 'seen', aux: live.value ? `${liveFound.value.length} found` : current.value ? `${current.value.found.length} found` : '', ratio: ratio.value },
])

// History: captures, newest first; a press brings one back.
const history = computed<HbHistoryItem[]>(() => body.value.captures.map((c) => ({ id: c.id, thumb: c.image, label: c.name, meta: captureMeta(c) })))
const restore = (it: HbHistoryItem) => doc.edit((b) => { b.current = String(it.id) })
const removeCapture = (it: HbHistoryItem) => doc.edit((b) => { b.captures = b.captures.filter((c) => c.id !== it.id); if (b.current === it.id) b.current = b.captures[0]?.id ?? null })

// Export: the annotated frame as png, the results as json, the session as its file.
function exportPng(): void {
  const c = current.value
  if (!c || !seen.value) return say('nothing to export yet. drop an image first.', 'warn')
  seen.value.toBlob((b) => { if (b) saveFile(`${c.name}.seen.png`, b, 'image/png') }, 'image/png')
}
const exportResults = () => doc.doc.value && void exportDoc(doc.doc.value.id, { format: 'results' })
const exportSession = () => doc.doc.value && void exportDoc(doc.doc.value.id)

// Keys: ctrl+enter runs, c camera, space keeps a live frame or runs again, esc stops live.
usePrimary(() => void runAll())
useStop(() => { if (live.value) stopLive() })
useHotkeys([
  { keys: 'c', label: 'camera on or off', group: 'tool', run: () => void (live.value ? stopLive() : startLive()) },
  { keys: 'space', label: 'keep the live frame, or run again', group: 'tool', run: () => void (live.value ? keepFrame() : runAll()) },
])

const HOW = `import { probe } from "@hackbuild/ai-env";
import { createHub, createRegistry } from "@hackbuild/models";
import { loadTransformers } from "@hackbuild/devices";
import { attachVision, caption, detect } from "@hackbuild/vision";

const hub = createHub({ registry: createRegistry(), env: await probe() });
attachVision(hub, await loadTransformers());
const boxes = await detect(hub, image);
const text = await caption(hub, image, { maxTokens: 40 });`

let docDone!: () => void
const docReady = new Promise<void>((r) => { docDone = r })
let bootDone!: () => void
const bootReady = new Promise<void>((r) => { bootDone = r })
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
    const all = (await ws.docs()).filter((d) => d.kind === VISION_KIND)
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
    else await doc.create('vision')
  }
  docDone()
  await loadModels()
  await addVisionRuntimes()
  booted.value = true
  bootDone()
  if (current.value) say(`${current.value.name}: ${captureMeta(current.value)}. press run to look again.`)
  logEvent('note', 'vision: ready.')
})
onBeforeUnmount(() => { if (live.value) stopLive() })
</script>

<template>
  <div class="hb-toolpage is-split">
    <HbPanel heading="input" class="is-side">
      <HbImageSlot v-model="input" label="image" :sources="['upload', 'camera', 'paste', 'sample']" :sample="sample" :info="slotInfo" :info-tone="current?.found.length ? 'ok' : ''" />
      <HbChipGroup v-model="tasks" :options="taskOptions" multi toggle keys label="tasks" />
      <HbSelect v-if="tasks.includes('landmarks')" v-model="lmKind" label="landmarks" :options="lmOptions" />
      <HbToolbar>
        <HbButton size="sm" :loading="running" :disabled="!current || running" @click="runAll">run</HbButton>
        <HbButton variant="secondary" size="sm" @click="live ? stopLive() : startLive()">{{ live ? 'camera off' : 'live camera' }}</HbButton>
        <HbButton v-if="live" variant="secondary" size="sm" @click="keepFrame">keep frame</HbButton>
      </HbToolbar>
      <HbStatusList :items="taskRows" />
      <HbButton v-for="x in toLoad" :key="x.r.id" variant="secondary" size="sm" :loading="stateOf(x.r) === 'downloading'" @click="loadOne(x.r)">{{ loadLabel(x.r) }}</HbButton>
    </HbPanel>

    <div class="hb-toolpage">
      <HbPanel :heading="doc.doc.value?.name ?? 'vision'">
        <HbMonitorDock v-if="current || live || denied" v-model="open" :views="views">
          <template #camera>
            <div ref="tileBox">
              <HbCameraTile :stream="stream" :tags="live ? tags : {}" :denied="denied" :denied-text="deniedText" label="camera" />
            </div>
          </template>
          <template #seen>
            <canvas ref="seen" :aria-label="`the frame with ${views.at(-1)?.aux || 'nothing found'}`" role="img" />
          </template>
        </HbMonitorDock>
        <HbStatusLine :text="status.text" :kind="running || asking ? 'busy' : status.kind" />
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :disabled="!current" @click="exportPng">seen png</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!current" @click="exportResults">results</HbButton>
          <SendTo from="vision" :offers="offers" />
          <HbButton variant="secondary" size="sm" @click="exportSession">export</HbButton>
          <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
        </HbToolbar>
      </HbPanel>

      <HbPanel heading="found">
        <HbInstanceList :items="foundItems" bare empty="nothing found yet. pick detect and run." @toggle="toggleFound" @remove="removeFound" />
        <p v-if="current?.caption && !live" class="hb-hint">caption: {{ current.caption }}{{ current.ms.caption !== undefined ? ` (${current.ms.caption} ms)` : '' }}</p>
      </HbPanel>

      <HbPanel heading="ask">
        <HbInput v-model="question" aria-label="a question about the frame" placeholder="what is on the desk" @keydown.enter="askNow" />
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :loading="asking" :disabled="!current || asking || !question.trim()" @click="askNow">ask</HbButton>
        </HbToolbar>
        <HbTimelineItem
          v-for="(a, i) in current?.answers ?? []"
          :key="a.at"
          :title="`step ${String(i + 1).padStart(2, '0')}`"
          :sub="a.question"
          :period="`${a.ms} ms`"
        >
          <HbInset title="frame" :aux="current!.name" :ratio="`${current!.width} / ${current!.height}`">
            <img :src="current!.image" alt="the frame the model saw" />
          </HbInset>
          <p>{{ a.answer }}</p>
        </HbTimelineItem>
      </HbPanel>

      <HbPanel heading="captures">
        <HbHistoryStrip :items="history" :current="current?.id ?? null" empty="each image and kept frame lands here." @restore="restore" @remove="removeCapture" />
      </HbPanel>

      <HbHow
        :packages="['@hackbuild/vision', '@hackbuild/models', '@hackbuild/devices', '@hackbuild/ai-env']"
        install="npm i @hackbuild/vision @hackbuild/models @hackbuild/devices @hackbuild/ai-env"
        :code="HOW"
        persist-key="vision-how"
      />
    </div>
  </div>
</template>
