<script setup lang="ts">
// transcribe (rebuild plan 4): scribe as one drop first page. The drop zone
// is the page until a file or a folder is in it, then the transcript is.
// Files queue as channels and run one at a time on a speech model loaded in
// this tab; the rack holds the channels with their levels, the engine, the
// capture front end and the log.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { HbButton, HbCheckbox, HbDropFirst, HbInput, HbLevelRail, HbRackLog, HbSelect, HbSlider } from '@virgilvox/hackbuild-ui'
import type { RackLogLine } from '@virgilvox/hackbuild-ui/vanilla'
import { probe } from '@hackbuild/ai-env'
import { languagesFor } from '@hackbuild/transcribe'
import { openWeightStore } from '@hackbuild/weights'
import { jobLoader, jobRecords, storedIds, transcribeQueue, useModelPick, verifyRepo, type Transcriber, type TranscribeRunOptions } from '@hackbuild/ai-views'
import { ExportMenu, ModelSelect, TranscribeDrop, TranscribeQueue } from '@hackbuild/ai-views/vue'
import type { TranscribeDropHandle } from '@hackbuild/ai-views/elements'
import { chipPick } from '../../shell/chip'

const STUB = new URLSearchParams(location.search).has('stub')

// the log: every run, load and check, timed
const lines = ref<RackLogLine[]>([])
const log = (line: string, level: RackLogLine['level'] = 'info') => (lines.value = [...lines.value.slice(-299), { t: Date.now(), line, level }])

// the engine: every speech model in the catalogue, fitted to this machine
const pick = useModelPick('transcribe', { loader: jobLoader('transcribe') })
const snap = shallowRef(pick.snapshot())
const offPick = pick.subscribe((s) => (snap.value = s))
const langWanted = ref('auto')
const lang = computed(() => languagesFor(pick.record(snap.value.chosen) ?? snap.value.chosen, langWanted.value))
const langValue = computed({ get: () => lang.value.value, set: (v: string) => (langWanted.value = v) })

// a hub repo of your own, checked before it joins the list
const repo = ref('')
const repoNote = ref('')
async function checkRepo() {
  const r = await verifyRepo(repo.value)
  repoNote.value = r.note
  log(`hub repo: ${r.note}`, r.ok ? 'ok' : 'warn')
  if (r.ok) pick.custom('onnx', { repo: repo.value.trim() })
}

// the capture front end, the earlier tool's defaults (vendor)
const targetDb = ref(-20)
const maxGainDb = ref(45)
const denoise = ref('2')
const vadMargin = ref(6)
const hp = ref(80)
const channel = ref<'auto' | 'mix' | 'L' | 'R'>('auto')
const skipSilence = ref(true)
const perReelAgc = ref(true)
const halluc = ref(true)
const showDropped = ref(false)
const runOptions = (): TranscribeRunOptions => ({
  targetDb: targetDb.value, maxGainDb: maxGainDb.value, denoise: Number(denoise.value) as 0 | 1 | 2 | 3, vadMargin: vadMargin.value, hp: hp.value,
  channel: channel.value, skipSilence: skipSilence.value, perReelAgc: perReelAgc.value, halluc: halluc.value, language: langValue.value,
})

// the queue: a file loads the chosen model first when it is not loaded
const run: Transcriber = async (file, ctx) => {
  let model = pick.snapshot().loaded as Transcriber | undefined
  if (!model) {
    const r = pick.snapshot().row
    log(`loading ${r?.name ?? 'the model'}, ${r?.size ?? 'size unknown'}`)
    await pick.load()
    model = pick.snapshot().loaded as Transcriber | undefined
    if (!model) throw new Error(pick.error(pick.snapshot().chosen) ?? 'the model did not load. the engine tab says why.')
  }
  return model(file, ctx)
}
const queue = transcribeQueue({ run, options: runOptions })
const qs = shallowRef(queue.snapshot())
const seen = new Set<string>()
const offQueue = queue.subscribe((s) => {
  qs.value = s
  for (const c of s.channels) {
    const k = `${c.id}:${c.status}`
    if (seen.has(k)) continue
    seen.add(k)
    if (c.status === 'done') log(`${c.name}: ${c.segments.length} lines, ${c.dropped.length} dropped${c.stats ? `, ${c.stats.rtf.toFixed(1)}x realtime` : ''}`, 'ok')
    else if (c.status === 'empty') log(`${c.name}: no speech passed the gate. lower the gate margin or show dropped lines.`, 'warn')
    else if (c.status === 'failed') log(`${c.name}: ${c.error}`, 'error')
  }
})
const empty = computed(() => !qs.value.channels.length)
const picked = computed(() => qs.value.channels.find((c) => c.id === qs.value.selected))
let drop: TranscribeDropHandle | null = null
const setDrop = (d: TranscribeDropHandle) => (drop = d)

const tab = ref('files')
const TABS = [
  { id: 'files', label: 'channels' },
  { id: 'engine', label: 'engine' },
  { id: 'capture', label: 'capture' },
  { id: 'log', label: 'log' },
]
watch(empty, (e) => { if (!e) tab.value = 'files' })

/** A second of quiet as a wav, for the gate's run through the queue. */
function quietWav(name: string): Blob & { name: string } {
  const n = 16000
  const v = new DataView(new ArrayBuffer(44 + n * 2))
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
  tag(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); tag(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, n, true); v.setUint32(28, n * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, n * 2, true)
  return Object.assign(new Blob([v.buffer], { type: 'audio/wav' }), { name })
}
async function sample() {
  queue.add([quietWav('interview-take1.wav'), quietWav('bench-notes.wav')])
  while (queue.snapshot().running || queue.snapshot().channels.some((c) => c.status === 'queued')) await new Promise((r) => setTimeout(r, 100))
}

onMounted(async () => {
  chipPick.value = pick
  ;(window as unknown as { hbExplorer?: unknown }).hbExplorer = { queue, pick, sample }
  if (STUB) {
    const s = await import('./stubs')
    pick.update({ env: s.FIXTURE_ENV, loader: s.stubLoader })
    return
  }
  pick.update({ env: await probe() })
  const store = await openWeightStore().catch(() => null)
  if (store) pick.update({ stored: await storedIds(store, jobRecords('transcribe')) })
})
onBeforeUnmount(() => {
  offPick(), offQueue(), queue.stop()
  if (chipPick.value === pick) chipPick.value = null
})
</script>

<template>
  <HbDropFirst v-model:tab="tab" class="xt" :tabs="TABS" :empty="false" add-label="" rack-label="transcribe">
    <TranscribeDrop :queue="queue" folders :show-dropped="showDropped" title="drop recordings here" note="audio or video, one file, many, or a whole folder. the words are worked out on this machine and nothing is uploaded." sample-label="try a sample" @sample="sample" @drop="setDrop" />
    <template #verbs>
      <template v-if="!empty">
        <HbButton @click="drop?.pick()">add files</HbButton>
        <HbButton @click="drop?.pickFolder()">a folder</HbButton>
        <ExportMenu :queue="queue" tool="hackbuild transcribe" go />
      </template>
    </template>

    <template #tab-files>
      <TranscribeQueue :queue="queue" />
      <HbLevelRail v-if="picked?.rail" :env="picked.rail.db" :vad="picked.rail.kept" :noise-db="picked.stats?.noiseDb ?? null" :thr-db="picked.stats?.thrDb ?? null" :segments="picked.segments" :duration="picked.duration ?? picked.stats?.dur ?? 1" />
      <p v-if="empty" class="hb-note">each file becomes a channel here, with its levels and how fast it ran.</p>
    </template>
    <template #tab-engine>
      <ModelSelect :pick="pick" />
      <label class="hb-field"><span class="hb-label">language</span>
        <HbSelect v-model="langValue" :options="lang.options.map((l) => ({ value: l.code, label: l.name }))" :disabled="lang.locked" aria-label="language" />
      </label>
      <p v-if="lang.reason" class="hb-note">{{ lang.reason }}</p>
      <form class="xt-repo" @submit.prevent="checkRepo">
        <HbInput v-model="repo" placeholder="hub repo, owner/name" aria-label="hub repo id" />
        <HbButton type="submit">check</HbButton>
      </form>
      <p v-if="repoNote" class="hb-note" role="status">{{ repoNote }}</p>
    </template>
    <template #tab-capture>
      <section class="xt-cap">
        <HbSlider v-model="targetDb" label="target speech level" :min="-40" :max="-6" :step="1" unit=" dbfs" />
        <HbSlider v-model="maxGainDb" label="max lift" :min="0" :max="60" :step="1" unit=" db" />
        <label class="hb-field"><span class="hb-label">denoise</span>
          <HbSelect v-model="denoise" :options="[{ value: '0', label: 'off' }, { value: '1', label: 'light' }, { value: '2', label: 'medium' }, { value: '3', label: 'strong' }]" aria-label="denoise" />
        </label>
        <HbSlider v-model="vadMargin" label="gate margin above noise floor" :min="0" :max="20" :step="1" unit=" db" />
        <HbSlider v-model="hp" label="rumble filter" :min="0" :max="200" :step="10" unit=" hz" />
        <label class="hb-field"><span class="hb-label">channel</span>
          <HbSelect v-model="channel" :options="[{ value: 'auto', label: 'auto, pick best' }, { value: 'mix', label: 'mix' }, { value: 'L', label: 'left' }, { value: 'R', label: 'right' }]" aria-label="channel" />
        </label>
        <HbCheckbox v-model="skipSilence">skip silence (faster)</HbCheckbox>
        <HbCheckbox v-model="perReelAgc">re-level each segment</HbCheckbox>
        <HbCheckbox v-model="halluc">suppress phantom text</HbCheckbox>
        <HbCheckbox v-model="showDropped">show dropped lines</HbCheckbox>
      </section>
    </template>
    <template #tab-log>
      <HbRackLog :lines="lines" empty="nothing yet. a run, a load or a check writes here." label="transcribe log" />
    </template>
    <template #detail>
      <p class="hb-note">the front end gates silence out and packs speech into reels of up to 26 s (computed), runs each reel through whisper, then maps the times back to the file. the zip carries txt, srt, vtt and json per file and a manifest with the levels and settings.</p>
    </template>
  </HbDropFirst>
</template>

<style scoped>
.xt { height: calc(100dvh - 52px); }
.xt :deep(.hb-lay-verbs) { display: flex; gap: var(--hb-s-2, 8px); align-items: center; flex-wrap: wrap; }
.xt-repo { display: flex; gap: var(--hb-s-2, 8px); margin-top: var(--hb-s-3, 12px); }
.xt-cap { display: grid; gap: var(--hb-s-3, 12px); }
</style>
