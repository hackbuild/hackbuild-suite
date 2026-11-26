<script setup lang="ts">
// chat studio (rebuild plan 4): clevis and chatbot-forge as one page. The
// conversation fills; the rack holds what the reply used and the store
// (memory), the chats, the persona, the reply settings and the voice. Every
// model in the catalogue comes from the chip in the bar, loaded in this tab.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { HbCheckbox, HbConversationLayout, HbSeg, HbSlider, HbTextarea } from '@virgilvox/hackbuild-ui'
import { probe } from '@hackbuild/ai-env'
import type { ChatEngine, JsonSchema } from '@hackbuild/chat'
import { hashedEmbedder, loadCore, memorySink, open, type Memory, type Recall } from '@hackbuild/memory'
import { MEMORY_WASM_BASE64 } from '@hackbuild/memory/inline'
import { ingest } from '@hackbuild/memory/ingest'
import { webSpeechEngine } from '@hackbuild/speak'
import { openWeightStore } from '@hackbuild/weights'
import { chatList, jobLoader, jobRecords, personaRack, storedIds, useModelPick, voiceRow, type MemoryUsed, type PersonaPresetX, type RecallLike } from '@hackbuild/ai-views'
import { ChatList, ChatPane, Composer, MemoryInspector, MemoryPane, PersonaRack, SessionMenu, SourcesDrop, VoiceRow } from '@hackbuild/ai-views/vue'
import type { MemoryPaneHandle } from '@hackbuild/ai-views/elements'
import { PlanLog } from '@hackbuild/agents-views/vue'
import { planBook, type PlanLogState } from '@hackbuild/agents-views'
import { chipPick } from '../../shell/chip'
import { chatTools, withTools } from './tools'

const STUB = new URLSearchParams(location.search).has('stub')
const KEY = 'hb-x-chat'
const saved = (() => {
  if (STUB) return {}
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
  } catch {
    return {}
  }
})()
const keep = (k: string, v: unknown) => {
  if (STUB) return
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), [k]: v }))
  } catch {
    /* storage blocked: the chats live until the tab closes */
  }
}

// the persona: built in presets plus the person's saved ones
const PRESETS: PersonaPresetX[] = [
  { label: 'plain', persona: { name: 'assistant', profile: 'answer plainly and briefly.', notes: '', rules: '' } },
  { label: 'bench helper', persona: { name: 'bench', profile: 'you help at a maker bench: printing, laser cutting, electronics. answer with steps and numbers.', notes: '', rules: 'say when you are unsure. never invent part numbers.' } },
  { label: 'editor', persona: { name: 'editor', profile: 'you edit writing in the person\'s own voice: lowercase, terse, no filler.', notes: '', rules: 'leave a [bracketed] gap where a fact is missing.' } },
]
const persona = personaRack({ presets: PRESETS, saved: (saved.presets as PersonaPresetX[]) ?? [], onSave: (p) => keep('presets', p) })

// the reply: mode, sampling, history sent, json mode
const mode = ref<'quick' | 'default' | 'complex'>('default')
const temperature = ref(0.7)
const topP = ref(0.95)
const maxTokens = ref(1024)
const repeat = ref(1.1)
const historyN = ref(40)
const json = ref(false)
const schemaText = ref('{\n  "type": "object",\n  "properties": { "answer": { "type": "string" } },\n  "required": ["answer"]\n}')
const schemaError = computed(() => {
  if (!json.value) return ''
  try {
    JSON.parse(schemaText.value)
    return ''
  } catch (e) {
    return `the schema is not json: ${e instanceof Error ? e.message : String(e)}`
  }
})
watch(mode, (m) => { maxTokens.value = m === 'quick' ? 256 : m === 'complex' ? 2048 : 1024 })
const autoSave = ref(saved.autoSave === true)
watch(autoSave, (v) => keep('autoSave', v))

// the voice
const voice = voiceRow(webSpeechEngine(), { ...((saved.voice as object) ?? {}), onChange: (v) => keep('voice', v) })

// the model: every chat model in the catalogue, from the chip in the bar
const pick = useModelPick('chat', { loader: jobLoader('chat') })
const ctxOf = () => {
  const s = pick.snapshot()
  return Number(pick.optionsOf(s.chosen).context ?? pick.record(s.chosen)?.ctx ?? 4096)
}

// memory: recall per message, what it used shows under the reply and in the rack
const mem = shallowRef<Memory | null>(null)
const recall = ref<RecallLike | null>(null)
const paneRef = shallowRef<MemoryPaneHandle | null>(null)
const pane = { used: (l: string[]) => paneRef.value?.used(l), refresh: () => paneRef.value?.refresh() }
const setPane = (p: MemoryPaneHandle) => (paneRef.value = p)
const ready = (async () => {
  const core = await loadCore({ base64: MEMORY_WASM_BASE64 })
  const m = await open(STUB ? 'x-chat-stub' : 'x-chat', { core, embed: hashedEmbedder(), ...(STUB ? { sink: memorySink() } : {}) })
  if (STUB && !m.all().length) for (const f of ['you print in petg, not pla', 'the laser cutter is booked on tuesdays', 'your bench is in the garage']) await m.add(f, { kind: 'fact' })
  mem.value = m
  return m
})()
async function recallFor(q: string): Promise<MemoryUsed[]> {
  const m = await ready
  const r: Recall = await m.recall(q, { k: 4 })
  recall.value = r
  const used = r.hits.filter((h) => h.score > 0.01).map((h) => ({ label: h.item.text, score: Math.min(1, h.score) }))
  pane.used(used.map((u) => u.label))
  return used
}

const list = chatList({
  recall: recallFor,
  systemFor: (m) => persona.system(m, Math.round(ctxOf() * 0.4)).text,
  stream: () => ({
    temperature: temperature.value, topP: topP.value, maxTokens: maxTokens.value, repetitionPenalty: repeat.value,
    think: mode.value === 'quick' ? 'drop' : 'emit',
    ...(json.value && !schemaError.value ? { schema: JSON.parse(schemaText.value) as JsonSchema } : {}),
  }),
  history: () => (historyN.value >= 40 ? -1 : historyN.value),
  onReply: (t, said) => {
    voice.reply(t.text)
    if (autoSave.value) void ready.then((m) => m.addExchange(said, t.text)).then(() => pane.refresh())
  },
  noEngine: 'no model loaded yet. pick one in the bar and load it; memory already found the lines under this.',
})
if (saved.chats) {
  try {
    list.restore(saved.chats as Parameters<typeof list.restore>[0])
  } catch {
    /* an old or broken save: start clean */
  }
}
let timer = 0
const offList = list.subscribe(() => {
  clearTimeout(timer)
  timer = window.setTimeout(() => keep('chats', list.dump()), 400)
})
const empty = ref(true)
const offThread = list.thread.subscribe((s) => (empty.value = !s.turns.length))
// tools: with them on, each send is one agent turn over the page's tools
const useTools = ref(false)
const rounds = ref(6)
const TOOLS = chatTools(() => ready)
const book = planBook()
const plan = shallowRef<PlanLogState>(book.state())
const clearLog = () => (book.clear(), (plan.value = book.state()))
let engine: ChatEngine | null = null
const setEngine = () => list.setEngine(engine && useTools.value
  ? withTools(engine, { tools: TOOLS, soul: () => persona.system([], Math.round(ctxOf() * 0.3)).text, steps: () => rounds.value, memory: () => ready, onEvent: (e) => { if (book.push(e)) plan.value = book.state() } })
  : engine)
watch(useTools, setEngine)
const offPick = pick.subscribe((s) => { engine = s.row?.state === 'loaded' ? (s.loaded as ChatEngine) : null; setEngine() })

const ingestInto = (files: File[], o: { onFile: (e: { name: string; chunks: number; note?: string }) => void }) =>
  ready.then((m) => ingest(m, files, o)).finally(() => pane.refresh())

const tab = ref('memory')
const TABS = [
  { id: 'memory', label: 'memory' },
  { id: 'chats', label: 'chats' },
  { id: 'persona', label: 'persona' },
  { id: 'reply', label: 'reply' },
  { id: 'tools', label: 'tools' },
  { id: 'voice', label: 'voice' },
]

// the conversation is the thread, its verbs and its composer together, beside the rack
const lay = ref<{ $el: HTMLElement } | null>(null)
onMounted(async () => {
  const root = lay.value?.$el
  root?.querySelector<HTMLElement>('.hb-lay-subject')?.removeAttribute('data-ux')
  const stage = root?.querySelector<HTMLElement>('.hb-lay-stage')
  if (stage) stage.dataset.ux = 'subject'
  const comp = root?.querySelector<HTMLElement>('.hb-lay-composer')
  if (comp) comp.dataset.ux = 'verbs'
  chipPick.value = pick
  const w = window as unknown as { hbExplorer?: unknown }
  w.hbExplorer = { list, pick, useTools, plan, sample: () => list.thread.send('what filament do i print with?') }
  if (STUB) {
    const s = await import('./stubs')
    pick.update({ env: s.FIXTURE_ENV, loader: s.stubLoader })
    return
  }
  const env = await probe()
  pick.update({ env })
  const store = await openWeightStore().catch(() => null)
  if (store) pick.update({ stored: await storedIds(store, jobRecords('chat')) })
})
onBeforeUnmount(() => {
  offList(), offThread(), offPick(), voice.stop()
  list.thread.stop()
  if (chipPick.value === pick) chipPick.value = null
  mem.value?.close()
})
</script>

<template>
  <HbConversationLayout ref="lay" v-model:tab="tab" class="xc" :tabs="TABS" rack-label="chat studio">
    <ChatPane :thread="list.thread" name="reply" empty-name="what are we working on?" empty-note="your persona rides along with every message, and memory fills in the specifics. pick a model in the bar to answer; until then a written reply shows what memory found." />
    <template #verbs>
      <HbSeg v-model="mode" :options="['quick', 'default', 'complex']" toggle aria-label="reply mode" />
    </template>
    <template #composer>
      <Composer :thread="list.thread" placeholder="message, or drop a file in memory" />
    </template>

    <template #tab-memory>
      <section class="hb-panel xc-used" aria-label="memory used">
        <MemoryInspector v-if="recall" :recall="recall" />
        <p v-else class="hb-note">send a message and the lines memory used show here, with why.</p>
      </section>
      <MemoryPane v-if="mem" :memory="mem" @pane="setPane" />
      <SourcesDrop v-if="mem" :ingest="ingestInto" />
      <HbCheckbox v-model="autoSave">save a note from each exchange</HbCheckbox>
    </template>
    <template #tab-chats>
      <ChatList :list="list" label="chats" />
      <SessionMenu :list="list" />
    </template>
    <template #tab-persona>
      <PersonaRack :rack="persona" />
    </template>
    <template #tab-reply>
      <section class="hb-panel xc-reply">
        <HbSlider v-model="temperature" label="temperature" :min="0" :max="2" :step="0.05" />
        <HbSlider v-model="topP" label="top p" :min="0.05" :max="1" :step="0.05" />
        <HbSlider v-model="maxTokens" label="longest reply" :min="64" :max="4096" :step="64" unit=" tok" />
        <HbSlider v-model="repeat" label="repeat penalty" :min="1" :max="2" :step="0.05" />
        <HbSlider v-model="historyN" label="earlier turns sent" :min="0" :max="40" :step="1" :format="(v: number) => (v >= 40 ? 'all' : String(v))" />
        <HbCheckbox v-model="json">answer as json to this schema</HbCheckbox>
        <HbTextarea v-if="json" v-model="schemaText" :rows="6" :invalid="!!schemaError" aria-label="json schema" />
        <p v-if="schemaError" class="hb-error" role="alert">{{ schemaError }}</p>
      </section>
    </template>
    <template #tab-tools>
      <section class="hb-panel xc-toolset" aria-label="tools">
        <HbCheckbox v-model="useTools">let the model call tools</HbCheckbox>
        <HbSlider v-model="rounds" label="model calls per message" :min="1" :max="12" :step="1" />
        <ul class="xc-tools">
          <li v-for="t in TOOLS" :key="t.name"><b>{{ t.name }}</b> {{ t.description }}</li>
        </ul>
        <p class="hb-note">not here yet: an mcp server and web search.</p>
      </section>
      <PlanLog :state="plan" empty="turn tools on and send a message; each plan, call and result shows here." />
      <button type="button" class="hb-btn" @click="clearLog">clear the log</button>
    </template>
    <template #tab-voice>
      <VoiceRow :row="voice" />
      <p class="hb-note">spoken by this browser's own voices. volume follows the system.</p>
    </template>
    <template #detail>
      <p class="hb-note">memory: keyword and vector recall in a wasm core, kept in this browser's storage. sources are cut into parts and kept as documents, which cleanup never drops. the persona goes first, then memory, then notes, then rules; the last parts drop when a request runs out of room.</p>
    </template>
  </HbConversationLayout>
</template>

<style scoped>
.xc { height: calc(100dvh - 52px); }
.xc :deep(.hb-lay-verbs) { position: static; justify-content: center; align-items: center; padding: 6px var(--hb-s3); background: var(--hb-paper); }
.xc-used { margin-bottom: var(--hb-s-3, 12px); }
.xc-reply { display: grid; gap: var(--hb-s-3, 12px); }
.xc-toolset { display: grid; gap: var(--hb-s-3, 12px); }
.xc-tools { margin: 0; padding-left: 1.2em; }
</style>
