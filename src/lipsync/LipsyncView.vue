<script setup lang="ts">
// The lipsync tool (design 3.11): drive a mouth from text, audio or the
// mic. A band in the stage holds the three sources (buck's jaw bar,
// P-VOUT-10, P-VIN-3; the line field sits in the rack, as buck hides it on
// a phone) and the caption states the one in use (P-VOUT-2); the viseme
// strip under the stage plays and scrubs with the transport (P-VOUT-6 as rows of
// mouth shapes). The mouth is the body's own morphs: a dropped glb or vrm,
// or the mannequin's procedural mouth. The rack holds the source, the
// mouth with strength and level, the editable viseme map and the export.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbButton, HbExportPanel, HbFold, HbHow, HbInput, HbKv, HbMeter, HbMicButton, HbParamRow, HbSelect, HbTable, HbWave,
  type HbExportFormat, type HbExportReadout, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import { saveFile, type MicState } from '@virgilvox/hackbuild-ui/vanilla'
import { GaplessPlayer } from '@hackbuild/speak'
import { bandsFromSpectrum, rms } from '@hackbuild/lipsync'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { isBodyFile } from '../stagekit/body'
import { claimDrops, exportDoc, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'
import { tone } from '../vision/frame'
import {
  LIPSYNC_KIND, VISEMES, frameAt, lipsyncKind, mapWith, morphWeights, topViseme, trackJson, trackSeconds,
  type LipsyncBody, type MapRow, type SourceKind, type Track, type Viseme,
} from './kind.ts'
import { FPS, TrackWriter, fromSamples, fromText, readAudio, voiced, type TimedWord } from './track.ts'
import { take } from './inbox.ts'
import type { Mouth } from './bind.ts'

if (!kinds.get(LIPSYNC_KIND)) registerKind(lipsyncKind)

const AUDIO_ACCEPT = '.wav,.mp3,.ogg,.m4a,.flac,audio/*'
const isAudioFile = (f: { name: string; type?: string }) => /\.(wav|mp3|ogg|m4a|flac)$/i.test(f.name) || /^audio\//.test(f.type ?? '')
/** Longest mic take, seconds (proposed). */
const MIC_MAX = 30

const tool = useStageTool({
  id: 'lipsync',
  empty: 'the mannequin with a drawn on mouth. type a line, drop audio or hold the mic. a glb or vrm with mouth shapes drops anywhere.',
  duration: 1,
})

const doc = useDocument<LipsyncBody>(LIPSYNC_KIND)
const fresh = lipsyncKind.create()
const text = ref(fresh.text)
const edits = ref<LipsyncBody['edits']>({})
const strength = ref(fresh.strength)
const lead = ref(fresh.lead)
const open = reactive({ source: true, mouth: true, map: false, export: true })

const track = shallowRef<Track | null>(null)
const mouth = shallowRef<Mouth | null>(null)
const morphs = ref<string[]>([])
const now = reactive({ viseme: 'sil' as Viseme, open: 0, weight: 0 })
const source = ref<{ name: string; kind: SourceKind; words?: TimedWord[] } | null>(null)
let samples: { samples: Float32Array; rate: number } | null = null
let bind: typeof import('./bind.ts') | null = null
let offPose: (() => void) | null = null
let offLoaded: (() => void) | null = null

/** The line under the stage says what happened; the kind goes to the log on a failure. */
const say = (t: string, kind: 'info' | 'ok' | 'warn' | 'err' | 'busy' = 'info') => {
  tool.body.line = t
  if (kind === 'err') logEvent('fail', `lipsync: ${t}`)
}
function save(fn: (d: LipsyncBody) => void) {
  if (doc.doc.value) doc.edit(fn)
}

const map = computed(() => mapWith(morphs.value, edits.value))
const SOURCE_WORDS: Record<SourceKind, string> = {
  text: 'text: words spread by syllables, no audio',
  audio: 'audio: the level and three formant bands each frame',
  speech: 'speech: the engine\'s word times, the level between them',
  mic: 'mic: the level and bands as you speak',
}

/** Shows a track: the transport fits it and starts at 0. */
function useTrack(t: Track) {
  track.value = t
  tool.transport.duration = Math.max(trackSeconds(t), 1 / FPS)
  tool.seek(0)
  tool.play()
  drawStrip()
  save((d) => { d.source = { name: t.name, kind: t.kind } })
}

function sayText() {
  const line = text.value.trim()
  if (!line) return say('type a line first. there is nothing to say.', 'warn')
  stopAudio()
  samples = null
  source.value = { name: 'line', kind: 'text' }
  useTrack(fromText(line, lead.value, 'line'))
  save((d) => { d.text = line })
  say(`${SOURCE_WORDS.text}. ${trackSeconds(track.value!).toFixed(2)} s.`, 'ok')
}

async function takeAudio(file: Blob, name: string, kind: SourceKind = 'audio', words?: TimedWord[]) {
  say(`reading ${name}.`, 'busy')
  try {
    samples = await readAudio(file)
  } catch {
    samples = null
    return say(`could not decode ${name}. drop a wav or mp3.`, 'err')
  }
  source.value = { name: name.replace(/\.[^.]+$/, ''), kind, ...(words ? { words } : {}) }
  rebuild()
  const t = track.value!
  say(`${SOURCE_WORDS[kind]}. ${trackSeconds(t).toFixed(2)} s, ${Math.round(voiced(t) * 100)} percent voiced (measured).`, 'ok')
  logEvent('note', `lipsync: ${name} as the source`)
}

/** Makes the track again from the kept source, as when the lead changes. */
function rebuild() {
  const s = source.value
  if (s?.kind === 'text' || !s) return sayText()
  if (!samples) return
  useTrack(fromSamples(samples.samples, samples.rate, { name: s.name, kind: s.kind, lead: lead.value, ...(s.words ? { words: s.words } : {}) }))
}

function pickAudio(e: Event) {
  const input = e.target as HTMLInputElement
  const f = input.files?.[0]
  input.value = ''
  if (f) void takeAudio(f, f.name)
}

// ------------------------------------------------------------- audio out

let ctx: AudioContext | null = null
let player: GaplessPlayer | null = null
let playFrom = 0
let playCtx = 0

function stopAudio() {
  player?.stop()
}
function startAudio() {
  if (!samples || tool.transport.rate !== 1) return
  ctx ??= new AudioContext()
  player ??= new GaplessPlayer(ctx)
  void ctx.resume?.()
  player.stop()
  const at = Math.floor(tool.transport.time * samples.rate)
  if (at >= samples.samples.length) return
  const s = player.schedule(samples.samples.subarray(at), samples.rate)
  playFrom = tool.transport.time
  playCtx = s.start
}
/** Keeps the sound on the transport: a seek, a loop or a pause moves it. */
function syncAudio() {
  if (!samples || !ctx || ctx.state !== 'running') return
  if (!tool.transport.playing) return stopAudio()
  const heard = playFrom + (ctx.currentTime - playCtx)
  if (!player?.playing || Math.abs(heard - tool.transport.time) > 0.12) startAudio()
}
watch(() => tool.transport.playing, (on) => (on ? startAudio() : stopAudio()))

// ------------------------------------------------------------- mic

const mic = ref<MicState>('off')
let micStream: MediaStream | null = null
let micNode: { an: AnalyserNode; buf: Float32Array<ArrayBuffer>; spec: Float32Array<ArrayBuffer>; t0: number; w: TrackWriter } | null = null

async function micStart() {
  if (!navigator.mediaDevices?.getUserMedia) {
    mic.value = 'unsupported'
    return say('no mic here. type a line or drop audio.', 'warn')
  }
  mic.value = 'asking'
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch {
    mic.value = 'blocked'
    return say('the mic is blocked. type a line or drop audio.', 'err')
  }
  stopAudio()
  ctx ??= new AudioContext()
  await ctx.resume?.()
  const an = ctx.createAnalyser()
  an.fftSize = 1024
  ctx.createMediaStreamSource(micStream).connect(an)
  micNode = { an, buf: new Float32Array(an.fftSize), spec: new Float32Array(an.frequencyBinCount), t0: ctx.currentTime, w: new TrackWriter(lead.value) }
  samples = null
  source.value = { name: 'mic', kind: 'mic' }
  mic.value = 'listening'
  tool.pause()
  say(`${SOURCE_WORDS.mic}. up to ${MIC_MAX} s.`, 'busy')
}

function micStep() {
  const m = micNode
  if (!m || !ctx) return
  const due = Math.min(MIC_MAX, ctx.currentTime - m.t0) * FPS
  let f: Float32Array | null = null
  while (m.w.length < due) {
    m.an.getFloatTimeDomainData(m.buf)
    m.an.getFloatFrequencyData(m.spec)
    f = m.w.step(rms(m.buf), bandsFromSpectrum(m.spec, ctx.sampleRate, m.an.fftSize))
  }
  if (f) {
    level.value = rms(m.buf)
    writeMouth(f)
  }
  if (m.w.length >= MIC_MAX * FPS) void micStop()
}

async function micStop() {
  const m = micNode
  micNode = null
  micStream?.getTracks().forEach((k) => k.stop())
  micStream = null
  mic.value = 'off'
  level.value = 0
  if (m && m.w.length) {
    useTrack(m.w.done('mic', 'mic'))
    tool.pause()
    say(`kept ${trackSeconds(track.value!).toFixed(1)} s from the mic. play it back or export the track.`, 'ok')
  }
}

// ------------------------------------------------------------- the mouth

const level = ref(0)
function writeMouth(f: ArrayLike<number>) {
  now.viseme = topViseme(f)
  if (!mouth.value) return
  const w = morphWeights(map.value, f, strength.value)
  mouth.value.write(w)
  now.weight = Math.max(0, ...w.values())
}

function frame() {
  if (micNode) return micStep()
  const t = track.value
  if (!t) return
  writeMouth(frameAt(t, tool.transport.time))
  if (samples && player) {
    syncAudio()
    level.value = player.playing ? player.level() : 0
  }
}

function adopt() {
  const w = tool.walk.value
  if (!w || !bind) return
  mouth.value = bind.mouthOf(w.stage, tool.body.placeholder)
  morphs.value = mouth.value?.names() ?? []
  bind.frameFace(w.stage)
  if (!morphs.value.length) say('this avatar has no mouth shapes. the timeline still plays below.', 'warn')
}

const mouthLine = computed(() => {
  const n = morphs.value.length
  if (!n) return 'this avatar has no mouth shapes. the timeline still plays below.'
  const used = new Set(Object.values(map.value).map((r) => r.morph).filter(Boolean))
  return `${n} shape${n === 1 ? '' : 's'} on ${tool.body.placeholder ? 'the mannequin\'s drawn on mouth' : tool.body.name}; the map drives ${used.size}.`
})

// ------------------------------------------------------------- map

const morphOptions = computed(() => [{ label: 'none', value: '' }, ...morphs.value.map((m) => ({ label: m, value: m }))])
const rows = computed(() => VISEMES.map((v) => ({ viseme: v, ...map.value[v], edited: !!edits.value[v] })))
function setRow(v: Viseme, r: Partial<MapRow>) {
  const next = { ...edits.value, [v]: { ...map.value[v], ...r } }
  edits.value = next
  save((d) => { d.edits = { ...next } })
}
function resetMap() {
  edits.value = {}
  save((d) => { d.edits = {} })
}
watch(strength, (v) => save((d) => { d.strength = v }))
watch(lead, (v) => { save((d) => { d.lead = v }); rebuild() })

// ------------------------------------------------------------- strip

const strip = ref<HTMLCanvasElement | null>(null)
function drawStrip() {
  void nextTick(() => {
    const c = strip.value
    const t = track.value
    if (!c || !t) return
    const box = c.getBoundingClientRect()
    const dpr = Math.min(2, devicePixelRatio || 1)
    c.width = Math.max(1, Math.round(box.width * dpr))
    c.height = Math.max(1, Math.round(box.height * dpr))
    const x = c.getContext('2d')
    if (!x) return
    x.clearRect(0, 0, c.width, c.height)
    const rowsN = VISEMES.length - 1
    const rh = c.height / rowsN
    const n = t.sources.length
    const cw = c.width / n
    x.fillStyle = tone('--hb-slime') || '#8f6'
    for (let i = 0; i < n; i++) {
      for (let k = 1; k < VISEMES.length; k++) {
        const w = t.frames[i * VISEMES.length + k]!
        if (w < 0.02) continue
        x.globalAlpha = Math.min(1, w)
        x.fillRect(i * cw, (k - 1) * rh, Math.max(1, cw), Math.max(1, rh - 1))
      }
    }
    x.globalAlpha = 1
  })
}
const stripAt = computed(() => (tool.transport.duration ? tool.transport.time / tool.transport.duration : null))
const sourceLine = computed(() => (source.value ? SOURCE_WORDS[source.value.kind] : 'none yet'))

// ------------------------------------------------------------- export

const name = computed(() => `${source.value?.name ?? 'line'}-visemes`.replace(/[^\w.-]+/g, '-'))
const formats: HbExportFormat[] = [
  { key: 'visemes', label: 'viseme track', ext: '.visemes.json', note: '15 oculus viseme weights a frame at 60 fps, the runs of the strongest, and the map to this body\'s shapes.' },
  { key: 'doc', label: 'document', ext: lipsyncKind.ext, note: 'the line, the map edits, strength and lead. audio is never in it.' },
]
const readout = computed<HbExportReadout[]>(() => {
  const t = track.value
  if (!t) return []
  return [
    { label: 'frames', value: `${t.sources.length} at ${t.fps} fps` },
    { label: 'seconds', value: trackSeconds(t).toFixed(2) },
    { label: 'voiced', value: `${Math.round(voiced(t) * 100)} percent` },
    { label: 'source', value: t.kind },
  ]
})
const exportBusy = computed(() => (track.value ? '' : 'make a track first: say a line or drop audio.'))

async function onExport(req: HbExportRequest) {
  const fname = req.filename || name.value
  if (req.format === 'doc') {
    const d = doc.doc.value
    if (d) await exportDoc(d.id, { filename: fname })
    return
  }
  const t = track.value
  if (!t) return
  saveFile(`${fname}.visemes.json`, JSON.stringify(trackJson(t, map.value)), 'application/json')
  say(`${fname}.visemes.json saved.`, 'ok')
}

// ------------------------------------------------------------- start

onMounted(async () => {
  await ws.ready()
  const all = (await ws.docs()).filter((d) => d.kind === LIPSYNC_KIND)
  if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  else await doc.create('lipsync')
  const d = doc.body.value
  if (d) {
    text.value = d.text
    edits.value = { ...d.edits }
    strength.value = d.strength
    lead.value = d.lead
  }
  bind = await import('./bind.ts')
  const sent = take()
  if (sent?.audio) await takeAudio(sent.audio, sent.name, sent.words?.length ? 'speech' : 'audio', sent.words)
  else {
    if (sent?.text) text.value = sent.text
    sayText()
    if (d?.source && d.source.kind !== 'text' && !sent) say(`${d.source.name} was not kept: audio stays in the tab it was dropped on. the line stands in.`, 'warn')
  }
})

watch(
  () => tool.walk.value,
  async (w) => {
    if (!w) return
    while (!bind) await new Promise((r) => setTimeout(r, 20))
    offLoaded?.()
    offLoaded = w.stage.on('loaded', () => adopt())
    adopt()
    offPose = bind.afterPose(w.stage, frame)
  },
)

claimDrops({
  accept: (f) => isAudioFile(f) || isBodyFile(f),
  take: (files) => {
    const a = files.find(isAudioFile)
    if (a) void takeAudio(a, a.name)
    else void tool.showBody(files)
  },
})

onBeforeUnmount(() => {
  claimDrops(null)
  offLoaded?.()
  offPose?.()
  void micStop()
  stopAudio()
  void ctx?.close()
})

// for the smoke: the tool handle on the stage host, no global
watch(mouth, (m) => {
  const el = tool.host.value as (HTMLElement & { lipsync?: unknown }) | null
  if (el && m) el.lipsync = { track, map, now, morphs, read: (n: string) => mouth.value?.read(n) ?? 0 }
})

const HOW = `import { LipSync, drive, rms, bandsFromSpectrum, estimateWords } from "@hackbuild/lipsync";

const lips = new LipSync({ lead: 0.04 });
lips.push(estimateWords("hello there", 0, 1.2)); // or word times from a speech engine
function frame(t: number, dt: number) {
  analyser.getFloatTimeDomainData(buf);
  analyser.getFloatFrequencyData(spec);
  lips.setLevel(rms(buf), bandsFromSpectrum(spec, ctx.sampleRate, analyser.fftSize));
  const f = lips.update(t, dt); // f.visemes: 15 oculus weights, f.source says which input moved it
  drive(avatar.expressions, f, "vrm"); // or map each viseme to your own morph
}`
</script>

<template>
  <StageTool :tool="tool" title="lipsync">
    <template #band>
      <HbButton variant="secondary" size="sm" @click="sayText">say</HbButton>
      <HbButton as="label" variant="secondary" size="sm">
        audio
        <input type="file" :accept="AUDIO_ACCEPT" hidden data-import="audio" @change="pickAudio">
      </HbButton>
      <HbMicButton v-model:state="mic" :level="level" @start="micStart" @stop="micStop" />
    </template>

    <template #under>
      <HbWave label="visemes" :value="now.viseme" :at="stripAt" :off="!track" seekable @seek="(a) => tool.seek(a * tool.transport.duration)">
        <canvas ref="strip" data-strip="visemes" />
      </HbWave>
    </template>

    <template #rack>
      <HbFold v-model="open.source" :num="0" summary="source" persist-key="lipsync-source">
        <HbInput v-model="text" aria-label="line to say" placeholder="type a line" @keydown.enter="sayText" />
        <HbKv label="in use" :value="sourceLine" />
        <HbKv label="from" :value="source?.name ?? 'none'" />
        <HbKv label="length" :value="track ? `${trackSeconds(track).toFixed(2)} s, ${track.sources.length} frames` : 'none'" />
        <HbKv label="voiced" :value="track ? `${Math.round(voiced(track) * 100)} percent of frames` : 'none'" />
        <p class="hb-hint">text spreads words by syllables. audio and the mic move the mouth by level and formant bands. speech sent from the speak tool brings its word times.</p>
      </HbFold>

      <HbFold v-model="open.mouth" :num="1" summary="mouth" persist-key="lipsync-mouth">
        <p class="hb-hint" data-pane="mouth">{{ mouthLine }}</p>
        <HbKv label="viseme" :value="now.viseme" />
        <HbMeter :value="now.weight" :max="1" label="mouth" />
        <HbMeter :value="Math.min(1, level * 4)" :max="1" label="level" />
        <HbParamRow v-model="strength" label="strength" :min="0" :max="1.5" :step="0.05" unit="" :default-value="1" help="scales every shape. 1 is the track as made." />
        <HbParamRow v-model="lead" label="lead" :min="0" :max="0.2" :step="0.01" unit="s" :default-value="0.04" help="the mouth moves this far ahead of the sound. default 0.04 s, inferred." />
        <HbButton variant="secondary" size="sm" :disabled="tool.body.placeholder" @click="tool.walk.value?.stage.showPlaceholder()">back to the mannequin</HbButton>
      </HbFold>

      <HbFold v-model="open.map" :num="2" summary="viseme map" persist-key="lipsync-map">
        <div class="hb-instrument" data-pane="map">
          <HbTable :columns="[{ key: 'viseme', label: 'viseme' }, { key: 'morph', label: 'shape' }, { key: 'gain', label: 'gain' }]" :rows="rows as unknown as Record<string, unknown>[]">
            <template #cell-viseme="{ row }"><span :data-viseme="row.viseme">{{ row.viseme }}{{ row.edited ? ' *' : '' }}</span></template>
            <template #cell-morph="{ row }">
              <HbSelect
                :model-value="row.morph as string"
                :options="morphOptions"
                :aria-label="`shape for ${row.viseme}`"
                @update:model-value="(v) => setRow(row.viseme as Viseme, { morph: String(v) })"
              />
            </template>
            <template #cell-gain="{ row }">
              <HbInput
                type="number" min="0" max="1.5" step="0.05" inputmode="decimal"
                :model-value="row.gain as number"
                :aria-label="`gain for ${row.viseme}`"
                @update:model-value="(v) => setRow(row.viseme as Viseme, { gain: Math.min(1.5, Math.max(0, Number(v) || 0)) })"
              />
            </template>
          </HbTable>
          <HbButton variant="secondary" size="sm" :disabled="!Object.keys(edits).length" @click="resetMap">back to the auto map</HbButton>
        </div>
      </HbFold>

      <HbFold v-model="open.export" :num="3" summary="export" persist-key="lipsync-export">
        <HbExportPanel :formats="formats" :name="name" :readout="readout" :busy="exportBusy" label="lipsync" @export="onExport" />
      </HbFold>

      <HbHow
        :packages="['@hackbuild/lipsync', '@hackbuild/speak', '@hackbuild/avatar-host']"
        install="npm i @hackbuild/lipsync"
        :code="HOW"
        persist-key="lipsync-how"
      />
    </template>
  </StageTool>
</template>
