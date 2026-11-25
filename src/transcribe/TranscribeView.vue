<script setup lang="ts">
// The transcription tool (design 3.2, the earlier tool's flow kept whole).
// Every recording is a transcript document: a dropped file or a mic take
// becomes a queued document through the window drop router, one press runs
// the queue through the one hub, and the open document takes edits with
// undo. The queue list is the history.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbButton, HbCallout, HbConsole, HbEngineBar, HbExportPanel, HbField, HbFold, HbHow, HbInput, HbLevelRail, HbMicButton, HbPanel,
  HbQueueStrip, HbReadouts, HbSelect, HbSlider, HbToggleRow, HbToolbar, HbTranscript, useHotkeys,
  type HbConsoleLine, type HbEngineState, type HbExportFormat, type HbExportRequest, type HbQueueItem, type HbReadoutRow,
} from '@virgilvox/hackbuild-ui'
import { saveFile, stripMeta, type MicState, type StripStatus } from '@virgilvox/hackbuild-ui/vanilla'
import { bundle, createQueue, defaultTranscribeId, languagesFor, toMono, transcribe, type Job, type Transcript } from '@hackbuild/transcribe'
import { gateThreshold, type Dsp } from '@hackbuild/audio-dsp'
import { decodeAudio, pickMime, record } from '@hackbuild/media'
import type { ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { core } from '../cores.ts'
import { jobs, logEvent, overlay, usePrimary, useStop } from '../shell/shell.ts'
import { deleteDoc, docs, exportDoc, importFiles, kinds, pickFiles, useDocument, ws } from '../workspace/state'
import type { Doc } from '../workspace/workspace.ts'
import { CAPTURE, docOf, TRANSCRIPT_KIND, withRun, type Capture, type TranscriptBody } from './kind.ts'
import { registerTranscript } from './register.ts'
import SendTo from '../shell/SendTo.vue'
import type { SendOffer } from '../workspace/sendto'
import { addTranscribeRuntimes, provideDsp } from './runtimes.ts'
import { threadsOffWhy } from '../shell/isolation.ts'
import { wasmThreads } from '@hackbuild/devices'
import how from '@hackbuild/transcribe/how'

registerTranscript()
provideDsp()
const route = useRoute()
const doc = useDocument<TranscriptBody>(TRANSCRIPT_KIND)
const body = computed(() => doc.doc.value?.body ?? null)

// Send to (design 1.2, 2.4): the transcript as text to memory, chat and speech.
const spoken = () => segs.value.map((s) => s.text.trim()).filter(Boolean)
const offers = computed<SendOffer[]>(() => [{
  type: 'text', what: 'transcript', ready: segs.value.length > 0,
  get: () => ({ type: 'text', name: doc.doc.value?.name ?? 'transcript', text: spoken().join('\n') }),
}])

// The timed log (P-LOAD-15): a box in the tool, every line also in the shell log.
const lines = ref<HbConsoleLine[]>([])
function log(text: string, level: HbConsoleLine['level'] = 'info'): void {
  lines.value = [...lines.value.slice(-199), { text, level, t: new Date().toTimeString().slice(0, 8) }]
  logEvent(level === 'err' ? 'fail' : level === 'warn' ? 'warn' : 'note', `transcribe: ${text}`)
}

// The queue list: every transcript document of the project, oldest first.
const list = computed(() =>
  (docs.value.filter((d) => d.kind === TRANSCRIPT_KIND) as Doc<TranscriptBody>[]).slice().sort((a, b) => a.created - b.created),
)
const bodyOf = (d: Doc<TranscriptBody>) => (d.id === doc.doc.value?.id ? doc.doc.value.body : d.body)

// The engine: a speech to text row on the one hub, preset from the probe (P-CAP-1).
const asrRecords = computed(() => hub.allRecords.value.filter((r) => r.provides.includes('transcribe') && r.group !== 'custom'))
const picked = ref<string | null>(null)
const preset = computed(() => {
  const e = hub.env.value
  if (!e) return { id: 'whisper-base.en', why: 'checking this machine.' }
  const n = wasmThreads(e)
  if (n <= 1) return { id: 'whisper-tiny.en', why: `threads: off here, ${threadsOffWhy() ?? 'this machine has one core'}. whisper runs on one core and will be slow. tiny is selected.` }
  return e.webgpu
    ? { id: defaultTranscribeId(true), why: 'webgpu adapter found, so large-v3-turbo, as the earlier tool chose.' }
    : { id: defaultTranscribeId(false), why: `no webgpu adapter, so base.en on ${n} wasm threads, as the earlier tool chose.` }
})
const rec = computed<ModelRecord | undefined>(() => asrRecords.value.find((r) => r.id === (picked.value ?? preset.value.id)) ?? asrRecords.value[0])
const modelId = computed({ get: () => rec.value?.id ?? '', set: (v: string) => { picked.value = v } })
const modelOptions = computed(() => asrRecords.value.map((r) => ({ value: r.id, label: `${r.label ?? r.id}, ${r.sizeMB === null ? 'size unknown' : `${Math.round(r.sizeMB)} mb`}` })))
const stateOf = (id: string | undefined) => (id ? hub.states.value[id]?.state ?? 'none' : 'none')
const wantLang = ref('auto')
const lang = computed(() => (rec.value ? languagesFor(rec.value, wantLang.value) : null))
const langOptions = computed(() => (lang.value?.options ?? []).map((l) => ({ value: l.code, label: l.name })))
const langValue = computed({ get: () => lang.value?.value ?? 'auto', set: (v: string) => { wantLang.value = v } })
const barState = computed<HbEngineState>(() => {
  const s = stateOf(rec.value?.id)
  return s === 'loaded' || s === 'stored' || s === 'downloading' ? s : s === 'fault' ? 'fault' : 'none'
})
const barFacts = computed(() => {
  const st = rec.value ? hub.states.value[rec.value.id] : undefined
  return {
    pct: st?.state === 'downloading' && st.total ? (st.loaded ?? 0) / st.total : null,
    error: st?.state === 'fault' ? st.error : '',
    device: rec.value?.ladder[0]?.device ?? '',
  }
})

// Capture settings (P-STT-6). A selected document shows the settings of its run.
const capture = ref<Capture>({ ...CAPTURE })
const denoise = computed({ get: () => String(capture.value.denoise), set: (v: string) => { capture.value.denoise = Number(v) as Capture['denoise'] } })
const DENOISE = [{ value: '0', label: 'off' }, { value: '1', label: 'light' }, { value: '2', label: 'medium' }, { value: '3', label: 'strong' }]
const showDropped = ref(false)
const query = ref('')

// The queue (P-STT-7): decode, analysis and the run per document.
interface QFile { id: string; name: string; size: number; type: string }
const qjobs = shallowRef<Job<QFile, Transcript>[]>([])
const written = new Set<number>()
const jobOf = (id: string) => qjobs.value.find((j) => j.file.id === id)
const running = ref(false)

async function patch(id: string, fn: (b: TranscriptBody) => TranscriptBody): Promise<void> {
  await ws.flush()
  const d = await ws.getDoc<TranscriptBody>(id)
  if (!d) return
  ws.change({ ...d, body: fn(d.body) })
  await ws.flush()
  // the open document reads its new body back; its undo steps are for edits, not runs
  if (doc.doc.value?.id === id) await doc.open(id)
}

const queue = createQueue<QFile, Transcript>({
  async decode(f, signal) {
    const d = await ws.getDoc<TranscriptBody>(f.id)
    const h = d?.body.audio?.$blob
    const blob = h ? await ws.getBlob(h) : undefined
    if (!blob) throw new Error('the recording is not in this browser')
    const out = await decodeAudio(new Blob([blob.data as BlobPart], { type: blob.type }), 16000)
    if (signal.aborted) throw new DOMException('stopped', 'AbortError')
    return out
  },
  async run(audio, ctx) {
    const dsp = await core<Dsp>('dsp')
    const c = { ...capture.value }
    return transcribe(hub.hub(), dsp, toMono(audio.channels), {
      ...c, model: modelId.value, language: langValue.value, signal: ctx.signal,
      onProgress: (p) => ctx.progress(p.done / Math.max(1, p.total)),
    })
  },
  explain: (e) => `the run failed: ${e instanceof Error ? e.message : String(e)}. press transcribe to try again.`,
  onChange(js) {
    qjobs.value = js
    for (const j of js) {
      if (written.has(j.id) || (j.state !== 'done' && j.state !== 'failed')) continue
      written.add(j.id)
      const c = { ...capture.value }
      if (j.state === 'done' && j.result) {
        const t = j.result
        log(`${j.name}: ${t.segments.length} lines, ${t.dropped.length} dropped, ${t.stats.rtf.toFixed(1)}x realtime (measured)`, t.segments.length ? 'ok' : 'warn')
        if (!t.segments.length) log('no speech passed the gate. lower the threshold, or turn on show dropped lines.', 'warn')
        void patch(j.file.id, (b) => ({ ...withRun(b, t), capture: c }))
      } else {
        log(`${j.name}: ${j.error}`, 'err')
        void patch(j.file.id, (b) => ({ ...b, state: 'failed', error: j.error }))
      }
    }
  },
})

const waiting = computed(() => list.value.filter((d) => { const s = bodyOf(d).state; return s === 'queued' || s === 'failed' }).filter((d) => bodyOf(d).audio))
const sizeText = (r: ModelRecord | undefined) => (r?.sizeMB == null ? 'size unknown' : `${Math.round(r.sizeMB)} mb`)
const runLabel = computed(() => {
  if (running.value) return 'transcribing'
  const n = waiting.value.length
  if (!n) return 'nothing queued'
  const files = `transcribe ${n} file${n === 1 ? '' : 's'}`
  const s = stateOf(rec.value?.id)
  return s === 'loaded' || s === 'stored' ? files : `load ${rec.value?.label ?? 'the model'}, ${sizeText(rec.value)}, then ${files}`
})

async function runAll(): Promise<void> {
  if (running.value) return
  if (!waiting.value.length) return log('nothing queued. drop audio or video, or press the mic.', 'warn')
  const r = rec.value
  if (!r) return log('no speech to text row in the catalogue.', 'err')
  running.value = true
  jobs.set('transcribe-run', `transcribing ${waiting.value.length} files`)
  try {
    if (stateOf(r.id) !== 'loaded') {
      log(`loading ${r.label ?? r.id}, ${sizeText(r)}. licence as recorded: ${r.licence}.`)
      await hub.load(r.id)
      if (stateOf(r.id) !== 'loaded') return log(`${r.label ?? r.id} did not load. the model manager says why.`, 'err')
    }
    const known = new Set(qjobs.value.map((j) => j.file.id))
    for (const j of qjobs.value) if (j.state === 'done' || j.state === 'failed') queue.remove(j.id)
    const add = waiting.value.filter((d) => !known.has(d.id) || jobOf(d.id)?.state !== 'queued')
    const res = queue.add(add.map((d) => ({ id: d.id, name: bodyOf(d).source || d.name, size: bodyOf(d).size, type: bodyOf(d).type })))
    for (const w of [...res.warnings, ...res.skipped]) log(w, 'warn')
    log(`run: ${waiting.value.length} files on ${r.label ?? r.id}, language ${langValue.value}.`)
    await queue.start()
  } finally {
    running.value = false
    jobs.end('transcribe-run')
  }
}
function stopRun(): void {
  if (!running.value) return
  queue.stop()
  log('stopped after the current file. it goes back to queued.', 'warn')
}

// The strips (P-STT-1).
const items = computed<HbQueueItem[]>(() =>
  list.value.map((d, i) => {
    const b = bodyOf(d)
    const j = jobOf(d.id)
    const live = j?.state === 'running'
    const status: StripStatus = live ? 'running' : b.state
    return {
      id: d.id, n: i + 1, name: d.name, status, phase: live ? j!.phase : null, pct: live ? Math.round(j!.progress * 100) : undefined,
      wave: b.rail ? { env: b.rail.db, vad: b.rail.kept, noiseDb: b.rail.noiseDb, thrDb: b.rail.thrDb, duration: b.rail.duration } : null,
      meta: stripMeta({
        duration: b.stats?.dur ?? j?.meta?.duration, size: b.size || undefined, snrDb: b.stats?.snrDb, gainDb: b.stats?.gainDb,
        density: b.stats?.density, rtf: b.stats?.rtf, lines: b.state === 'done' ? b.segments.length : undefined,
      }),
      error: b.state === 'failed' ? b.error : null,
    }
  }),
)
const selected = computed<string | number | null>({
  get: () => doc.doc.value?.id ?? null,
  set: (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void ws.flush().then(() => doc.open(id)) },
})
async function removeDoc(id: string | number): Promise<void> {
  const j = jobOf(String(id))
  if (j) queue.remove(j.id)
  await deleteDoc(String(id))
  if (doc.doc.value?.id === id) {
    const next = list.value.find((d) => d.id !== id)
    if (next) await doc.open(next.id)
    else doc.doc.value = null
  }
}
async function clearDone(): Promise<void> {
  for (const d of list.value) if (bodyOf(d).state === 'done' && !jobOf(d.id)) await removeDoc(d.id)
}

// The open document: level rail with the gate previewed live, transcript, edits.
watch(() => body.value?.capture, (c) => { if (c) capture.value = { ...CAPTURE, ...c } })
const rail = computed(() => {
  const r = body.value?.rail
  if (!r) return null
  const ran = body.value?.capture
  // a moved margin redraws the gate at once; the run uses it next time
  if (!ran || (ran.vadMargin === capture.value.vadMargin && ran.skipSilence === capture.value.skipSilence)) return { ...r, vad: r.kept }
  const thr = gateThreshold(r.noiseDb, r.loudDb, capture.value.vadMargin)
  return { ...r, thrDb: thr, vad: capture.value.skipSilence ? r.db.map((x) => (x >= thr ? 1 : 0)) : r.db.map(() => 1) }
})
const gateMoved = computed(() => !!rail.value && rail.value.thrDb !== body.value?.rail?.thrDb)
function edit(i: number, p: { text?: string; speaker?: string }): void {
  doc.edit((b) => {
    const s = b.segments[i]
    if (!s) return
    if (p.text !== undefined) s.text = p.text
    if (p.speaker !== undefined) {
      if (p.speaker) s.speaker = p.speaker
      else delete s.speaker
    }
    s.edited = true
  })
  log(`edited line ${i + 1}. ctrl+z undoes it.`)
}
const readout = computed<HbReadoutRow[]>(() => {
  const s = body.value?.stats
  if (!s) return []
  return [
    { label: 'noise floor', value: s.noiseDb.toFixed(1), unit: 'dBFS' },
    { label: 'speech level', value: s.speechDb.toFixed(1), unit: 'dBFS' },
    { label: 'signal to noise', value: s.snrDb.toFixed(1), unit: 'dB', focal: true },
    { label: 'lift applied', value: s.gainDb.toFixed(1), unit: 'dB' },
    { label: 'speech share', value: Math.round(s.density * 100), unit: 'percent' },
    { label: 'speed', value: s.rtf.toFixed(1), unit: 'x realtime' },
  ]
})
const transcriptEmpty = computed(() => {
  const b = body.value
  if (!b) return 'drop audio or video here, or press the mic. nothing leaves this tab.'
  if (b.state === 'queued') return 'queued. press transcribe.'
  if (b.state === 'failed') return b.error ?? 'the run failed.'
  if (b.state === 'empty') return 'no speech passed the gate. lower the threshold, or turn on show dropped lines.'
  return 'no speech found.'
})

// Playback synced to the rail and the lines, click to seek.
const player = ref<HTMLAudioElement | null>(null)
const src = ref('')
const now = ref<number | null>(null)
const playing = ref(false)
watch(() => body.value?.audio?.$blob, async (h) => {
  if (src.value) URL.revokeObjectURL(src.value)
  src.value = ''
  now.value = null
  const b = h ? await ws.getBlob(h) : undefined
  if (b) src.value = URL.createObjectURL(new Blob([b.data as BlobPart], { type: b.type }))
}, { immediate: true })
function seek(t: number): void {
  now.value = t
  if (player.value && src.value) player.value.currentTime = t
}
function togglePlay(): void {
  const p = player.value
  if (!p || !src.value) return
  if (p.paused) void p.play().catch(() => log('the browser will not play this file here.', 'warn'))
  else p.pause()
}
const segs = computed(() => body.value?.segments ?? [])
const cur = computed(() => (now.value === null ? -1 : segs.value.findIndex((s) => now.value! >= s.start && now.value! < s.end)))
function step(d: number): void {
  const n = segs.value.length
  if (!n) return
  const at = cur.value < 0 ? (d > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, cur.value + d))
  seek(segs.value[at]!.start + 0.001)
}

// The mic: a take becomes a queued document like a dropped file.
const micState = ref<MicState>('off')
const micLevel = ref(0)
let take: { stop(): Promise<Blob> } | null = null
let stream: MediaStream | null = null
let actx: AudioContext | null = null
let raf = 0
let takes = 0
async function micStart(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    micState.value = 'unsupported'
    return log('no mic here. drop a file.', 'warn')
  }
  micState.value = 'asking'
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    micState.value = 'blocked'
    return log('the mic is blocked for this site. allow it in the address bar, or drop a recording.', 'err')
  }
  const mimeType = pickMime((t) => MediaRecorder.isTypeSupported(t), ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'])
  take = record(stream, { mimeType })
  actx = new AudioContext()
  const an = actx.createAnalyser()
  an.fftSize = 1024
  actx.createMediaStreamSource(stream).connect(an)
  const buf = new Float32Array(an.fftSize)
  const tick = () => {
    an.getFloatTimeDomainData(buf)
    const rms = Math.sqrt(buf.reduce((a, v) => a + v * v, 0) / buf.length)
    micLevel.value = Math.min(1, rms * 6)
    micState.value = rms > 0.02 ? 'hearing' : 'listening'
    raf = requestAnimationFrame(tick)
  }
  tick()
  log('recording. press the mic again to stop and queue the take.')
}
async function micStop(): Promise<void> {
  if (!take) return
  cancelAnimationFrame(raf)
  const blob = await take.stop()
  take = null
  for (const t of stream?.getTracks() ?? []) t.stop()
  stream = null
  void actx?.close()
  actx = null
  micState.value = 'off'
  micLevel.value = 0
  const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm'
  await importFiles([new File([blob], `mic take ${++takes}.${ext}`, { type: blob.type || 'audio/webm' })])
}

// Export (P-STT-5): one file per format, or every file as a zip with a manifest.
const transcriptExports = computed(() => kinds.get(TRANSCRIPT_KIND)?.exports ?? [])
const formats = computed<HbExportFormat[]>(() => [
  ...transcriptExports.value.map((e) => ({ key: e.key, label: e.label, ext: e.ext, note: e.note, copy: e.copy })),
  { key: 'zip', label: 'zip, every file', ext: '.zip', note: "txt, srt, vtt and json per file, and manifest.json with each run's model and language." },
])
const finished = computed(() => list.value.filter((d) => bodyOf(d).state === 'done'))
const exportBusy = computed(() => (running.value ? 'a transcription is running. stop it or wait, then export.' : !finished.value.length ? 'nothing transcribed yet.' : ''))
function onExport(r: HbExportRequest): void {
  if (r.format === 'zip') {
    const { zip, manifest } = bundle(finished.value.map((d) => docOf(bodyOf(d))), { tool: 'hackbuild-suite transcribe', capture: { ...capture.value } })
    saveFile(r.filename, zip as BlobPart, 'application/zip')
    return log(`export: ${r.filename}, ${manifest.files.length} files, ${zip.length} bytes (measured)`, 'ok')
  }
  const d = doc.doc.value
  if (!d || d.body.state !== 'done') return log('pick a transcribed file first.', 'warn')
  void exportDoc(d.id, { format: r.format, filename: r.filename.replace(/\.[^.]+$/, '') })
}
async function onCopy(format: string): Promise<void> {
  const d = doc.doc.value
  const e = transcriptExports.value.find((x) => x.key === format)
  if (!d || !e) return
  try {
    await navigator.clipboard.writeText(String(e.write(d.body as never, d.name)))
    log(`copied the ${format} to the clipboard.`, 'ok')
  } catch {
    log('the browser refused the clipboard here. use export instead.', 'warn')
  }
}

// Keys (design 3.2): j and k move by line, space plays, e edits, ctrl+f searches.
const root = ref<HTMLElement | null>(null)
const focusIn = (sel: string) => root.value?.querySelector<HTMLElement>(sel)?.focus()
useHotkeys([
  { keys: 'j', label: 'next line', group: 'tool', run: () => step(1) },
  { keys: 'k', label: 'previous line', group: 'tool', run: () => step(-1) },
  { keys: 'space', label: 'play or pause', group: 'tool', run: () => togglePlay() },
  { keys: 'e', label: 'edit the current line', group: 'tool', run: () => focusIn(`.hb-transcript .hb-tseg:not(.is-dropped):nth-child(${Math.max(0, cur.value) + 1 + (body.value?.dropped.length ? 1 : 0)}) .hb-tseg-text`) },
  { keys: 'ctrl+f', label: 'search the transcript', group: 'tool', inFields: true, run: () => focusIn('.tx-search input') },
])
usePrimary(() => void runAll())
useStop(() => {
  stopRun()
  player.value?.pause()
  void micStop()
})

const fromFile = typeof location !== 'undefined' && location.protocol === 'file:'
watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void doc.open(id) })
onMounted(async () => {
  const q = route.query.doc
  await ws.ready()
  if (typeof q === 'string') await doc.open(q)
  else {
    const all = (await ws.docs()).filter((d) => d.kind === TRANSCRIPT_KIND)
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  }
  await loadModels()
  await addTranscribeRuntimes()
  log(`ready. ${preset.value.why}`)
})
onBeforeUnmount(() => {
  queue.stop()
  void micStop()
  if (src.value) URL.revokeObjectURL(src.value)
})
</script>

<template>
  <div ref="root" class="hb-toolpage is-split">
    <HbEngineBar
      class="is-full"
      label="speech to text"
      :model="rec ? rec.label ?? rec.id : ''"
      :state="barState"
      :device="barFacts.device"
      :size-m-b="rec?.sizeMB ?? null"
      :pct="barFacts.pct"
      :error="barFacts.error"
      @change="overlay = 'models'"
      @load="rec && hub.load(rec.id)"
      @cancel="rec && hub.cancel(rec.id)"
      @unload="rec && hub.unload(rec.id)"
    />
    <HbCallout v-if="fromFile" class="is-full" variant="warn">opened from a file, so decoding runs on the page and it will stutter. results are the same.</HbCallout>

    <HbPanel heading="files" class="is-side">
      <HbToolbar>
        <HbButton variant="secondary" size="sm" @click="pickFiles()">add files</HbButton>
        <HbMicButton v-model:state="micState" :level="micLevel" @start="micStart" @stop="micStop" />
        <HbButton size="sm" :loading="running" :disabled="running || !waiting.length" @click="runAll">{{ runLabel }}</HbButton>
        <HbButton variant="danger" size="sm" :disabled="!running" @click="stopRun">stop</HbButton>
        <HbButton variant="ghost" size="sm" :disabled="running || !finished.length" @click="clearDone">clear done</HbButton>
      </HbToolbar>
      <HbQueueStrip
        v-model:selected="selected"
        :items="items"
        :locked="running"
        empty="drop audio or video here, or press the mic. nothing leaves this tab."
        @remove="removeDoc"
      />
    </HbPanel>

    <div class="hb-toolpage">
    <HbPanel :heading="doc.doc.value ? doc.doc.value.name : 'transcript'">
      <HbToolbar>
        <HbButton variant="secondary" size="sm" :disabled="!src" @click="togglePlay">{{ playing ? 'pause' : 'play' }}</HbButton>
        <HbField label="search" class="tx-search"><HbInput v-model="query" placeholder="ctrl+f" /></HbField>
        <HbToggleRow v-model="showDropped" label="show dropped lines" />
        <SendTo from="transcribe" :offers="offers" />
        <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
        <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
      </HbToolbar>
      <audio ref="player" :src="src || undefined" hidden @timeupdate="now = player?.currentTime ?? null" @play="playing = true" @pause="playing = false" />
      <HbLevelRail
        v-if="rail"
        :env="rail.db"
        :vad="rail.vad"
        :noise-db="rail.noiseDb"
        :thr-db="rail.thrDb"
        :duration="rail.duration"
        :segments="segs"
        :playhead="now"
        @seek="seek"
      />
      <p v-if="gateMoved" class="hb-hint">the gate line moved. press transcribe on a queued file to run with it.</p>
      <HbTranscript
        :segments="segs"
        :dropped="body?.dropped ?? []"
        :show-dropped="showDropped"
        :now="now"
        follow
        seekable
        editable
        :query="query"
        :empty="transcriptEmpty"
        @seek="seek"
        @edit="edit"
      />
    </HbPanel>

    <HbPanel heading="export">
      <HbExportPanel :formats="formats" :name="doc.doc.value?.name ?? 'transcript'" :busy="exportBusy" @export="onExport" @copy="onCopy" />
    </HbPanel>

    <HbFold summary="engine and capture" persist-key="transcribe-settings">
      <HbSelect v-model="modelId" label="model" :options="modelOptions" :disabled="running" />
      <p class="hb-hint">{{ picked ? 'your choice.' : preset.why }}</p>
      <HbSelect v-model="langValue" label="language" :options="langOptions" :disabled="running || lang?.locked" />
      <p v-if="lang?.reason" class="hb-hint">{{ lang.reason }}</p>
      <HbSlider v-model="capture.targetDb" label="target speech level" :min="-30" :max="-12" unit="dBFS" />
      <HbSlider v-model="capture.maxGainDb" label="max lift" :min="0" :max="60" unit="dB" />
      <HbSlider v-model="capture.vadMargin" label="gate margin above the noise floor" :min="2" :max="18" unit="dB" />
      <HbSelect v-model="denoise" label="denoise" :options="DENOISE" />
      <HbToggleRow v-model="capture.skipSilence" label="skip silence" description="cut what the gate drops before the model hears it." />
      <HbToggleRow v-model="capture.halluc" label="suppress phantom text" description="drop watermark, outro and loop lines; each keeps its reason." />
      <p class="hb-hint">very quiet source? push max lift up and the gate margin down, then watch the rail.</p>
      <HbReadouts v-if="readout.length" :rows="readout" />
    </HbFold>

    <HbFold summary="log">
      <HbConsole :lines="lines" empty="nothing run yet." />
    </HbFold>

    <HbHow v-bind="how" persist-key="transcribe-how" />
    </div>
  </div>
</template>
