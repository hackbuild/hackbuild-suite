<script setup lang="ts">
// The speech tool (design 3.3). A script document holds the text, the
// engine and voice; say plays it on the engine chain with the words lit as
// they are spoken; save wav renders it offline to a buffer, so the file
// does not depend on capturing live playback. Engines come through the one
// hub; the system voice needs no download and is the fallback.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbButton, HbChip, HbDropzone, HbMicButton, HbHistoryStrip, HbHow, HbMethodCard, HbPanel, HbSelect, HbSlider, HbSpokenText, HbStatusLine, HbTextarea, HbToolbar,
  useHotkeys, type HbHistoryItem,
} from '@virgilvox/hackbuild-ui'
import { saveFile, type MethodState, type MicState } from '@virgilvox/hackbuild-ui/vanilla'
import { decodeAudio, record } from '@hackbuild/media'
import { createSpeaker, renderSpeech, renderedWav, renderedTiming, toMono, wordSpans, OfflineRenderError, type Engine, type Speaker } from '@hackbuild/speak'
import type { Loaded } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, usePrimary, useStop } from '../shell/shell.ts'
import { settings } from '../shell/settings.ts'
import { exportDoc, kinds, pickFiles, registerKind, useDocument, ws } from '../workspace/state'
import { newScript, peaksOf, runThumb, SPEECH_KIND, speechKind, withRun, type SpeechBody } from './kind.ts'
import SendTo from '../shell/SendTo.vue'
import type { SendOffer } from '../workspace/sendto'
import { addSpeakRuntimes, KOKORO_ID, KOKORO_OFF, SPEAK_ORDER, SYSTEM_ID, TRADES } from './runtimes.ts'
import how from '@hackbuild/speak/how'

if (!kinds.get(SPEECH_KIND)) registerKind(speechKind)

const route = useRoute()
const doc = useDocument<SpeechBody>(SPEECH_KIND)
const body = computed<SpeechBody>(() => doc.doc.value?.body ?? newScript())

// The text is a draft while typing; it lands in the document on blur and on say.
const draft = ref('')
watch(() => body.value.text, (t) => { if (t !== draft.value) draft.value = t })
function commitText(): void {
  if (doc.doc.value && draft.value !== body.value.text) doc.edit((b) => { b.text = draft.value })
}
const set = <K extends 'engine' | 'voice' | 'rate' | 'pitch'>(k: K, v: SpeechBody[K]) => {
  if (doc.doc.value && body.value[k] !== v) doc.edit((b) => { b[k] = v })
}
const rate = computed({ get: () => body.value.rate, set: (v: number) => set('rate', v) })
const pitch = computed({ get: () => body.value.pitch, set: (v: number) => set('pitch', v) })
const voice = computed({ get: () => body.value.voice, set: (v: string) => set('voice', v) })

// short, so a chip fits a 320 px phone
const examples = ['chat runs on cpu.', 'the gate kept this.', 'say it slower.']

// Engines: one card each, with the trade (P-VOUT-1, P-MODEL-14).
const status = ref<{ text: string; kind: 'none' | 'ok' | 'warn' | 'err' | 'info' | 'busy' }>({ text: 'type a line and press say. the system voice needs no download.', kind: 'info' })
const say = (text: string, kind: typeof status.value.kind = 'info') => { status.value = { text, kind } }
const rec = (id: string) => hub.allRecords.value.find((r) => r.id === id)
const stateOf = (id: string) => hub.states.value[id]?.state ?? 'none'
const hasSystem = hub.STUB || (typeof speechSynthesis !== 'undefined')
function methodState(id: string): MethodState {
  if (id === SYSTEM_ID) return hasSystem ? 'ready' : 'unsupported'
  const s = stateOf(id)
  if (s === 'loaded') return 'ready'
  if (s === 'stored') return 'stored'
  if (s === 'downloading') return 'loading'
  if (s === 'fault') return 'failed'
  return rec(id)?.sizeMB === 0 ? 'ready' : 'download'
}
const cards = computed(() =>
  SPEAK_ORDER.filter((id) => rec(id)).map((id) => {
    const r = rec(id)!
    const t = TRADES[id]!
    const st = methodState(id)
    const notice = id === KOKORO_ID && !settings.value.kokoro ? KOKORO_OFF : st === 'failed' ? hub.states.value[id]?.error ?? '' : st === 'unsupported' ? 'this browser has no speech synthesis.' : ''
    return { id, label: r.label ?? id, trade: t.trade, time: t.time, quality: t.quality, sizeMB: r.sizeMB, state: st, notice }
  }),
)
const picked = computed(() => body.value.engine)
const ready = (id: string) => id === SYSTEM_ID ? hasSystem : ['loaded', 'stored'].includes(stateOf(id)) || rec(id)?.sizeMB === 0
/** The order say tries: the picked engine, then the system voice. */
const order = computed(() => [...new Set([picked.value, SYSTEM_ID])].filter((id) => rec(id)))
const orderLine = computed(() => order.value.map((id) => rec(id)?.label ?? id).join(', then '))
const active = ref<string | null>(null)

function pick(id: string): void {
  set('engine', id)
  if (id === KOKORO_ID && !settings.value.kokoro) return say(KOKORO_OFF, 'warn')
  void refreshVoices()
}
// Nothing is fetched on pick: a heavy engine loads only from this button, which names its size.
const needsLoad = computed(() => picked.value !== SYSTEM_ID && !ready(picked.value) && !(picked.value === KOKORO_ID && !settings.value.kokoro))
const loadLabel = computed(() => {
  const r = rec(picked.value)
  if (!r) return 'load'
  if (stateOf(r.id) === 'downloading') return `loading ${r.label ?? r.id}`
  const size = r.sizeMB === null ? 'size unknown' : r.sizeMB === 0 ? 'code only' : `${Math.round(r.sizeMB)} mb (${r.sizeSource})`
  return `load ${r.label ?? r.id}, ${size}`
})
const loadPicked = () => void booted.then(() => hub.load(picked.value))

// Loaded engines, held while the tool is open. None is asked for before the voice runtimes are in.
const handles = new Map<string, Loaded>()
let runtimes!: () => void
const booted = new Promise<void>((r) => { runtimes = r })
async function engineOf(id: string): Promise<Engine | null> {
  await booted
  const held = handles.get(id)
  if (held) return held.value as Engine
  if (!ready(id)) return null
  try {
    const l = await hub.hub().use({ id })
    handles.set(id, l)
    return l.value as Engine
  } catch (err) {
    logEvent('fail', `speak: ${rec(id)?.label ?? id}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
async function chain(): Promise<Engine[]> {
  const out: Engine[] = []
  for (const id of order.value) {
    const e = await engineOf(id)
    if (e) out.push(e)
  }
  return out
}
const voices = shallowRef<string[]>([])
async function refreshVoices(): Promise<void> {
  const e = await engineOf(picked.value)
  voices.value = e?.voices?.() ?? []
}
const voiceOptions = computed(() => [{ value: '', label: 'engine default' }, ...voices.value.map((v) => ({ value: v, label: v === 'custom' ? 'custom, your clip' : v }))])
const voiceNote = computed(() => {
  const r = rec(picked.value)
  return r ? `${r.label ?? r.id}: ${r.licence}.` : ''
})
const cfg = () => ({ voice: { rate: body.value.rate, pitch: body.value.pitch }, voices: body.value.voice ? { [picked.value]: { voice: body.value.voice } } : {} })

// Say: the words light on the engine's word events (P-VOUT-6).
const spans = computed(() => wordSpans(draft.value))
// each word keeps its trailing punctuation, so the lit line reads as typed
const words = computed(() => spans.value.map((w, i) => draft.value.slice(w.start, spans.value[i + 1]?.start ?? draft.value.length).trim()))
const lit = ref<number | null>(null)
const speaking = ref(false)
let ctx: AudioContext | null = null
let speaker: Speaker | null = null
let speakerKey = ''
/** Bumped by stop and by each say, so a stopped line lands no run. */
let sayId = 0
const wordAt = (offset: number) => {
  let i = -1
  for (const [k, w] of spans.value.entries()) if (w.start <= offset) i = k
  return i
}

/** The speaker over the loaded chain; rebuilt when the chain or the voice changes. */
async function ensureSpeaker(): Promise<Speaker | null> {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined)
  if (ctx.state !== 'running') return say('the browser wants a tap before sound. press say again.', 'warn'), null
  const engines = await chain()
  if (!engines.length) return say('no voice is ready. pick the system voice or load another.', 'err'), null
  const key = engines.map((e) => e.id).join(',') + JSON.stringify(cfg())
  if (!speaker || key !== speakerKey) {
    speaker?.dispose()
    speakerKey = key
    speaker = createSpeaker({
      ctx,
      engines,
      ...cfg(),
      watchdogMs: WATCHDOG_MS,
      onProgress: (p) => {
        if (p.kind === 'word') lit.value = wordAt(p.offset)
        else if (p.kind === 'end') lit.value = words.value.length
      },
      onSpeaking: (s) => { speaking.value = s },
      onSegment: (g) => { active.value = g.engine },
      onStatus: (s) => { if (s.kind === 'failed' || s.kind === 'watchdog') say(`${s.text} the next voice takes over.`, 'warn') },
    })
  }
  return speaker
}
/** A sentence with no audio for this long moves to the next voice. */
const WATCHDOG_MS = 20000

async function sayNow(): Promise<void> {
  commitText()
  const text = draft.value.trim()
  if (!text) return say('type a line and press say. the system voice needs no download.')
  stop()
  const sp = await ensureSpeaker()
  if (!sp) return
  if (picked.value !== SYSTEM_ID && !ready(picked.value)) {
    const st = hub.states.value[picked.value]
    say(`loading ${rec(picked.value)?.label ?? picked.value}${st?.state === 'downloading' && st.total ? `, ${Math.round(((st.loaded ?? 0) / st.total) * 100)} percent` : ''}. the system voice is ready now.`, 'busy')
  }
  lit.value = -1
  const mine = ++sayId
  const done = sp.say(text)
  // the engine that answered, named (P-FAIL-4)
  setTimeout(() => { if (speaker === sp) active.value = sp.engine }, 0)
  speaking.value = true
  await done
  if (mine !== sayId) return
  active.value = sp.engine ?? active.value
  speaking.value = false
  say(`said on ${rec(active.value ?? '')?.label ?? active.value ?? 'the voice'}.`, 'ok')
  addRun(null, null)
}
// Stream: the line arrives a word at a time, as a reply does, and each
// sentence is spoken as soon as it is whole (Speaker.feed).
const STREAM_STEP_MS = 60
async function streamNow(): Promise<void> {
  commitText()
  const text = draft.value.trim()
  if (!text) return say('type a line and press say. the system voice needs no download.')
  stop()
  const sp = await ensureSpeaker()
  if (!sp) return
  const mine = ++sayId
  lit.value = -1
  speaking.value = true
  const t0 = performance.now()
  let first: number | null = null
  const off = watch(lit, (v) => { if (v !== null && v >= 0 && first === null) first = performance.now() - t0 })
  let sofar = ''
  for (const piece of text.split(/(?<=\s)/)) {
    if (mine !== sayId) break
    sofar += piece
    sp.feed(sofar)
    await new Promise((r) => setTimeout(r, STREAM_STEP_MS))
  }
  const arrived = performance.now() - t0
  if (mine === sayId) sp.feed(text, true)
  await sp.done()
  off()
  if (mine !== sayId) return
  speaking.value = false
  const f = first as number | null
  say(f !== null && f < arrived
    ? `streamed: first sound at ${Math.round(f)} ms, before the last word arrived at ${Math.round(arrived)} ms (measured).`
    : `streamed: the text arrived in ${Math.round(arrived)} ms; sound began after it. one sentence is spoken whole.`, 'ok')
  addRun(null, null)
}

// Clone (Pocket): a dropped or recorded clip becomes voice "custom". The clip stays in this tab.
const CLONE_ID = 'pocket-tts'
const cloneLine = ref('no clip. drop a wav of the voice.')
const cloned = ref(false)
async function cloneFrom(blob: Blob): Promise<void> {
  const e = (await engineOf(CLONE_ID)) as (Engine & { cloneVoice?: (s: Float32Array, r: number) => Promise<void> }) | null
  if (!e?.cloneVoice) return void (cloneLine.value = 'load pocket tts first. the clone runs inside it.')
  try {
    const a = await decodeAudio(blob)
    const short = a.duration < 8 ? ` reference clip is ${a.duration.toFixed(0)} s. 8 s or more copies the voice better.` : ''
    cloneLine.value = 'encoding voice...'
    await e.cloneVoice(toMono(a.channels), a.sampleRate)
    cloned.value = true
    voices.value = [...new Set([...(e.voices?.() ?? voices.value), 'custom'])]
    set('voice', 'custom')
    cloneLine.value = `cloned voice active. up to 15 s of audio is used.${short}`
  } catch (err) {
    cloneLine.value = `no clone: ${err instanceof Error ? err.message : String(err)}`
  }
}
const cloneFiles = (files: File[]) => { if (files[0]) void cloneFrom(files[0]) }
const micState = ref<MicState>('off')
let take: { stop(): Promise<Blob> } | null = null
let micStream: MediaStream | null = null
let micTimer = 0
async function recStart(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    micState.value = 'unsupported'
    return void (cloneLine.value = 'no mic here. drop a wav of the voice.')
  }
  micState.value = 'asking'
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    micState.value = 'blocked'
    return void (cloneLine.value = `mic unavailable: ${err instanceof Error ? err.message : String(err)}. drop a wav instead.`)
  }
  take = record(micStream)
  micState.value = 'listening'
  cloneLine.value = 'recording for 10 s, talk normally...'
  micTimer = window.setTimeout(() => void recStop(), 10000)
}
async function recStop(): Promise<void> {
  clearTimeout(micTimer)
  const t = take
  take = null
  if (!t) return
  const blob = await t.stop()
  micStream?.getTracks().forEach((k) => k.stop())
  micStream = null
  micState.value = 'off'
  await cloneFrom(blob)
}

function stop(): void {
  sayId++
  speaker?.stop()
  speaking.value = false
}

// Send to (design 1.2): the line as text, and its offline render as audio for transcribe.
const offers = computed<SendOffer[]>(() => {
  const name = doc.doc.value?.name ?? 'speech'
  const ok = !!draft.value.trim()
  return [
    { type: 'text', what: 'text', ready: ok, get: () => (draft.value.trim() ? { type: 'text', name, text: draft.value.trim() } : null) },
    {
      type: 'audio', what: 'audio', ready: ok && !saving.value,
      get: async () => {
        const audio = await renderWav(false)
        const t = body.value.timing
        const words = t?.words.map((w) => ({ text: draft.value.trim().slice(w.start, w.end), t0: w.t0, t1: w.t1 }))
        return audio ? { type: 'audio', name, audio, ...(words?.length ? { words } : {}) } : null
      },
    },
  ]
})

// Save wav: an offline render on the chain, never a capture of playback.
const saving = ref(false)
const saveWav = () => renderWav(true)
async function renderWav(save: boolean): Promise<Blob | null> {
  commitText()
  const text = draft.value.trim()
  if (!text) return say('type a line first. there is nothing to save.', 'warn'), null
  saving.value = true
  try {
    const r = await renderSpeech(await chain(), text, { ...cfg(), onSkip: (id, why) => logEvent('note', `speak: ${id} skipped for the wav: ${why}`) })
    const name = `${doc.doc.value?.name ?? 'speech'}.wav`
    const wav = renderedWav(r)
    if (save) saveFile(name, wav, 'audio/wav')
    const t = renderedTiming(r, text)
    doc.edit((b) => { b.timing = { engine: t.engine, sampleRate: t.sampleRate, duration: t.duration, words: r.words.map(({ start, end, t0, t1, estimated }) => ({ start, end, t0, t1, estimated })) } })
    addRun(r.duration, peaksOf(r.samples))
    say(`${save ? 'saved' : 'rendered'} ${name}, ${r.duration.toFixed(1)} s from ${rec(r.engine)?.label ?? r.engine} (measured).`, 'ok')
    return new Blob([wav as BlobPart], { type: 'audio/wav' })
  } catch (err) {
    say(err instanceof OfflineRenderError ? err.message : `no wav: ${err instanceof Error ? err.message : String(err)}`, 'err')
    return null
  } finally {
    saving.value = false
  }
}

// Runs: each say or save lands here; a press restores its settings (P-GEN-3).
function addRun(duration: number | null, peaks: number[] | null): void {
  const b = body.value
  const id = `${Date.now().toString(36)}`
  doc.edit((x) => {
    x.runs = withRun(x.runs, { id, text: b.text, engine: active.value ?? b.engine, voice: b.voice, rate: b.rate, pitch: b.pitch, at: Date.now(), duration, peaks: peaks ?? b.text.split(/\s+/).slice(0, 24).map((w) => Math.min(1, w.length / 8)) })
  })
}
const runs = computed<HbHistoryItem[]>(() =>
  body.value.runs.map((r) => ({ id: r.id, thumb: runThumb(r.peaks), label: r.text.slice(0, 60), meta: [rec(r.engine)?.label ?? r.engine, r.duration === null ? 'said live' : `${r.duration.toFixed(1)} s`].join(', ') })),
)
const currentRun = ref<string | null>(null)
function restore(it: HbHistoryItem): void {
  const r = body.value.runs.find((x) => x.id === it.id)
  if (!r) return
  currentRun.value = r.id
  draft.value = r.text
  doc.edit((b) => { Object.assign(b, { text: r.text, engine: r.engine, voice: r.voice, rate: r.rate, pitch: r.pitch }) })
}
const removeRun = (it: HbHistoryItem) => doc.edit((b) => { b.runs = b.runs.filter((x) => x.id !== it.id) })

const exportTiming = () => doc.doc.value && void exportDoc(doc.doc.value.id, { format: 'timing' })
const exportScript = () => doc.doc.value && void exportDoc(doc.doc.value.id)

// Keys: ctrl+enter says, esc stops, space replays when no field has focus.
usePrimary(() => void sayNow())
useStop(stop)
useHotkeys([{ keys: 'space', label: 'say the line again', group: 'tool', run: () => void sayNow() }])

watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void doc.open(id) })
watch(() => hub.states.value[picked.value]?.state, () => void refreshVoices())
onMounted(async () => {
  await ws.ready()
  const q = route.query.doc
  if (typeof q === 'string') await doc.open(q)
  else {
    const all = (await ws.docs()).filter((d) => d.kind === SPEECH_KIND)
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
    else await doc.create('speech')
  }
  await loadModels()
  await addSpeakRuntimes({ kokoro: () => settings.value.kokoro === true })
  runtimes()
  await refreshVoices()
  // a line sent from chat or a transcript lands here and is said
  const t = route.query.text
  if (typeof t === 'string' && t.trim()) {
    draft.value = t
    commitText()
    if (route.query.say === '1') void sayNow()
  }
  logEvent('note', 'speak: ready.')
})
onBeforeUnmount(() => {
  void recStop()
  speaker?.dispose()
  for (const l of handles.values()) hub.hub().release(l)
  void ctx?.close()
})
</script>

<template>
  <div class="hb-toolpage is-split">
    <HbPanel heading="voice" class="is-side">
      <div class="hb-methods" role="radiogroup" aria-label="voice engine">
        <HbMethodCard
          v-for="c in cards"
          :key="c.id"
          :label="c.label"
          :trade="c.trade"
          :time="c.time"
          :quality="c.quality"
          :size-m-b="c.sizeMB"
          :state="c.state"
          :notice="c.notice"
          :active="c.id === picked"
          @pick="pick(c.id)"
        />
      </div>
      <HbButton v-if="needsLoad" variant="secondary" size="sm" :loading="stateOf(picked) === 'downloading'" @click="loadPicked">{{ loadLabel }}</HbButton>
      <p class="hb-hint">order: {{ orderLine }}.{{ active ? ` speaking with ${rec(active)?.label ?? active}.` : '' }} a sentence with no sound for {{ WATCHDOG_MS / 1000 }} s moves to the next voice.</p>
      <HbSelect v-model="voice" label="voice" :options="voiceOptions" />
      <p class="hb-hint">{{ voiceNote }}</p>
      <HbSlider v-model="rate" label="rate" :min="0.5" :max="2" :step="0.05" unit="x" />
      <HbSlider v-model="pitch" label="pitch" :min="0.5" :max="2" :step="0.05" />
      <template v-if="picked === CLONE_ID">
        <HbDropzone v-if="ready(CLONE_ID)" accept="audio/*" hint="drop a wav of the voice, or pick one. it stays in this tab." @files="cloneFiles" />
        <HbMicButton v-if="ready(CLONE_ID)" v-model:state="micState" @start="recStart" @stop="recStop" />
        <p class="hb-hint">{{ ready(CLONE_ID) ? cloneLine : 'load pocket tts to clone a voice.' }}</p>
      </template>
    </HbPanel>

    <div class="hb-toolpage">
      <HbPanel :heading="doc.doc.value?.name ?? 'speech'">
        <div class="hb-chipgroup">
          <HbChip v-for="ex in examples" :key="ex" @click="draft = ex; commitText()">{{ ex }}</HbChip>
        </div>
        <HbTextarea v-model="draft" :rows="4" aria-label="text to speak" placeholder="type a line to speak" @blur="commitText" />
        <HbToolbar>
          <HbButton size="sm" :disabled="!draft.trim()" @click="sayNow">say</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!draft.trim()" @click="streamNow">stream</HbButton>
          <HbButton variant="danger" size="sm" :disabled="!speaking" @click="stop">stop</HbButton>
          <HbButton variant="secondary" size="sm" :loading="saving" :disabled="saving || !draft.trim()" @click="saveWav">save wav</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!body.timing" @click="exportTiming">word timing</HbButton>
          <SendTo from="speak" :offers="offers" />
          <HbButton variant="secondary" size="sm" @click="exportScript">export</HbButton>
          <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
        </HbToolbar>
        <HbStatusLine :text="status.text" :kind="speaking ? 'busy' : status.kind" />
        <HbSpokenText v-if="words.length" :words="words" :active="lit" :who="active ? rec(active)?.label ?? active : ''" />
      </HbPanel>

      <HbPanel heading="runs">
        <HbHistoryStrip :items="runs" :current="currentRun" grid empty="each line you say or save lands here." @restore="restore" @remove="removeRun" />
      </HbPanel>

      <HbHow v-bind="how" persist-key="speak-how" />
    </div>
  </div>
</template>
