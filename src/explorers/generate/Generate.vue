<script setup lang="ts">
// generate (rebuild plan 4): grommet as a form and frame. The output frame
// fills; the form column reshapes per model (steps range, guidance and a
// negative prompt only where the model takes them), the seed rerolls, and
// the pink action is load (naming the size) until the model is in, then
// generate. Each run lands in the runs tab with its four timings; a press
// puts the picture, prompt and seed back. SD-Turbo, SD 1.5 and SDXL-Turbo
// come from @hackbuild/imagegen through the shared model pick.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { HbButton, HbField, HbFormFrame, HbHistoryStrip, HbInput, HbLicence, HbReadouts, HbSeed, HbSelect, HbSlider, HbTextarea, type HbHistoryItem, type HbReadoutRow } from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import { probe } from '@hackbuild/ai-env'
import { openWeightStore, type WeightStore } from '@hackbuild/weights'
import { formOf } from '@hackbuild/imagegen'
import { jobLoader, jobRecords, storedIds, useModelPick, weightsRemover, type ImageJob } from '@hackbuild/ai-views'
import { chipPick } from '../../shell/chip'

const STUB = new URLSearchParams(location.search).has('stub')

const RECORDS = jobRecords('image')
const pick = useModelPick('image', { loader: jobLoader('image') })
const tick = ref(0)
const offPick = pick.subscribe(() => tick.value++)
const snap = computed(() => (void tick.value, pick.snapshot()))
const rec = computed(() => (pick.record(snap.value.chosen) ?? RECORDS[0])!)
const row = computed(() => snap.value.row)
const form = computed(() => formOf(rec.value) ?? formOf(RECORDS[0])!)
const loading = computed(() => row.value?.state === 'loading')
const job = computed(() => snap.value.loaded as ImageJob | undefined)

// the model line: the three image models with their size, at the point of choice
const modelOptions = computed(() => RECORDS.map((r) => {
  const rw = (void tick.value, pick.snapshot().rows.find((x) => x.id === r.id))
  return { value: r.id, label: `${r.label ?? r.id}, ${rw?.size ?? 'size unknown'}${r.unrunnable ? ', not run yet' : ''}` }
}))
const model = computed({ get: () => snap.value.chosen, set: (id: string) => { pick.choose(id); chipPick.value = pick; fitForm() } })

// the form, reshaped per model
const prompt = ref('a weathered brass diving helmet on a workbench, dramatic side light, 35mm photo')
const negative = ref('')
const steps = ref(2)
const guidance = ref(7.5)
const seed = ref(12345)
const locked = ref(true)
function fitForm() {
  const f = form.value
  steps.value = Math.min(f.steps.max, Math.max(f.steps.min, f.steps.default))
  if (f.guidance) guidance.value = f.guidance.default
}

// runs: newest first, each with its picture, settings and timings
interface Run { id: string; image: string; prompt: string; negative: string; steps: number; guidance: number | null; seed: number; model: string; ms: { text: number; unet: number; vae: number; total: number } }
const runs = ref<Run[]>([])
const current = shallowRef<Run | null>(null)
const busy = ref(false)
const stage = ref('')
const note = ref('')
let stop: AbortController | null = null

async function load() {
  note.value = ''
  try {
    await pick.load()
    const err = pick.error(pick.snapshot().chosen)
    if (err) note.value = `${rec.value.label ?? rec.value.id} did not load: ${err}`
  } catch (e) {
    note.value = `${rec.value.label ?? rec.value.id} did not load: ${e instanceof Error ? e.message : String(e)}`
  }
}
async function generate() {
  const g = job.value
  if (!g || busy.value || !prompt.value.trim()) return
  if (!locked.value) seed.value = Math.floor(Math.random() * 2 ** 31)
  busy.value = true
  stop = new AbortController()
  const t0 = performance.now()
  const f = form.value
  try {
    const out = await g.make({
      prompt: prompt.value.trim(),
      ...(f.negative && negative.value.trim() ? { negative: negative.value.trim() } : {}),
      ...(f.guidance ? { guidance: guidance.value } : {}),
      steps: steps.value,
      seed: seed.value,
      size: f.sizes[0] ?? 512,
      signal: stop.signal,
      onStep: (p) => { stage.value = p.stage === 'denoise' ? `step ${p.step} of ${p.steps}` : p.stage === 'text' ? 'reading the prompt' : 'decoding' },
    })
    const c = document.createElement('canvas')
    c.width = out.width
    c.height = out.height
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(out.rgba), out.width, out.height), 0, 0)
    const r: Run = {
      id: Date.now().toString(36), image: c.toDataURL('image/png'), prompt: prompt.value.trim(), negative: f.negative ? negative.value : '', steps: steps.value,
      guidance: f.guidance ? guidance.value : null, seed: out.seed, model: rec.value.id,
      ms: { text: Math.round(out.ms.text), unet: Math.round(out.ms.unet), vae: Math.round(out.ms.vae), total: Math.round(performance.now() - t0) },
    }
    runs.value = [r, ...runs.value].slice(0, 40)
    current.value = r
    note.value = ''
  } catch (e) {
    note.value = stop?.signal.aborted ? 'stopped.' : `the run failed: ${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = false
    stage.value = ''
    stop = null
  }
}
const pinkLabel = computed(() => (job.value ? (busy.value ? stage.value || 'generating' : 'generate') : loading.value ? `loading ${rec.value.label ?? rec.value.id}` : `load ${rec.value.label ?? rec.value.id}, ${row.value?.size ?? 'size unknown'}`))
const pinkAct = () => (job.value ? void generate() : void load())

const timing = computed<HbReadoutRow[]>(() => {
  const m = current.value?.ms
  const v = (n?: number) => (n === undefined ? '-' : n)
  return [
    { label: 'text enc', value: v(m?.text), unit: 'ms' },
    { label: 'unet', value: v(m?.unet), unit: 'ms' },
    { label: 'vae', value: v(m?.vae), unit: 'ms' },
    { label: 'total', value: v(m?.total), unit: 'ms', focal: true },
  ]
})
const history = computed<HbHistoryItem[]>(() => runs.value.map((r) => ({ id: r.id, thumb: r.image, label: r.prompt, meta: `${RECORDS.find((x) => x.id === r.model)?.label ?? r.model}, seed ${r.seed}, ${r.steps} steps` })))
function restore(it: HbHistoryItem) {
  const r = runs.value.find((x) => x.id === it.id)
  if (!r) return
  if (r.model !== snap.value.chosen) pick.choose(r.model)
  current.value = r
  prompt.value = r.prompt
  negative.value = r.negative
  steps.value = r.steps
  if (r.guidance !== null) guidance.value = r.guidance
  seed.value = r.seed
  locked.value = true
}
const removeRun = (it: HbHistoryItem) => { runs.value = runs.value.filter((r) => r.id !== it.id); if (current.value?.id === it.id) current.value = runs.value[0] ?? null }
const savePng = () => { const r = current.value; if (r) void fetch(r.image).then((b) => b.blob()).then((b) => saveFile(`${r.model}-${r.seed}.png`, b)) }

// more: weights from another repo, clear the stored weights of this model
const repo = ref('')
function useRepo() {
  const id = snap.value.chosen
  const r = repo.value.trim()
  if (!r) return
  pick.update({ records: RECORDS.map((x) => (x.id === id ? { ...x, source: { ...x.source, repo: r } } : x)) })
  note.value = `${rec.value.label ?? id} now loads from ${r}.`
}
async function clearStored() {
  await pick.remove(snap.value.chosen)
  note.value = `the stored ${rec.value.label ?? rec.value.id} weights are gone.`
}

const tab = ref('make')
const TABS = [
  { id: 'make', label: 'make' },
  { id: 'runs', label: 'runs' },
  { id: 'more', label: 'more' },
]

// keys: ctrl enter generates from anywhere; esc stops a run
function onKey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); pinkAct() }
  else if (e.key === 'Escape' && busy.value) { e.preventDefault(); stop?.abort() }
}

let store: WeightStore | null = null
onMounted(async () => {
  chipPick.value = pick
  document.addEventListener('keydown', onKey)
  // the test hook, for smokes and gates only
  if (STUB || import.meta.env.DEV) (window as unknown as { hbExplorer?: unknown }).hbExplorer = { pick, generate, load, restore: (i: number) => runs.value[i] && restore({ id: runs.value[i]!.id }), state: () => ({ runs: runs.value.length, current: current.value, prompt: prompt.value, seed: seed.value, steps: steps.value, form: form.value }), choose: (id: string) => (model.value = id), setSeed: (n: number) => (seed.value = n) }
  if (STUB) {
    const s = await import('./stubs')
    pick.update({ env: s.FIXTURE_ENV, loader: s.stubLoader })
    fitForm()
    return
  }
  pick.update({ env: await probe() })
  fitForm()
  store = await openWeightStore().catch(() => null)
  if (store) pick.update({ stored: await storedIds(store, RECORDS), onRemove: weightsRemover(store) })
})
onBeforeUnmount(() => {
  offPick()
  stop?.abort()
  document.removeEventListener('keydown', onKey)
  if (chipPick.value === pick) chipPick.value = null
})
</script>

<template>
  <HbFormFrame v-model:tab="tab" class="xg" :tabs="TABS" rack-label="generate">
    <figure class="xg-frame" :aria-busy="busy">
      <img v-if="current" :src="current.image" :alt="`made from: ${current.prompt}`">
      <div v-else class="hb-lay-empty xg-empty">
        <span class="hb-lay-empty-name">no signal</span>
        <p class="hb-lay-empty-note">{{ job ? 'type a prompt, then generate. ctrl enter works from anywhere.' : 'pick a model, load it, then generate. the first load fetches the weights and keeps them on this machine.' }}</p>
      </div>
      <figcaption v-if="busy" class="xg-busy" role="status">{{ stage || 'generating' }}</figcaption>
    </figure>
    <template #verbs>
      <HbButton variant="go" class="xg-phone" :loading="loading" @click="pinkAct">{{ pinkLabel }}</HbButton>
      <HbButton v-if="current" @click="savePng">download png</HbButton>
    </template>

    <template #tab-make>
      <HbSelect v-model="model" label="model" :options="modelOptions" />
      <p class="hb-note">{{ form.note }}</p>
      <HbField label="prompt" for="xg-prompt">
        <HbTextarea id="xg-prompt" v-model="prompt" :rows="3" placeholder="describe an image" />
      </HbField>
      <HbField v-if="form.negative" label="negative prompt" for="xg-neg">
        <HbTextarea id="xg-neg" v-model="negative" :rows="2" placeholder="what to keep out" />
      </HbField>
      <HbSlider v-if="form.guidance" v-model="guidance" label="guidance scale" :min="form.guidance.min" :max="form.guidance.max" :step="form.guidance.step" />
      <HbSlider v-model="steps" :label="`steps, ${form.steps.min} fastest, ${form.steps.max} most detail`" :min="form.steps.min" :max="form.steps.max" :step="1" />
      <HbSeed v-model="seed" v-model:locked="locked" label="seed" />
      <HbButton variant="go" class="xg-desk" block :loading="loading" @click="pinkAct">{{ pinkLabel }}</HbButton>
      <HbButton v-if="busy" @click="stop?.abort()">stop</HbButton>
      <p v-if="note" class="hb-note" role="status">{{ note }}</p>
      <HbReadouts v-if="current" :rows="timing" />
    </template>
    <template #tab-runs>
      <HbHistoryStrip :items="history" :current="current?.id ?? null" removable empty="runs appear here. a press puts the picture, prompt and seed back." @restore="restore" @remove="removeRun" />
    </template>
    <template #tab-more>
      <HbField label="load this model from another hugging face repo" for="xg-repo">
        <HbInput id="xg-repo" v-model="repo" :placeholder="rec.source?.repo ?? 'owner/name'" @keydown.enter="useRepo" />
      </HbField>
      <HbButton v-if="repo.trim()" @click="useRepo">use this repo</HbButton>
      <HbButton v-if="row?.state === 'stored' || row?.state === 'loaded'" @click="clearStored">clear the stored {{ rec.label ?? rec.id }} weights</HbButton>
      <HbLicence v-for="r in RECORDS" :key="r.id" quiet :licence="r.licence" :commercial="r.commercial ?? null" :what="r.label ?? r.id" />
      <p class="hb-note">no safety checker runs on any of these. you are responsible for what you make. read each licence before commercial use. needs webgpu and several gb of video memory, sdxl-turbo most of all.</p>
    </template>
  </HbFormFrame>
</template>

<style scoped>
.xg { height: calc(100dvh - 52px); }
.xg-frame { position: relative; margin: 0; width: min(100%, calc(100dvh - 140px)); aspect-ratio: 1; display: flex; align-items: center; justify-content: center; border: 1.5px solid var(--hb-void-line, #444); }
.xg-frame img { width: 100%; height: 100%; object-fit: contain; }
.xg-empty { color: var(--hb-paper, #fffdf7); }
.xg-empty .hb-lay-empty-note { color: var(--hb-paper-edge, #c9c1ae); }
.xg :deep(.hb-lay-verbs) { display: flex; gap: var(--hb-s-2, 8px); flex-wrap: wrap; }
.xg-phone { display: none; }
@media (max-width: 900px) { .xg-phone { display: inline-flex; } .xg-desk { display: none; } }
.xg-busy { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 12px; font-family: var(--hb-utility, monospace); background: var(--hb-ink, #1a1a1a); color: var(--hb-paper, #fffdf7); }
</style>
