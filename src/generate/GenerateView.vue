<script setup lang="ts">
// The image generation tool (design 3.7, GROMMET F-6 kept whole). The
// status line checks webgpu; a model card picks the model and the form
// reshapes to it (steps range, guidance and a negative prompt only where
// it takes them); the load button names the size and its source. Generate
// runs through the hub under its gpu lock with the step named on the
// stage and stop live; the run lands with four timing cells and a log
// line, in a history strip that puts its settings back on the form. Two
// runs compare on a wipe; the png carries its settings, a sidecar json
// holds them too, and a run can go on to vision.
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbButton, HbConsole, HbField, HbHistoryStrip, HbHow, HbLicence, HbMethodCard, HbPanel, HbProgress, HbReadouts, HbSeed, HbSelect,
  HbSlider, HbSplit, HbStatusLine, HbTextarea, HbToolbar, HbViewport, useHotkeys,
  type HbConsoleLine, type HbHistoryItem, type HbReadoutRow,
} from '@virgilvox/hackbuild-ui'
import { exportName, nextSeed, rollSeed, saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { FormError, formOf, IMAGEGEN_RECORDS, loadImagegen, loadLabel as sizeLabel, type ImageForm } from '@hackbuild/imagegen'
import type { ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, usePrimary, useStop } from '../shell/shell.ts'
import { exportDoc, kinds, pickFiles, registerKind, useDocument, ws } from '../workspace/state'
import {
  GEN_KIND, genKind, newSession, PNG_KEY, pngWithText, reuse, runLine, sidecar, SIDECAR_EXT, withRun,
  type GenBody, type Run,
} from './kind.ts'
import SendTo from '../shell/SendTo.vue'
import type { SendOffer } from '../workspace/sendto'
import { addGenerateRuntimes, clipTokenizer, stubTokenize } from './runtimes.ts'
import how from '@hackbuild/imagegen/how'

if (!kinds.get(GEN_KIND)) registerKind(genKind())

const route = useRoute()
const doc = useDocument<GenBody>(GEN_KIND)
const body = computed<GenBody>(() => doc.doc.value?.body ?? newSession())
const current = computed<Run | null>(() => body.value.runs.find((r) => r.id === body.value.current) ?? body.value.runs[0] ?? null)
const set = <K extends keyof GenBody>(k: K, v: GenBody[K]) => { if (body.value[k] !== v) doc.edit((b) => { b[k] = v }) }

// The timed log (P-LOAD-15): a box in the tool, every line also in the shell log.
const lines = ref<HbConsoleLine[]>([])
function log(text: string, level: HbConsoleLine['level'] = 'info'): void {
  lines.value = [...lines.value.slice(-99), { text, level, t: new Date().toTimeString().slice(0, 8) }]
  logEvent(level === 'err' ? 'fail' : level === 'warn' ? 'warn' : 'note', `generate: ${text}`)
}

// The status line (P-FAIL-6): one place for state and failure, each failure with what to do.
const status = ref<{ text: string; kind: 'none' | 'ok' | 'warn' | 'err' | 'info' | 'busy' }>({ text: 'checking webgpu.', kind: 'busy' })
const say = (text: string, kind: typeof status.value.kind = 'info') => { status.value = { text, kind } }

// Models: one card each; the form follows the picked one (P-GEN-1).
const booted = ref(false)
const records = computed<ModelRecord[]>(() => { void hub.allRecords.value; return booted.value ? IMAGEGEN_RECORDS.map((r) => hub.registry.get(r.id) ?? r) : IMAGEGEN_RECORDS })
const record = computed<ModelRecord>(() => records.value.find((r) => r.id === body.value.model) ?? records.value[0]!)
const form = computed<ImageForm>(() => formOf(record.value) ?? IMAGEGEN_RECORDS[0]!.form)
const stateOf = (r: ModelRecord) => hub.states.value[r.id]?.state ?? 'none'
const ready = computed(() => ['loaded', 'stored'].includes(stateOf(record.value)))
const noGpu = computed(() => booted.value && !hub.STUB && hub.env.value?.webgpu === false)
const sizeWord = (r: ModelRecord) => (r.sizeMB === null ? 'size unknown' : `about ${(r.sizeMB / 1000).toFixed(1)} gb (${r.sizeSource})`)
const cards = computed(() => records.value.map((r) => {
  const s = stateOf(r)
  return {
    id: r.id, label: r.label ?? r.id, trade: formOf(r)?.note ?? '', sizeMB: r.sizeMB,
    time: `${formOf(r)?.steps.default ?? 1} steps`,
    state: noGpu.value ? 'unsupported' as const : s === 'loaded' ? 'ready' as const : s === 'stored' ? 'stored' as const : s === 'downloading' ? 'loading' as const : s === 'fault' ? 'failed' as const : 'download' as const,
    notice: s === 'fault' ? hub.states.value[r.id]?.error ?? '' : '',
  }
}))
function pick(id: string): void {
  const f = formOf(records.value.find((r) => r.id === id))
  if (!f || id === body.value.model) return
  doc.edit((b) => {
    b.model = id
    b.steps = f.steps.default
    b.guidance = f.guidance?.default ?? null
    b.size = f.sizes.includes(b.size) ? b.size : f.sizes[0]!
  })
  idle()
}
const source = computed(() => `${record.value.source.repo ?? record.value.source.url ?? record.value.id}, ${sizeWord(record.value)}`)

// Load (P-LOAD-6, P-LOAD-3): the button is the consent; per file rows while it fetches.
const files = ref<Record<string, number | null>>({})
const loadText = computed(() => (stateOf(record.value) === 'downloading' ? `loading ${record.value.label}` : sizeLabel(record.value)))
const loadState = computed(() => hub.states.value[record.value.id])
async function load(): Promise<void> {
  const r = record.value
  if (noGpu.value) return say('no webgpu adapter. image generation needs one and has no cpu path here.', 'err')
  files.value = {}
  log(`loading ${r.label}, ${sizeWord(r)}. this is stored for next time.`, 'info')
  say(`loading ${r.label}, ${sizeWord(r)}. this is stored for next time.`, 'busy')
  const t0 = performance.now()
  await hub.load(r.id)
  const s = stateOf(r)
  if (s === 'fault') {
    const why = hub.states.value[r.id]?.error ?? 'the model failed to load'
    log(why, 'err')
    say(`${why} pick the other model, or free space in the model manager.`, 'err')
  } else if (s === 'loaded' || s === 'stored') {
    log(`${r.label} ready, ${((performance.now() - t0) / 1000).toFixed(1)} s (measured).`, 'ok')
    say(`${r.label} loaded. ctrl+enter generates.`, 'ok')
  } else say(`stopped loading ${r.label}. finished files are kept.`, 'warn')
}
const stopLoad = () => hub.cancel(record.value.id)

// The form (P-GEN-4): prompt, negative where taken, steps, guidance where taken, size, seed with lock and reroll.
const prompt = computed({ get: () => body.value.prompt, set: (v: string) => set('prompt', v) })
const negative = computed({ get: () => body.value.negative, set: (v: string) => set('negative', v) })
const steps = computed({ get: () => body.value.steps, set: (v: number) => set('steps', v) })
const guidance = computed({ get: () => body.value.guidance ?? form.value.guidance?.default ?? 1, set: (v: number) => set('guidance', v) })
const size = computed({ get: () => String(body.value.size), set: (v: string) => set('size', Number(v)) })
const sizeOptions = computed(() => form.value.sizes.map((s) => ({ value: String(s), label: `${s} by ${s}` })))
const seed = computed({ get: () => body.value.seed, set: (v: number) => set('seed', v) })
const locked = computed({ get: () => body.value.locked, set: (v: boolean) => set('locked', v) })
const reroll = () => { seed.value = rollSeed() }

// Generate (P-LOAD-14, P-GEN-2): the stage names the step; stop is live.
const running = ref(false)
const phase = ref('')
let stop: AbortController | null = null
async function generateNow(): Promise<void> {
  if (running.value) return
  await bootReady
  const r = record.value
  if (noGpu.value) return say('no webgpu adapter. image generation needs one and has no cpu path here.', 'err')
  if (!ready.value) return say(`no model loaded. ${r.label} is ${sizeWord(r)} and needs webgpu. press load first.`, 'warn')
  if (!body.value.prompt.trim()) return say('type a prompt first.', 'warn')
  const b = body.value
  const settings = { model: r.id, prompt: b.prompt.trim(), negative: form.value.negative ? b.negative.trim() : '', seed: b.seed, steps: b.steps, guidance: form.value.guidance ? b.guidance ?? form.value.guidance.default : null, size: b.size }
  running.value = true
  stop = new AbortController()
  phase.value = 'encoding prompt'
  say(`generating with ${r.label}, seed ${settings.seed}, ${settings.steps} steps.`, 'busy')
  const t0 = performance.now()
  let gen: Awaited<ReturnType<typeof loadImagegen>> | null = null
  try {
    const tokenize = hub.STUB ? stubTokenize : await clipTokenizer(form.value.tokenizer)
    gen = await loadImagegen(hub.hub(), { id: r.id })
    const img = await gen.generate(tokenize, {
      prompt: settings.prompt, negative: settings.negative, seed: settings.seed, steps: settings.steps, size: settings.size,
      ...(settings.guidance === null ? {} : { guidance: settings.guidance }),
      signal: stop.signal,
      onStep: (p) => { phase.value = p.stage === 'text' ? `denoising, step 1 of ${p.steps}` : p.stage === 'denoise' ? (p.step < p.steps ? `denoising, step ${p.step + 1} of ${p.steps}` : 'decoding image') : 'done' },
    })
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    c.getContext('2d')!.putImageData(new ImageData(img.rgba as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
    const total = Math.round(performance.now() - t0)
    const run: Run = { ...settings, id: Date.now().toString(36), at: Date.now(), ms: { text: Math.round(img.ms.text), unet: Math.round(img.ms.unet), vae: Math.round(img.ms.vae), total }, image: c.toDataURL('image/png') }
    doc.edit((x) => {
      const n = withRun(x, run)
      if (!x.locked) n.seed = nextSeed(x.seed, false)
      return n
    })
    log(runLine(run), 'ok')
    say(`done in ${(total / 1000).toFixed(1)} s (measured). ${body.value.locked ? 'the seed is locked; generate again gives the same image.' : `next seed ${body.value.seed}.`}`, 'ok')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (stop.signal.aborted) {
      log(`stopped at ${phase.value}.`, 'warn')
      say(`stopped at ${phase.value}. nothing was kept.`, 'warn')
    } else if (err instanceof FormError) say(msg, 'err')
    else if (/out of memory|oom/i.test(msg)) { log(msg, 'err'); say('the gpu ran out of memory during decode. unload the chat model and try again.', 'err') }
    else if (/device.*lost|lost.*device/i.test(msg)) { log(msg, 'err'); say(`the gpu device was lost at ${phase.value}. close other gpu tabs, then generate again.`, 'err') }
    else { log(msg, 'err'); say(`generate failed: ${msg}. load the model again, or pick the other one.`, 'err') }
  } finally {
    gen?.release()
    running.value = false
    phase.value = ''
    stop = null
  }
}
const stopNow = () => stop?.abort()

// The stage: empty, busy and done share one frame (P-GEN-2), with four timing cells.
const coverTitle = computed(() => (running.value ? phase.value : current.value ? '' : 'no signal'))
const coverNote = computed(() =>
  running.value ? `${record.value.label}, seed ${body.value.seed}. esc stops.`
    : current.value ? '' : noGpu.value ? 'no webgpu adapter. image generation needs one and has no cpu path here.'
      : ready.value ? 'type a prompt, then generate. ctrl+enter works from anywhere.' : `no model loaded. ${record.value.label} is ${sizeWord(record.value)} and needs webgpu.`,
)
const timing = computed<HbReadoutRow[]>(() => {
  const m = current.value?.ms
  const v = (n?: number) => (n === undefined ? '-' : n)
  return [
    { label: 'text enc (measured)', value: v(m?.text), unit: 'ms' },
    { label: 'unet (measured)', value: v(m?.unet), unit: 'ms' },
    { label: 'vae (measured)', value: v(m?.vae), unit: 'ms' },
    { label: 'total (measured)', value: v(m?.total), unit: 'ms', focal: true },
  ]
})

// History (P-GEN-3): newest first; a press shows the run and puts its settings back on the form.
const history = computed<HbHistoryItem[]>(() => body.value.runs.map((r) => ({ id: r.id, thumb: r.image, label: r.prompt, meta: runLine(r) })))
function restore(it: HbHistoryItem | Run): void {
  const r = body.value.runs.find((x) => x.id === it.id)
  if (!r) return
  doc.edit((b) => ({ ...reuse(b, r), current: r.id, compare: b.current !== r.id ? b.current : b.compare }))
  say(`settings of seed ${r.seed} are back on the form.`, 'info')
}
const removeRun = (it: HbHistoryItem) => doc.edit((b) => {
  b.runs = b.runs.filter((r) => r.id !== it.id)
  if (b.current === it.id) b.current = b.runs[0]?.id ?? null
  if (b.compare === it.id || b.compare === b.current) b.compare = b.runs.find((r) => r.id !== b.current)?.id ?? null
})
function walk(d: number): void {
  const i = body.value.runs.findIndex((r) => r.id === current.value?.id)
  const r = body.value.runs[i + d]
  if (r) restore(r)
}

// Compare: the current run against another on a wipe.
const other = computed<Run | null>(() => body.value.runs.find((r) => r.id === body.value.compare && r.id !== current.value?.id) ?? body.value.runs.find((r) => r.id !== current.value?.id) ?? null)
const compareId = computed({ get: () => other.value?.id ?? '', set: (v: string) => set('compare', v) })
const compareOptions = computed(() => body.value.runs.filter((r) => r.id !== current.value?.id).map((r) => ({ value: r.id, label: `seed ${r.seed}, ${r.model}, ${r.steps} steps` })))
const wipe = ref(50)

// Save (P-GEN-6): the name carries the run; the png holds its settings in a text chunk, the sidecar too.
const nameOf = (r: Run) => exportName(['generate', r.model, r.seed])
async function savePng(): Promise<void> {
  const r = current.value
  if (!r) return say('nothing to save yet. generate first.', 'warn')
  const bytes = new Uint8Array(await (await fetch(r.image)).arrayBuffer())
  saveFile(`${nameOf(r)}.png`, new Blob([pngWithText(bytes, PNG_KEY, sidecar(r)) as BlobPart], { type: 'image/png' }), 'image/png')
  log(`saved ${nameOf(r)}.png with its settings inside.`, 'ok')
}
function saveSidecar(): void {
  const r = current.value
  if (!r) return say('nothing to save yet. generate first.', 'warn')
  saveFile(`${nameOf(r)}${SIDECAR_EXT}`, sidecar(r), 'application/json')
}
// The strip as one zip: each run's png with its settings inside, beside its sidecar.
async function saveZip(): Promise<void> {
  const runs = body.value.runs
  if (!runs.length) return say('nothing to zip yet. generate first.', 'warn')
  const { zipStore } = await import('@hackbuild/audio-dsp')
  const entries: { name: string; data: string | Uint8Array }[] = []
  for (const r of runs) {
    const bytes = new Uint8Array(await (await fetch(r.image)).arrayBuffer())
    entries.push({ name: `${nameOf(r)}.png`, data: pngWithText(bytes, PNG_KEY, sidecar(r)) }, { name: `${nameOf(r)}${SIDECAR_EXT}`, data: sidecar(r) })
  }
  const name = `${exportName(['generate', 'runs', runs.length])}.zip`
  saveFile(name, new Blob([zipStore(entries) as BlobPart], { type: 'application/zip' }), 'application/zip')
  log(`saved ${name} with ${runs.length} runs and their settings.`, 'ok')
}
const exportSession = () => doc.doc.value && void exportDoc(doc.doc.value.id)

// Send to (design 1.2): the run as an image to vision, masks and relief.
const offers = computed<SendOffer[]>(() => [{
  type: 'image', what: 'image', ready: !!current.value,
  get: () => (current.value ? { type: 'image', name: `seed ${current.value.seed}`, frame: { image: current.value.image, width: current.value.size, height: current.value.size } } : null),
}])

// Keys (P-KEY-1): ctrl+enter generates, r rerolls, esc stops, left and right walk the strip.
usePrimary(() => void generateNow())
useStop(() => { if (running.value) stopNow() })
useHotkeys([
  { keys: 'r', label: 'new seed', group: 'tool', run: reroll },
  { keys: 'left', label: 'newer run', group: 'tool', run: () => walk(-1) },
  { keys: 'right', label: 'older run', group: 'tool', run: () => walk(1) },
])

function idle(): void {
  if (running.value) return
  if (noGpu.value) say('no webgpu adapter. image generation needs one and has no cpu path here.', 'err')
  else if (ready.value) say(`webgpu ready, ${record.value.label} loaded.`, 'ok')
  else say(`webgpu ready, model not loaded. ${record.value.label} is ${sizeWord(record.value)}.`, 'info')
}

let bootDone!: () => void
const bootReady = new Promise<void>((r) => { bootDone = r })
watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void doc.open(id) })
onMounted(async () => {
  await ws.ready()
  const q = route.query.doc
  if (typeof q === 'string') await doc.open(q)
  else {
    const all = (await ws.docs()).filter((d) => d.kind === GEN_KIND)
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
    else await doc.create('images')
  }
  await loadModels()
  await hub.start()
  await addGenerateRuntimes((id, file, f) => { if (id === record.value.id) files.value = { ...files.value, [file]: f } })
  booted.value = true
  bootDone()
  idle()
  log(hub.STUB ? 'stub models: the picture comes from the seed alone and nothing is fetched.' : `webgpu ${hub.env.value?.webgpu ? 'found' : 'missing'}.`, hub.env.value?.webgpu || hub.STUB ? 'ok' : 'warn')
})
</script>

<template>
  <div class="hb-toolpage is-split">
    <HbPanel heading="model" class="is-side">
      <HbStatusLine :text="status.text" :kind="running ? 'busy' : status.kind" />
      <div class="hb-methods" role="radiogroup" aria-label="image model">
        <HbMethodCard
          v-for="c in cards"
          :key="c.id"
          :label="c.label"
          :trade="c.trade"
          :time="c.time"
          :size-m-b="c.sizeMB"
          :state="c.state"
          :notice="c.notice"
          :active="c.id === record.id"
          @pick="pick(c.id)"
        />
      </div>
      <p class="hb-hint">{{ source }}.</p>
      <HbToolbar v-if="!ready">
        <HbButton variant="secondary" size="sm" :loading="stateOf(record) === 'downloading'" :disabled="noGpu" @click="load">{{ loadText }}</HbButton>
        <HbButton v-if="stateOf(record) === 'downloading'" variant="ghost" size="sm" @click="stopLoad">stop</HbButton>
      </HbToolbar>
      <HbProgress
        v-if="loadState?.state === 'downloading'"
        :label="record.label"
        :loaded="loadState.loaded"
        :total="loadState.total"
        state="running"
      />
      <HbProgress v-for="(f, name) in files" :key="name" quiet :label="String(name)" :loaded="(f ?? 0) * 100" :total="f === null ? null : 100" :state="f === 1 ? 'done' : 'running'" :text="`${name}, ${f === null ? 'size unknown' : `${Math.round(f * 100)} percent`}`" />

      <HbField label="prompt" for="gen-prompt">
        <HbTextarea id="gen-prompt" v-model="prompt" :rows="3" />
      </HbField>
      <HbField v-if="form.negative" label="negative prompt" for="gen-neg" hint="what to keep out">
        <HbTextarea id="gen-neg" v-model="negative" :rows="2" />
      </HbField>
      <HbSlider v-model="steps" label="steps" :min="form.steps.min" :max="form.steps.max" :step="1" />
      <HbSlider v-if="form.guidance" v-model="guidance" label="guidance" :min="form.guidance.min" :max="form.guidance.max" :step="form.guidance.step" />
      <HbSelect v-model="size" label="size" :options="sizeOptions" />
      <HbSeed v-model="seed" v-model:locked="locked" @reroll="reroll" />
      <HbToolbar>
        <HbButton :loading="running" :disabled="running" @click="generateNow">generate</HbButton>
        <HbButton v-if="running" variant="secondary" size="sm" @click="stopNow">stop</HbButton>
      </HbToolbar>
      <HbConsole :lines="lines" empty="load a model, then generate. each step lands here with its time." height="112px" />
    </HbPanel>

    <div class="hb-toolpage">
      <HbPanel :heading="doc.doc.value?.name ?? 'images'">
        <HbViewport aspect="1/1" label="the generated image" :cover-title="coverTitle" :cover-note="coverNote">
          <img v-if="current" :src="current.image" :alt="`generated: ${current.prompt}`" />
        </HbViewport>
        <HbReadouts :rows="timing" />
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :disabled="!current" @click="savePng">save png</HbButton>
          <HbButton variant="secondary" size="sm" :disabled="!current" @click="saveSidecar">settings json</HbButton>
          <SendTo from="generate" :offers="offers" />
          <HbButton variant="secondary" size="sm" @click="exportSession">export</HbButton>
          <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
          <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
        </HbToolbar>
      </HbPanel>

      <HbPanel heading="runs">
        <HbHistoryStrip :items="history" :current="current?.id ?? null" empty="runs appear here. a press puts the settings back." @restore="restore" @remove="removeRun" />
        <HbToolbar>
          <HbButton variant="secondary" size="sm" :disabled="!body.runs.length" @click="saveZip">download all as zip</HbButton>
        </HbToolbar>
      </HbPanel>

      <HbPanel v-if="current && other" heading="compare">
        <HbSelect v-model="compareId" label="against" :options="compareOptions" />
        <HbSplit v-model="wipe" ratio="1 / 1" :labels="[`seed ${other.seed}`, `seed ${current.seed}`]">
          <template #left><img :src="other.image" :alt="`seed ${other.seed}`" /></template>
          <template #right><img :src="current.image" :alt="`seed ${current.seed}`" /></template>
        </HbSplit>
      </HbPanel>

      <HbPanel heading="licences">
        <HbLicence v-for="r in records" :key="r.id" quiet :licence="r.licence" :commercial="r.commercial ?? null" :what="r.label" />
        <p class="hb-hint">no safety checker runs on any of these. you are responsible for what you generate. read each licence before commercial use.</p>
      </HbPanel>

      <HbHow v-bind="how" persist-key="generate-how" />
    </div>
  </div>
</template>
