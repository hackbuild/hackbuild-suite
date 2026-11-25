<script setup lang="ts">
// The chat tool (design 3.1). One conversation per document; the
// conversation core saves through the open document, so every saved turn
// is an undo step and autosaves. Before any load the scripted engine
// answers, and the page says so.
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HbChat, HbContextMeter, HbConversationList, HbCustomModelForm, HbDrawer, HbEngineBar, HbMicButton, HbRecallTrace, HbTierCards, useHotkeys,
  type HbChatLine, type HbEngineState, type HbRecallHit, type HbTier,
} from '@virgilvox/hackbuild-ui'
import { createConversation, type ChatSession, type Conversation, type ConverseEngine } from '@hackbuild/converse'
import type { ChatEngine } from '@hackbuild/chat'
import type { Loaded, ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, overlay, useComposer, useStop } from '../shell/shell.ts'
import { deleteDoc, docs, duplicateDoc, exportDoc, kinds, pickFiles, registerKind, renameDoc, useDocument } from '../workspace/state'
import { chatKind, CHAT_KIND, NEW_CHAT, titleFrom } from './kind.ts'
import { contextSegments, toLines } from './lines.ts'
import { docSink } from './sink.ts'
import { stubChat } from './stub.ts'
import { addChatRuntimes, endpointKey, engineOf } from './runtimes.ts'
import { rememberLine, traceHits } from '../memory/lines.ts'
import { useWide } from '../shell/wide.ts'
import type { MicState } from '@virgilvox/hackbuild-ui/vanilla'
import { startDictation, type Dictator } from './dictation.ts'

// the memory store loads with the first turn that needs it
const memStore = () => import('../memory/store.ts')

if (!kinds.get(CHAT_KIND)) registerKind(chatKind)

const route = useRoute()
const router = useRouter()
const doc = useDocument<ChatSession>(CHAT_KIND)
const scripted = stubChat()
const engine = shallowRef<ChatEngine>(scripted)
// the conversation keeps one engine; this one forwards to whichever is current
const proxy: ConverseEngine = { stream: (m, o) => engine.value.stream(m, o) }

const session = shallowRef<ChatSession | null>(null)
const tick = ref(0)
const busy = ref(false)
const live = ref<{ id: string; text: string; think: string } | null>(null)
const draft = ref('')
const listOpen = ref(false)
// from 1024 px the conversation list stands beside the chat, below it is a drawer
const wide = useWide()
let conv: Conversation | null = null
let off: (() => void) | null = null
let written: unknown = null

const AUTO_NAME = /^(chat|new chat)( \d+)?$/
const sink = docSink({
  read: () => (doc.doc.value ? { id: doc.doc.value.id, body: doc.doc.value.body } : null),
  write(s) {
    const d = doc.doc.value
    const title = titleFrom(s)
    // the first message names an unnamed chat; set before the edit so the save carries it
    if (d && title && AUTO_NAME.test(d.name)) doc.doc.value = { ...d, name: title }
    if (title && (s.title === NEW_CHAT || s.title === 'imported chat')) s.title = title
    doc.edit(() => s)
    written = doc.doc.value?.body
  },
})

async function attach(id: string): Promise<void> {
  conv?.stop()
  off?.()
  live.value = null
  const c = createConversation({ engine: proxy, now: Date.now, id, sink, debounceMs: 250, memory: { recall } })
  off = c.on((e) => {
    if (e.type === 'change') {
      session.value = e.session
      tick.value++
    } else if (e.type === 'text') live.value = { id: e.id, text: e.text, think: live.value?.id === e.id ? live.value.think : '' }
    else if (e.type === 'think') live.value = { id: e.id, think: e.text, text: live.value?.id === e.id ? live.value.text : '' }
    else if (e.type === 'busy') {
      busy.value = e.busy
      if (!e.busy) live.value = null
      tick.value++
    } else if (e.type === 'error') logEvent('fail', `reply stopped: ${e.message.error ?? 'the engine closed'}`)
  })
  conv = c
  await c.restore()
}

async function openDoc(id?: string): Promise<void> {
  const d = await doc.open(id)
  await attach(d.id)
}
async function newChat(): Promise<void> {
  await conv?.flush()
  const d = await doc.create(NEW_CHAT)
  await attach(d.id)
  listOpen.value = false
}

// undo and redo change the body under the conversation: read it back
watch(
  () => doc.doc.value?.body,
  (b) => {
    // a body the sink just wrote is the conversation's own; any other came from undo or redo
    const mine = b === written
    written = null
    if (b && !mine && conv && doc.doc.value?.id === conv.session.id && !busy.value) void conv.restore()
  },
)
watch(() => route.query.doc, (id) => { if (typeof id === 'string' && id !== doc.doc.value?.id) void openDoc(id) })

// The engine: the loaded chat model, else the scripted one.
const chatRecords = computed(() => hub.allRecords.value.filter((r) => r.provides.includes('chat')))
const rec = (id: string | null | undefined) => chatRecords.value.find((r) => r.id === id)
const picked = ref<string | null>(null)
const stateOf = (r: ModelRecord | undefined) => (r ? hub.states.value[r.id]?.state ?? 'none' : 'none')
const defaultChat = computed(() => {
  const d = rec(hub.defaultId.value)
  if (d) return d
  return chatRecords.value.find((r) => r.group === 'start here' && hub.fits.value[r.id]?.ok !== false)
})
const current = computed(() => rec(picked.value) ?? chatRecords.value.find((r) => stateOf(r) === 'loaded') ?? chatRecords.value.find((r) => stateOf(r) === 'downloading'))
const loaded = computed(() => (current.value && stateOf(current.value) === 'loaded' ? current.value : undefined))

let handle: Loaded | null = null
const release = () => {
  if (handle) hub.hub().release(handle)
  handle = null
}
watch(
  () => loaded.value?.id,
  async (id) => {
    release()
    engine.value = scripted
    if (!id) return
    try {
      const l = await hub.hub().use({ id })
      if (loaded.value?.id !== id) return hub.hub().release(l)
      handle = l
      engine.value = engineOf(l.value, l.record)
    } catch (err) {
      logEvent('fail', `chat engine: ${err instanceof Error ? err.message : String(err)}`)
    }
  },
)

const barState = computed<HbEngineState>(() => {
  const s = stateOf(current.value)
  return s === 'loaded' || s === 'stored' || s === 'downloading' ? s : s === 'fault' ? 'fault' : 'none'
})
const barFacts = computed(() => {
  const r = current.value
  const st = r ? hub.states.value[r.id] : undefined
  const last = [...(session.value?.messages ?? [])].reverse().find((m) => m.stats)?.stats
  return {
    model: r ? r.label ?? r.id : '',
    pct: st?.state === 'downloading' && st.total ? (st.loaded ?? 0) / st.total : null,
    error: st?.state === 'fault' ? st.error : '',
    device: r ? (r.provider === 'remote' ? 'your endpoint' : r.ladder[0]?.device ?? '') : '',
    rate: last?.tokensPerSecond ?? null,
  }
})
const shownKey = computed({ get: () => endpointKey.value, set: (v: string) => { endpointKey.value = v } })
const needsKey = computed(() => current.value?.provider === 'remote' || tier.value === 'endpoint')

// Engine tiers, framed by cost and privacy (P-MODEL-7, P-MODEL-8).
const tier = ref('script')
const faultOf = (r: ModelRecord | undefined) => {
  const st = r ? hub.states.value[r.id] : undefined
  return st?.state === 'fault' ? `load failed: ${st.error ?? 'unknown'}` : undefined
}
const tiers = computed<HbTier[]>(() => {
  const d = defaultChat.value
  const nano = rec('gemini-nano')
  const hasPrompt = typeof globalThis !== 'undefined' && 'LanguageModel' in globalThis
  return [
    { key: 'script', label: 'no model', sub: 'scripted', size: '0 mb (computed)', cost: 'no download', privacy: 'nothing leaves the tab' },
    {
      key: 'tab', label: 'in this tab', sub: d ? d.label ?? d.id : 'no row fits', size: d?.sizeMB ? `${Math.round(d.sizeMB)} mb (${d.sizeSource})` : 'size unknown',
      cost: 'one download, then offline', privacy: 'nothing leaves the tab', disabled: !d, reason: d ? undefined : 'no chat row fits this machine.', error: faultOf(d),
    },
    {
      key: 'browser', label: 'browser built in', sub: nano?.label ?? 'built in model', size: 'browser managed, unknown', cost: 'the browser downloads it',
      privacy: 'stays in the browser', disabled: !nano || !hasPrompt, reason: 'this browser has no prompt api.', error: faultOf(nano),
    },
    { key: 'endpoint', label: 'your endpoint', sub: 'openai style url', size: 'none', cost: 'your server', privacy: 'replies leave this tab' },
  ]
})
function startTier(key: string): void {
  if (key === 'tab' && defaultChat.value) {
    picked.value = defaultChat.value.id
    void hub.load(defaultChat.value.id)
  } else if (key === 'browser') {
    picked.value = 'gemini-nano'
    void hub.load('gemini-nano')
  } else if (key === 'endpoint') {
    const saved = hub.customSaved.value.find((s) => s.mode === 'endpoint')
    if (saved) pickRow(saved.id)
  } else picked.value = null
}
function pickRow(id: string): void {
  picked.value = id
  if (stateOf(rec(id)) !== 'loaded') void hub.load(id)
}
function addEndpoint(values: Record<string, string | boolean | undefined>): void {
  pickRow(hub.addCustom('endpoint', values))
}

// The transcript.
const lines = computed<HbChatLine[]>(() => {
  void tick.value
  const s = session.value
  if (!s) return []
  const last = s.messages[s.messages.length - 1]
  const liveId = busy.value && last?.role === 'assistant' ? last.id : null
  const l = live.value?.id === liveId ? live.value : null
  return toLines(s, {
    live: liveId,
    remembered: remembered.value,
    pending: engine.value === scripted ? 'the script answers' : 'waiting on the first word',
    ...(l ? { text: l.text, think: l.think } : {}),
  })
})
const idAt = (i: number) => String(lines.value[i]?.id ?? '')
const segments = computed(() => (void tick.value, session.value ? contextSegments(session.value, draft.value) : []))
const budget = computed(() => (engine.value as { contextWindow?: number }).contextWindow ?? current.value?.ctx ?? 4096)
const examples = ['say hi', 'what can you do here', 'show me the think fold']

// Memory (design 3.1 step 7, 3.8): each turn recalls from the chat store;
// "remember that ..." saves the line first (P-MEM-10).
const memOn = ref(true)
async function recall(text: string): Promise<{ id: string; text: string }[]> {
  if (!memOn.value) return []
  try {
    return await (await memStore()).recallFor(text)
  } catch (err) {
    logEvent('warn', `memory is off for this turn: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}
async function remember(text: string): Promise<boolean> {
  const line = memOn.value ? rememberLine(text) : null
  if (!line) return false
  const r = await (await memStore()).saveLine(line, { from: 'chat' })
  logEvent('note', r.merged ? `already remembered, made stronger: ${line}` : `remembered: ${line}`)
  return true
}
// the remember action under a line saves it; the phrase in it wins when there is one
const remembered = ref<ReadonlySet<string>>(new Set())
async function rememberAt(i: number): Promise<void> {
  const l = lines.value[i]
  if (!l || l.remembered) return
  const line = rememberLine(l.text) ?? l.text.replace(/\s+/g, ' ').trim()
  if (!line) return
  try {
    const r = await (await memStore()).saveLine(line, { from: 'chat' })
    remembered.value = new Set([...remembered.value, String(l.id)])
    logEvent('note', r.merged ? `already remembered, made stronger: ${line}` : `remembered: ${line}`)
  } catch (err) {
    logEvent('fail', `not remembered: ${err instanceof Error ? err.message : String(err)}`)
  }
}
const traceOpen = ref(false)
const traceQuery = ref('')
const trace = shallowRef<{ hits: HbRecallHit[]; how: string } | null>(null)
async function showTrace(i: number): Promise<void> {
  const asked = lines.value.slice(0, i).reverse().find((l) => l.role === 'user')
  if (!asked) return
  traceQuery.value = asked.text
  trace.value = null
  traceOpen.value = true
  const t = await (await memStore()).traceFor(asked.text)
  trace.value = { hits: traceHits(t), how: t.how }
}
const openMemory = () => router.push({ name: 'memory', query: { q: traceQuery.value } })

// a message typed before the document opens waits for it
const send = (t: string) =>
  void ready.then(async () => {
    const saved = await remember(t).catch(() => false)
    const sent = conv?.send(t)
    // "remember that ..." marks the turn it was typed in
    const u = saved ? [...(conv?.session.messages ?? [])].reverse().find((m) => m.role === 'user') : undefined
    if (u) remembered.value = new Set([...remembered.value, u.id])
    await sent
  })
const stop = () => conv?.stop()
const redo = () => void conv?.redo()
const remove = (i: number) => conv?.remove(idAt(i))
const edit = (i: number, t: string) => void conv?.edit(idAt(i), t)
// speak opens the speech tool with the line, which says it on its engine and voice
function speak(i: number): void {
  const t = lines.value[i]?.text
  if (t) void router.push({ name: 'speak', query: { text: t, say: '1' } })
}
function trim(): void {
  const s = session.value
  if (!s || !conv) return
  // drop the oldest user turn and its reply
  const first = s.messages.findIndex((m) => m.role === 'user')
  const next = s.messages.findIndex((m, i) => i > first && m.role === 'user')
  for (const m of s.messages.slice(first, next < 0 ? first + 2 : next)) conv.remove(m.id)
}
const exportChat = (format?: string) => { if (doc.doc.value) void conv?.flush().then(() => exportDoc(doc.doc.value!.id, format ? { format } : {})) }

// The conversation list: the chat documents of this project.
const chats = computed(() =>
  docs.value.filter((d) => d.kind === CHAT_KIND).map((d) => ({ id: d.id, title: d.name, updated: d.updated, count: (d.body as ChatSession).messages?.length ?? 0 })),
)
function openFromList(id: string): void {
  listOpen.value = false
  if (id !== doc.doc.value?.id) void conv?.flush().then(() => openDoc(id))
}
function rename(id: string, name: string): void {
  // the open document saves with the name it holds, so it takes the new one too
  const d = doc.doc.value
  if (d && d.id === id) doc.doc.value = { ...d, name }
  void renameDoc(id, name)
}
async function removeChat(id: string): Promise<void> {
  await deleteDoc(id)
  if (id === doc.doc.value?.id) await openDoc()
}

// Keys: "/" focuses the composer, ctrl+shift+n starts a chat, esc stops the reply.
const root = ref<HTMLElement | null>(null)
useComposer({ get value() { return root.value?.querySelector<HTMLElement>('.hb-composer textarea') ?? null } } as Ref<HTMLElement | null>)
useStop(stop)
useHotkeys([{ keys: 'ctrl+shift+n', label: 'new chat', group: 'tool', inFields: true, run: () => void newChat() }])

if (typeof route.query.draft === 'string') draft.value = route.query.draft
const q = route.query.doc
const ready = openDoc(typeof q === 'string' ? q : undefined)
onMounted(async () => {
  await ready
  await loadModels()
  addChatRuntimes()
})
// Mic dictation: interim words fill the composer, the final stays there to send.
const micState = ref<MicState>('off')
let dictator: Dictator | null = null
const draftBox = { get value() { return draft.value }, set value(v: string) { draft.value = v } }
async function micStart(): Promise<void> {
  if (dictator) return
  micState.value = 'asking'
  logEvent('note', 'dictation: the browser speech recognition may send the audio to its own service.')
  dictator = await startDictation(draftBox, {
    state: (s) => { micState.value = s },
    committed: (v) => logEvent('note', `dictation: heard "${v.slice(-60)}". press enter to send.`),
    failed: (m) => { logEvent('warn', `dictation: ${m}`); dictator = null },
  })
}
function micStop(): void {
  dictator?.stop()
  dictator = null
  micState.value = 'off'
}

onBeforeUnmount(() => {
  micStop()
  conv?.stop()
  void conv?.flush()
  off?.()
  release()
})
</script>

<template>
  <div ref="root" class="hb-toolpage" :class="{ 'is-split': wide }">
    <HbEngineBar
      class="is-full"
      label="chat engine"
      :model="barFacts.model"
      :state="barState"
      :device="barFacts.device"
      :rate="barFacts.rate"
      :size-m-b="current?.sizeMB ?? null"
      :pct="barFacts.pct"
      :error="barFacts.error"
      @change="overlay = 'models'"
      @load="current && hub.load(current.id)"
      @cancel="current && hub.cancel(current.id)"
      @unload="current && hub.unload(current.id)"
    />
    <HbConversationList
      v-if="wide"
      class="is-side"
      :items="chats"
      :current="doc.doc.value?.id ?? null"
      :busy="busy"
      @open="openFromList"
      @new="newChat"
      @rename="rename"
      @duplicate="(id) => duplicateDoc(id)"
      @remove="removeChat"
      @export="exportChat()"
      @import="pickFiles()"
    />
    <HbChat
      class="is-grow"
      v-model:draft="draft"
      v-model:api-key="shownKey"
      :lines="lines"
      :streaming="busy"
      :key-field="needsKey"
      header
      :title="doc.doc.value?.name ?? 'chat'"
      :assistant-name="loaded ? loaded.label ?? loaded.id : 'script'"
      :examples="examples"
      :placeholder="loaded ? '' : 'no model loaded. the script answers. pick a model to talk for real.'"
      @send="send"
      @stop="stop"
      @retry="redo"
      @edit="edit"
      @remove="remove"
      @speak="speak"
      @remember="rememberAt"
      @recall="(i) => showTrace(i)"
      @clear="conv?.clear()"
      @export="exportChat()"
      @import="pickFiles()"
    >
      <template #header-extra>
        <button v-if="!wide" type="button" class="hb-btn hb-btn-2 hb-btn-sm" @click="listOpen = true">chats</button>
        <button type="button" class="hb-btn hb-btn-2 hb-btn-sm" :disabled="!lines.length" @click="exportChat('md')">markdown</button>
        <button type="button" class="hb-btn hb-btn-2 hb-btn-sm" :aria-pressed="memOn" @click="memOn = !memOn">{{ memOn ? 'memory on' : 'memory off' }}</button>
      </template>
      <template #empty>
        <div v-if="!lines.length" class="hb-chat-empty">
          <p class="hb-chat-empty-text">no model loaded. the chips below answer from a script so you can see the shape. pick a model to talk for real.</p>
          <div class="hb-chat-examples">
            <button v-for="ex in examples" :key="ex" type="button" class="hb-chip" :disabled="busy" @click="send(ex)">{{ ex }}</button>
          </div>
          <HbTierCards v-if="!loaded" v-model="tier" :tiers="tiers" label="engine" start start-label="use this" @start="startTier">
            <template #body="{ tier: t }">
              <HbCustomModelForm
                v-if="t.key === 'endpoint'"
                :modes="['endpoint']"
                mode="endpoint"
                :check="hub.customCheck.value"
                :saved="hub.customSaved.value.filter((s) => s.mode === 'endpoint')"
                @check="(m, v) => hub.checkCustom(m, v)"
                @add="(_e, v) => addEndpoint(v)"
                @pick="pickRow"
                @remove="hub.removeCustom"
              />
            </template>
          </HbTierCards>
        </div>
      </template>
      <template #composer-end>
        <HbMicButton v-model:state="micState" :listen="false" title="dictate. the browser recognizer may send audio to its own service." @start="micStart" @stop="micStop" />
      </template>
      <template #above>
        <HbContextMeter :segments="segments" :budget="budget" @new="newChat" @trim="trim" />
      </template>
    </HbChat>
    <HbDrawer v-model="traceOpen" side="right" size="sm" label="memory used">
      <HbRecallTrace :hits="trace?.hits ?? []" :query="traceQuery" :how="trace?.how ?? ''" who="chat" :names="{ rel: 'relevance', rec: 'recency', imp: 'importance' }" />
      <button type="button" class="hb-btn hb-btn-2 hb-btn-sm" @click="openMemory">open in memory</button>
    </HbDrawer>
    <HbDrawer v-if="!wide" v-model="listOpen" side="left" size="sm" label="chats">
      <HbConversationList
        :items="chats"
        :current="doc.doc.value?.id ?? null"
        :busy="busy"
        @open="openFromList"
        @new="newChat"
        @rename="rename"
        @duplicate="(id) => duplicateDoc(id)"
        @remove="removeChat"
        @export="exportChat()"
        @import="pickFiles()"
      />
    </HbDrawer>
  </div>
</template>
