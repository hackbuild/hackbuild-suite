<script setup lang="ts">
// character (rebuild plan 4; originals ferrule, live2d-companion, sonic): a
// gate over the live stage, then the stage and a rack of five tabs. A body
// on the stage talks with a chat model loaded in this tab, speaks its replies
// with the mouth on the audio's word times, recalls notes from a memory you
// can search, and wears any body dropped on it.
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { probe, type Env } from '@hackbuild/ai-env'
import type { ChatEngine } from '@hackbuild/chat'
import { canClone, chatList, jobLoader, personaRack, speaker, useModelPick, type Job, type Loader, type MemoryUsed, type ModelPick, type PersonaPresetX, type PickSnapshot } from '@hackbuild/ai-views'
import type { MemoryPaneHandle } from '@hackbuild/ai-views/elements'
import { ChatPane, Composer, MemoryPane, ModelSelect, PersonaRack, SessionMenu, SourcesDrop, VoiceClone } from '@hackbuild/ai-views/vue'
import { hashedEmbedder, loadCore, open, type Embedder, type Memory, type StoredItem } from '@hackbuild/memory'
import { MEMORY_WASM_BASE64 } from '@hackbuild/memory/inline'
import { SegmentCutter, type Engine } from '@hackbuild/speak'
import { characterStage, type CharacterStageHandle, type Speech, type Verb } from '@hackbuild/motion-views/vanilla'
import { AvatarDrop } from '@hackbuild/motion-views/vue'
import { HbGateCheck, HbMicButton, HbRack, HbSelect, HbSlider, HbToggleRow } from '@virgilvox/hackbuild-ui'
import { chipPick } from '../../shell/chip'
import { HUMAN_GLB } from '../../shell/dog'
import { FLAWS, LENGTHS, brain as makeBrain, type BrainSettings } from './brain'

// the gate and the smokes, and only they, open ?stub: stand ins for this machine and the network
const STUB = new URLSearchParams(location.search).has('stub')
const hooks: { env?: Env; loaderFor?: (job: Job) => Loader } = {}

const SYSTEM = 'you are a person living in a 3d body inside a browser tab. you talk like yourself, not like an assistant. keep to what you know; when a note from memory fits, use it.'
const TABS = [{ id: 'talk', label: 'talk' }, { id: 'memory', label: 'memory' }, { id: 'voice', label: 'voice' }, { id: 'body', label: 'body' }, { id: 'brain', label: 'brain' }]

// --- model picks: brain, voice, memory; each loads only when pressed
const loader = (job: Job) => hooks.loaderFor?.(job) ?? jobLoader(job)
const brainPick = shallowRef<ModelPick | null>(null)
const voicePick = shallowRef<ModelPick | null>(null)
const embedPick = shallowRef<ModelPick | null>(null)
const brainSnap = shallowRef<PickSnapshot | null>(null)
const voiceSnap = shallowRef<PickSnapshot | null>(null)
const offs: Array<() => void> = []

// --- the stage
const stageEl = ref<HTMLElement | null>(null)
const stage = shallowRef<CharacterStageHandle | null>(null)
const doing = ref('idle')
const bodyName = ref('stand in body')
const bodyLoaded = ref(false)
const framing = ref<'bust' | 'full'>('bust')
const caption = ref('')

// --- the gate
const awake = ref(false)
const waking = ref(false)
const withVoice = ref(true)
const gateNote = ref('')
const memoryState = ref<'wait' | 'load' | 'ok' | 'err'>('load')

// --- the brain tab
const settings = reactive<BrainSettings>({ temperature: 0.8, register: 'slack', length: 2, flaws: 1 })
const REGISTERS = [{ value: 'slack', label: 'a person, chat register' }, { value: 'terminal', label: 'a developer, terminal register' }]
// character presets: one press loads a persona; saved ones stay in this browser
const PRESETS: PersonaPresetX[] = [
  { label: 'twin', persona: { name: 'twin', profile: SYSTEM, notes: '', rules: '' } },
  { label: 'shop hand', persona: { name: 'shop hand', profile: 'you run the front desk of a small maker space. you know the tools, the bookings and the rules, and you answer in a line or two.', notes: '', rules: 'never promise a booking. say who to ask.' } },
  { label: 'night owl', persona: { name: 'night owl', profile: 'you are up late in a quiet workshop, half working on a build. you talk slow and dry and get to the point.', notes: '', rules: '' } },
]
const SAVED = 'character-presets'
const savedPresets = (): PersonaPresetX[] => { try { return JSON.parse(localStorage.getItem(SAVED) ?? '[]') as PersonaPresetX[] } catch { return [] } }
const rack = personaRack({ presets: PRESETS, saved: savedPresets(), onSave: (p) => { try { localStorage.setItem(SAVED, JSON.stringify(p)) } catch { /* storage blocked: kept for this visit */ } } })
const brain = makeBrain(() => settings, () => rack.system([], 3000).text)

// --- memory
let mem: Memory | null = null
const memRef = shallowRef<Memory | null>(null)
const notes = shallowRef<StoredItem[]>([])
const pane = shallowRef<MemoryPaneHandle | null>(null)
const core = loadCore({ base64: MEMORY_WASM_BASE64 })
const openMemory = (embed: Embedder) => core.then((c) => open('character', { core: c, embed })).then((m) => ((mem = m), (memRef.value = m), (notes.value = m.all()), m))
const ready = openMemory(hashedEmbedder()).then(() => (memoryState.value = 'ok')).catch(() => (memoryState.value = 'err'))
const recall = async (q: string): Promise<MemoryUsed[]> => {
  await ready
  if (!mem || !mem.all().length) return []
  const r = await mem.recall(q, { k: 3 })
  return r.hits.map((h) => ({ label: h.item.text, score: Math.min(1, h.score) }))
}
const memChanged = () => (notes.value = mem?.all() ?? [])
// files and folders into memory: text, pdf, docx, zip and mail
const readIn = async (files: File[], o: { onFile: (e: { name: string; chunks: number; note?: string }) => void }) => {
  await ready
  if (!mem) return { files: 0, chunks: 0 }
  const { ingest } = await import('@hackbuild/memory/ingest')
  const r = await ingest(mem, files, { onFile: o.onFile })
  memChanged()
  pane.value?.refresh()
  return r
}

// --- the thread
const list = chatList({ recall, system: '', noEngine: 'he has no brain loaded. pick one in the brain tab and load it.' })
const thread = list.thread
const lastUsed = shallowRef<MemoryUsed[]>([])
watch(lastUsed, (u) => pane.value?.used(u.map((m) => m.label)))
function onPane(h: MemoryPaneHandle) {
  pane.value = h
  h.used(lastUsed.value.map((m) => m.label))
}

// --- the voice
const speakReplies = ref(true)
const early = ref(false)
const speakingNow = ref(false)
const voice = speaker(() => (withVoice.value ? ((voiceSnap.value?.loaded as Engine | undefined) ?? null) : null), {
  play: async (line) => {
    const s = stage.value
    if (!s) return
    speakingNow.value = true
    try { await s.say(line as Speech) } finally { speakingNow.value = false }
  },
  halt: () => stage.value?.stop(),
  onLine: (t) => (caption.value = t),
})
const canCloneNow = computed(() => canClone(voiceSnap.value?.loaded))

// hands free: the mic sends what it heard when you stop talking, gated while he speaks
function heard(text: string) {
  const t = text.trim()
  if (t) void thread.send(t)
}

// speak each reply: whole when it ends, or sentence by sentence while it streams
const cutter = new SegmentCutter()
let speaking = -1
offs.push(thread.subscribe((s) => {
  const last = [...s.turns].reverse().find((t) => t.role === 'assistant')
  if (!last) return
  if (last.done && last.mem) lastUsed.value = last.mem
  if (!speakReplies.value || !awake.value || last.id < speaking) return
  if (last.id !== speaking) (speaking = last.id, cutter.reset())
  const text = brain.clean(last.text)
  if (early.value) for (const seg of cutter.take(text, last.done)) void voice.say(seg.text)
  else if (last.done && text.trim()) void voice.say(text.trim())
  if (last.done) speaking = last.id + 1
}))

// --- the body
const VERBS = computed<Verb[]>(() => [
  { id: 'turn', label: 'turn around' },
  { id: 'frame', label: framing.value === 'bust' ? 'full body' : 'close up' },
  { id: 'wave', label: 'wave' },
])
const dropOptions = { label: 'load a body file', hint: 'drop a vrm, glb, gltf or fbx here' }
function useBody(e: { files: readonly unknown[] }) {
  void stage.value?.show(e.files as never)
}
function placeholder() {
  stage.value?.showPlaceholder()
}
// his own body by default, from the dog site; the stand in when it does not load (offline) or on ?stub
let ownTry = false
function wearOwn() {
  const s = stage.value
  if (!s || STUB) return
  ownTry = true
  void s.show(HUMAN_GLB).then((b) => { if (!b) s.showPlaceholder() }, () => s.showPlaceholder())
}

// --- the gate checks
const rowOf = (s: PickSnapshot | null) => s?.row
const check = (s: PickSnapshot | null, on = true) => {
  const r = rowOf(s)
  if (!on) return { state: 'ok' as const, value: 1, note: 'off' }
  if (!r) return { state: 'wait' as const, value: 0, note: 'waiting' }
  if (r.state === 'loaded') return { state: 'ok' as const, value: 1, note: r.name }
  if (r.state === 'loading') return { state: 'load' as const, value: r.progress ?? 0, note: `${Math.round((r.progress ?? 0) * 100)}%` }
  if (r.state === 'error') return { state: 'err' as const, value: 0, note: s && brainPick.value ? (s === brainSnap.value ? brainPick.value.error(r.id) : voicePick.value?.error(r.id)) ?? 'failed' : 'failed' }
  return { state: 'wait' as const, value: 0, note: 'waiting' }
}
const brainCheck = computed(() => check(brainSnap.value))
const voiceCheck = computed(() => check(voiceSnap.value, withVoice.value))
const goLabel = computed(() => {
  const size = brainSnap.value?.row?.size
  return waking.value ? 'waking...' : size && brainSnap.value?.row?.state !== 'loaded' ? `wake him up, ${size}` : 'wake him up'
})

async function wake() {
  if (waking.value || !brainPick.value) return
  waking.value = true
  gateNote.value = ''
  try {
    await Promise.all([brainPick.value.load(), withVoice.value ? voicePick.value?.load().catch(() => (withVoice.value = false)) : null, ready])
    awake.value = true
    stage.value?.setVerbs(VERBS.value)
  } catch (err) {
    gateNote.value = `the brain did not load: ${err instanceof Error ? err.message : String(err)}. pick a smaller one and wake him again.`
  } finally {
    waking.value = false
  }
}
function noVoice() {
  withVoice.value = false
  void wake()
}

// --- data
async function forget() {
  thread.clear()
  lastUsed.value = []
  voice.clearClone()
  if (mem) await mem.remove(mem.all().map((i) => i.id))
  notes.value = []
  for (const p of [brainPick.value, voicePick.value, embedPick.value]) {
    const id = p?.snapshot().chosen
    if (p && id && p.snapshot().row?.state !== 'none') await p.remove(id).catch(() => undefined)
  }
}

watch(() => brainSnap.value?.loaded, (e) => list.setEngine(brain.wrap((e as ChatEngine | undefined) ?? null)))
watch(VERBS, (v) => { if (awake.value) stage.value?.setVerbs(v) })

onMounted(async () => {
  if (STUB) Object.assign(hooks, await import('./stubs').then((m) => ({ env: m.env, loaderFor: m.loaderFor })))
  const env = hooks.env ? { env: hooks.env } : {}
  brainPick.value = useModelPick('chat', { ...env, loader: loader('chat') })
  voicePick.value = useModelPick('voice', { ...env, chosen: 'pocket-tts', loader: loader('voice') })
  embedPick.value = useModelPick('embed', { ...env, loader: loader('embed') })
  offs.push(brainPick.value.subscribe((s) => (brainSnap.value = s)), voicePick.value.subscribe((s) => (voiceSnap.value = s)))
  offs.push(embedPick.value.subscribe((s) => { if (s.row?.state === 'loaded' && s.loaded) void openMemory(s.loaded as Embedder) }))
  brainSnap.value = brainPick.value.snapshot()
  voiceSnap.value = voicePick.value.snapshot()
  chipPick.value = brainPick.value
  if (!hooks.env) void probe().then((e) => [brainPick.value, voicePick.value, embedPick.value].forEach((p) => p?.update({ env: e })))

  const s = characterStage(stageEl.value!, { name: 'twin', verbs: [], framing: 'bust', hello: 'hello.' })
  stage.value = s
  offs.push(s.on((e) => {
    if (e.type === 'doing') doing.value = e.word
    else if (e.type === 'loaded') {
      bodyName.value = e.placeholder ? (ownTry ? 'stand in body. his own body did not load here.' : 'stand in body') : ownTry ? 'his own body' : e.name
      bodyLoaded.value = !e.placeholder
      ownTry = false
    } else if (e.type === 'failed') {
      bodyName.value = ownTry ? 'stand in body. his own body did not load here.' : e.message
      ownTry = false
    }
    else if (e.type === 'framing') framing.value = e.framing
    else if (e.type === 'verb') {
      if (e.id === 'turn') s.turn()
      else if (e.id === 'frame') s.frame(framing.value === 'bust' ? 'full' : 'bust')
      else if (e.id === 'wave') s.gesture('wave')
    }
  }))
  wearOwn()
  // gesture while speaking: a nod at the start of each line
  offs.push(watch(caption, (t) => { if (t && awake.value) s.gesture('nod') }))
})

onBeforeUnmount(() => {
  offs.forEach((f) => f())
  voice.stop()
  stage.value?.dispose()
  chipPick.value = null
})
</script>

<template>
  <div class="hb-lay hb sx-x" :class="awake ? 'is-stage-rack' : 'is-gate'" :data-layout="awake ? 'stage-rack' : 'gate'">
    <div class="hb-lay-body">
      <section ref="stageEl" />
      <Teleport v-if="stage && !awake" :to="stageEl as HTMLElement">
        <div class="hb-gate-wrap">
          <section class="hb-gate-card" aria-label="wake him up">
            <div class="hb-gate-head"><span>character</span><span>{{ brainSnap?.row?.backend === 'gpu' ? 'webgpu' : 'cpu' }}</span></div>
            <div class="hb-gate-body">
              <h2 class="hb-gate-name">wake him up.</h2>
              <p class="hb-gate-note">a twin that lives in this tab: a brain, a voice, a 3d body and a memory you can search. nothing is sent to a server. models download once and stay cached.</p>
              <div class="hb-gate-checks">
                <HbGateCheck label="brain" :state="brainCheck.state" :value="brainCheck.value" :note="brainCheck.note" />
                <HbGateCheck label="voice" :state="voiceCheck.state" :value="voiceCheck.value" :note="voiceCheck.note" />
                <HbGateCheck label="memory" :state="memoryState" :value="memoryState === 'ok' ? 1 : 0.5" :note="memoryState === 'ok' ? `${notes.length} notes` : 'opening'" />
                <HbGateCheck label="body" state="ok" :value="1" :note="bodyName" />
              </div>
              <ModelSelect v-if="brainPick" job="chat" :pick="brainPick" variant="line" :go="false" />
              <p v-if="gateNote" class="hb-note is-err" role="alert">{{ gateNote }}</p>
              <div class="hb-gate-acts">
                <button type="button" class="hb-btn hb-btn-go hb-btn-lg hb-gate-go" :aria-busy="waking || undefined" @click="wake">{{ goLabel }}</button>
                <button v-if="!waking" type="button" class="hb-btn" @click="noVoice">no voice</button>
              </div>
            </div>
          </section>
        </div>
      </Teleport>
      <Teleport v-if="stage && awake && caption" :to="stage.inset">
        <p class="sx-x-caption"><b>{{ doing }}</b> {{ caption }}</p>
      </Teleport>

      <HbRack v-if="awake" :tabs="TABS" label="character">
        <template #talk>
          <div class="sx-x-talk">
            <div class="sx-x-thread"><ChatPane :thread="thread" name="twin" empty-name="say something to him" empty-note="he answers from his brain and the notes in his memory." /></div>
            <div class="sx-x-compose">
              <Composer :thread="thread" placeholder="say something" />
              <HbMicButton listen note :speaking="speakingNow" @final="heard" />
            </div>
          </div>
        </template>
        <template #memory>
          <section class="hb-panel sx-x-pad">
            <MemoryPane v-if="memRef" :memory="memRef" name="his memory" @pane="onPane" @change="memChanged" />
            <SourcesDrop :ingest="readIn" />
            <p class="hb-note">{{ lastUsed.length ? `last reply used ${lastUsed.length} note${lastUsed.length === 1 ? '' : 's'}, marked above.` : 'nothing used yet. ask him something his notes cover.' }}</p>
            <h3 class="hb-panel-hd">recall model</h3>
            <ModelSelect v-if="embedPick" job="embed" :pick="embedPick" variant="line" :go="false" />
          </section>
        </template>
        <template #voice>
          <section class="hb-panel sx-x-pad">
            <HbToggleRow v-model="speakReplies" label="speak replies" />
            <HbToggleRow v-model="early" label="start speaking while it writes" description="faster with webgpu" />
            <ModelSelect v-if="voicePick" job="voice" :pick="voicePick" variant="line" :go="false" />
            <h3 class="hb-panel-hd">clone a voice</h3>
            <VoiceClone :speaker="voice" :can="canCloneNow" />
            <p v-if="!withVoice" class="hb-note">woken with no voice. load one here and he speaks.</p>
          </section>
        </template>
        <template #body>
          <section class="hb-panel sx-x-pad">
            <AvatarDrop :options="dropOptions" @use="useBody" />
            <p class="sx-x-row">
              <button type="button" class="hb-btn" @click="stage?.turn()">turn around</button>
              <button v-if="bodyLoaded" type="button" class="hb-btn" @click="placeholder">back to the stand in</button>
              <button v-else-if="!STUB" type="button" class="hb-btn" @click="wearOwn">his own body</button>
            </p>
            <p class="hb-note">{{ bodyName }}</p>
          </section>
        </template>
        <template #brain>
          <section class="hb-panel sx-x-pad">
            <ModelSelect v-if="brainPick" job="chat" :pick="brainPick" variant="line" :go="false" />
            <h3 class="hb-panel-hd">who he is</h3>
            <PersonaRack :rack="rack" />
            <HbSlider v-model="settings.temperature" label="temperature" :min="0" :max="1.5" :step="0.05" :format="(v: number) => v.toFixed(2)" />
            <label class="hb-field"><span class="hb-label">who is he talking to</span><HbSelect v-model="settings.register" :options="REGISTERS" /></label>
            <HbSlider v-model="settings.length" label="reply length" :min="0" :max="3" :step="1" :format="(v: number) => LENGTHS[v] ?? ''" />
            <HbSlider v-model="settings.flaws" label="typos and flaws" :min="0" :max="2" :step="1" :format="(v: number) => FLAWS[v] ?? ''" />
            <p class="hb-note">flaws land in what you read only. the voice and his memory of the chat stay clean.</p>
            <h3 class="hb-panel-hd">data</h3>
            <SessionMenu :list="list" />
            <p class="sx-x-row">
              <button type="button" class="hb-btn hb-btn-danger" @click="forget">forget everything cached here</button>
            </p>
          </section>
        </template>
        <template #detail>
          <p class="hb-note">live2d models, a physics humanoid and text to motion are not in the libraries yet. bodies load from vrm, glb, gltf and fbx.</p>
        </template>
      </HbRack>
    </div>
  </div>
</template>

<style scoped>
.sx-x { height: calc(100svh - 52px); grid-template-rows: minmax(0, 1fr); }
.sx-x > .hb-lay-body { grid-row: 1; }
.sx-x-pad { display: grid; gap: var(--hb-s3); }
.sx-x-row { display: flex; flex-wrap: wrap; gap: var(--hb-s2); margin: 0; }
.sx-x-talk { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.sx-x-thread { flex: 1; min-height: 0; overflow: auto; }
.sx-x-compose { position: sticky; bottom: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: end; gap: var(--hb-s2); padding-top: var(--hb-s2); background: var(--hb-paper); }
.sx-x-caption { margin: 0; max-width: 34ch; }
@media (max-width: 900px) {
  .sx-x { height: auto; min-height: calc(100svh - 52px); }
  .sx-x-thread { flex: none; }
}
</style>
