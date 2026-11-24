<script setup lang="ts">
// The character tool, F-1 steps 1 to 8 in part (design 3.9). The wake
// gate starts every subsystem from one press, which is also the audio
// gesture; each row reports alone and only the brain holds the gate. The
// same rows become the pills once it closes. The character greets
// first, talks through the conversation core with memory recall, speaks
// each sentence as it is whole on the speech chain (Pocket TTS first,
// the browser voice after), and its mouth follows the speaker's one
// analyser on the 3d stage. A failing voice or stage marks its pill and
// the rest goes on (P-FAIL-8).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbButton, HbChat, HbHow, HbMessage, HbNameHud, HbPills, HbStageCaption, HbViewport, HbWakeGate,
  type HbChatLine, type HudState, type WakeSystem,
} from '@virgilvox/hackbuild-ui'
import { wakeError, wakePills } from '@virgilvox/hackbuild-ui/vanilla'
import { createConversation, type ChatSession, type Conversation, type ConverseEngine } from '@hackbuild/converse'
import type { ChatEngine } from '@hackbuild/chat'
import type { CardV2 } from '@hackbuild/character'
import type { Engine, Speaker } from '@hackbuild/speak'
import type { Loaded, ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, useStop } from '../shell/shell.ts'
import { settings } from '../shell/settings.ts'
import { exportDoc, kinds, pickFiles, registerKind, useDocument, ws } from '../workspace/state'
import { addChatRuntimes } from '../chat/runtimes.ts'
import { stubChat } from '../chat/stub.ts'
import { addSpeakRuntimes, SYSTEM_ID } from '../speak/runtimes.ts'
import { EMBED_ID } from '../memory/store.ts'
import { characterKind, CHARACTER_KIND, CHIPS, greetingOf, profileFor, systemOf, newCard } from './kind.ts'
import type { CharacterStage } from './stage.ts'

const POCKET_ID = 'pocket-tts'
const memStore = () => import('../memory/store.ts')

if (!kinds.get(CHARACTER_KIND)) registerKind(characterKind)
const route = useRoute()
const doc = useDocument<CardV2>(CHARACTER_KIND)
const card = computed(() => doc.body.value ?? newCard())
const name = computed(() => card.value.data.name || 'mannequin')

// Forced failures for the smoke and the failure shots, under ?stub only: ?stub&fail=voice,brain,3d
const failQ = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fail') ?? '' : ''
const forced = (what: string) => hub.STUB && failQ.split(',').includes(what)

// The gate rows: one per subsystem, the pills read the same rows.
type Row = WakeSystem & { model?: string; pill?: string }
const fresh = (): Row[] => [
  { id: 'brain', label: 'brain', state: 'waiting', note: 'waiting', required: true },
  { id: 'voice', label: 'voice', state: 'waiting', note: 'waiting' },
  { id: 'memory', label: 'memory', state: 'waiting', note: 'waiting' },
  { id: 'body', label: 'body', state: 'waiting', note: 'waiting' },
]
const rows = ref<Row[]>(fresh())
const set = (id: string, patch: Partial<Row>): void => { rows.value = rows.value.map((r: Row) => (r.id === id ? { ...r, ...patch } : r)) }
const pctOf = (id?: string) => {
  const st = id ? hub.states.value[id] : undefined
  return st?.state === 'downloading' && st.total ? (st.loaded ?? 0) / st.total : null
}
const shown = computed<WakeSystem[]>(() => rows.value.map((r: Row): WakeSystem => (r.state === 'loading' && r.model ? { ...r, pct: pctOf(r.model) } : r)))
const pills = computed(() => wakePills(shown.value).map((p, i) => ({ ...p, label: rows.value[i]?.pill ?? p.label })))

// The brain: the default chat row, as the chat tool picks it.
const chatRecords = computed(() => hub.allRecords.value.filter((r) => r.provides.includes('chat')))
const brainRec = computed<ModelRecord | undefined>(() => {
  const d = chatRecords.value.find((r) => r.id === hub.defaultId.value)
  return d ?? chatRecords.value.find((r) => r.group === 'start here' && hub.fits.value[r.id]?.ok !== false) ?? chatRecords.value[0]
})
const pocketRec = computed(() => hub.allRecords.value.find((r) => r.id === POCKET_ID))
const quotaMB = computed(() => {
  const s = hub.storage.value
  return s && s.quota !== null ? (s.quota - (s.used ?? 0)) / (1024 * 1024) : null
})
const origin = typeof location !== 'undefined' && location.protocol === 'file:' ? 'file' : 'http'
const extras = computed(() => (pocketRec.value?.sizeMB ? `pocket tts, ${Math.round(pocketRec.value.sizeMB)} mb (${pocketRec.value.sizeSource}), and the memory model` : 'the voice and memory models'))

const awake = ref(false)
const waking = ref(false)
const gateError = ref('')
const voiceOn = ref(true)
const handles: Loaded[] = []
const hold = async (id: string): Promise<Loaded> => {
  await hub.load(id)
  const st = hub.states.value[id]
  if (st?.state === 'fault') throw new Error(st.error || 'the load failed')
  const l = await hub.hub().use({ id })
  handles.push(l)
  return l
}
const why = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/\.+$/, '')

let booted: Promise<void> | null = null
function boot(): Promise<void> {
  booted ??= (async () => {
    await loadModels()
    addChatRuntimes()
    await addSpeakRuntimes({ kokoro: () => settings.value.kokoro === true })
    const fail = (msg: string) => async () => { throw new Error(msg) }
    if (forced('voice')) hub.provideRuntime('pocket-worker', fail('the voice worker did not start'))
    if (forced('brain') && brainRec.value) hub.provideRuntime(brainRec.value.provider, fail('out of gpu memory'))
  })()
  return booted
}

// The voice: one audio context from the wake press, one speaker, one analyser.
let ctx: AudioContext | null = null
let speaker: Speaker | null = null
const speaking = ref(false)
async function startVoice(): Promise<void> {
  if (!voiceOn.value) return set('voice', { state: 'off', note: 'off, no voice. replies show as text and captions.' })
  const engines: Engine[] = []
  let pocketErr = ''
  set('voice', { state: 'loading', model: POCKET_ID, note: 'loading pocket tts' })
  try {
    engines.push((await hold(POCKET_ID)).value as Engine)
  } catch (e) {
    pocketErr = why(e)
  }
  try {
    engines.push((await hold(SYSTEM_ID)).value as Engine)
  } catch (e) {
    if (!engines.length) return set('voice', { state: 'error', pill: 'voice*', note: `voice is off: ${pocketErr || why(e)}. replies still show as text and captions.` })
  }
  const voice = profileFor(card.value).voice
  const { createSpeaker } = await import('@hackbuild/speak')
  speaker = createSpeaker({
    ctx: ctx!,
    engines,
    voice: { rate: voice.rate, pitch: voice.pitch },
    ...(voice.voiceId ? { voices: { [POCKET_ID]: { voice: voice.voiceId } } } : {}),
    onSpeaking: (s) => {
      speaking.value = s
      cs?.setSpeaking(s)
    },
    onStatus: (s) => { if (s.kind === 'failed' || s.kind === 'watchdog') logEvent('warn', `character voice: ${s.text} the next voice takes over.`) },
  })
  if (pocketErr) set('voice', { state: 'error', pill: 'voice*', note: `pocket tts failed: ${pocketErr}. using the browser voice.` })
  else set('voice', { state: 'ready', note: 'ready, pocket tts, sentence by sentence' })
}

// Memory: the embed row for hybrid recall; without it recall is keyword only.
const memOn = computed(() => profileFor(card.value).memory.enabled)
let memDead = false
async function startMemory(): Promise<void> {
  set('memory', { state: 'loading', model: EMBED_ID, note: 'loading the memory model' })
  let embed = ''
  try {
    await hold(EMBED_ID)
  } catch (e) {
    embed = why(e)
  }
  try {
    await (await memStore()).recallFor('hello')
    set('memory', embed ? { state: 'error', pill: 'memory*', note: `keyword search only: ${embed}.` } : { state: 'ready', note: 'ready, hybrid keyword and vector search' })
  } catch (e) {
    memDead = true
    set('memory', { state: 'error', pill: 'memory*', note: `memory is off: ${why(e)}.` })
  }
}
async function recall(text: string): Promise<{ id: string; text: string }[]> {
  if (!memOn.value || memDead) return []
  try {
    return await (await memStore()).recallFor(text)
  } catch {
    return []
  }
}

// The body: the 3d stage with the placeholder mannequin.
const host = ref<HTMLElement | null>(null)
let cs: CharacterStage | null = null
let gone = false
const stageCover = ref('')
async function startBody(): Promise<void> {
  set('body', { state: 'loading', pct: null, note: 'starting the 3d stage' })
  try {
    if (forced('3d')) throw new Error('webgl is blocked')
    const { createCharacterStage } = await import('./stage.ts')
    if (gone || !host.value) return
    cs = createCharacterStage(host.value, {
      level: () => speaker?.level() ?? 0,
      onBody: (b) => set('body', { state: 'ready', note: b.placeholder ? 'placeholder mannequin. drop a glb or vrm on the stage.' : `ready, ${b.name}${b.mouth ? '' : '. no mouth rig: the head moves instead'}` }),
      onBodyFailed: (m) => logEvent('warn', `that body did not load: ${m}. the mannequin stays.`),
    })
    ;(host.value as HTMLElement & { characterStage?: CharacterStage }).characterStage = cs
  } catch (e) {
    stageCover.value = '3d could not start in this browser. chat and voice still work.'
    set('body', { state: 'error', pill: 'no 3d', note: `3d could not start: ${why(e)}. chat and voice still work.` })
  }
}

// The brain, then the conversation.
const scripted = (id: string) =>
  stubChat({
    id,
    reply: (m) => {
      const last = [...m].reverse().find((x) => x.role === 'user')?.content.trim() ?? ''
      return `heard you: ${last.length > 60 ? `${last.slice(0, 57)}...` : last}\n\nthis reply comes from a script, not a model. no weights were fetched.\n\nload a real brain in the models panel to talk for real.`
    },
  })
const engine = shallowRef<ChatEngine | null>(null)
async function startBrain(): Promise<boolean> {
  const r = brainRec.value
  if (!r) {
    set('brain', { state: 'error', note: 'no chat model in the catalogue' })
    gateError.value = wakeError('brain', 'no chat model in the catalogue')
    return false
  }
  set('brain', { state: 'loading', model: r.id, note: `loading ${r.label ?? r.id}` })
  try {
    const l = await hold(r.id)
    const v = l.value as Partial<ChatEngine> | null
    engine.value = v && typeof v.stream === 'function' ? (v as ChatEngine) : scripted(`stub ${r.label ?? r.id}`)
    set('brain', { state: 'ready', note: `ready, ${r.label ?? r.id}${hub.STUB ? ', scripted' : ''}` })
    return true
  } catch (e) {
    set('brain', { state: 'error', note: `failed: ${why(e)}` })
    gateError.value = wakeError('brain', why(e), 'pick the smaller brain in the models panel, or use your own endpoint.')
    return false
  }
}

let conv: Conversation | null = null
let off: (() => void) | null = null
const session = shallowRef<ChatSession | null>(null)
const busy = ref(false)
const live = ref<{ id: string; text: string } | null>(null)
const proxy: ConverseEngine = { stream: (m, o) => engine.value!.stream(m, o) }
const speakerLike = {
  feed: (t: string, final?: boolean) => (voiceOn.value && speaker ? speaker.feed(t, final) : 0),
  stop: () => speaker?.stop(),
}

async function startTalk(): Promise<void> {
  off?.()
  conv = createConversation({
    engine: proxy,
    now: Date.now,
    id: `character-${doc.doc.value?.id ?? 'new'}`,
    system: systemOf(card.value),
    greeting: greetingOf(card.value),
    speaker: speakerLike,
    memory: { recall },
  })
  off = conv.on((e) => {
    if (e.type === 'change') session.value = e.session
    else if (e.type === 'text') live.value = { id: e.id, text: e.text }
    else if (e.type === 'busy') {
      busy.value = e.busy
      if (!e.busy) live.value = null
    } else if (e.type === 'error') logEvent('fail', `reply stopped: ${e.message.error ?? 'the engine closed'}`)
  })
  session.value = await conv.restore()
}

/** The greeting arrives as a line, a caption and speech at once (P-START-6). */
function greet(): void {
  const first = session.value?.messages[0]
  if (first && voiceOn.value) conv?.speak(first.id)
}

async function wake(lite: boolean): Promise<void> {
  if (waking.value) return
  waking.value = true
  gateError.value = ''
  // the press is the audio gesture: the context is made inside it
  if (!lite) {
    ctx ??= new AudioContext()
    void ctx.resume().catch(() => undefined)
  }
  voiceOn.value = !lite
  rows.value = fresh()
  await boot()
  if (!doc.doc.value) await doc.create(name.value)
  const others = Promise.all([startVoice(), startMemory(), startBody()])
  const ok = await startBrain()
  if (!ok) {
    waking.value = false
    return
  }
  await startTalk()
  awake.value = true
  waking.value = false
  await nextTick()
  cs?.stage.resize()
  // the greeting is spoken once the voice row has settled
  await others
  greet()
  logEvent('note', `character: ${name.value} is awake.`)
}

// The transcript, as HbChat lines; each assistant line renders as FERRULE boxes.
const lines = computed<HbChatLine[]>(() => {
  const s = session.value
  if (!s) return []
  const last = s.messages[s.messages.length - 1]
  return s.messages.map((m) => {
    const streaming = busy.value && m === last && m.role === 'assistant'
    const text = streaming && live.value?.id === m.id ? live.value.text : m.content
    return {
      id: m.id,
      role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system',
      text,
      done: !streaming,
      pending: streaming && !text ? 'thinking' : '',
      ...(m.error ? { note: m.error, error: true } : {}),
      recalled: (m.recalled ?? []).map((r) => ({ title: r.text })),
    }
  })
})
const lastUser = computed(() => [...lines.value].reverse().find((l) => l.role === 'user'))
const lastReply = computed(() => [...lines.value].reverse().find((l) => l.role === 'assistant'))
const hud = computed<HudState>(() => (busy.value && !live.value?.text ? 'thinking' : speaking.value || busy.value ? 'talking' : 'idle'))

const send = (t: string) => void conv?.send(t)
const stop = () => conv?.stop()
useStop(stop)
function speakAt(i: number): void {
  const id = lines.value[i]?.id
  if (!id || !speaker) return
  voiceOn.value = true
  speaker.stop()
  conv?.speak(String(id))
}
function clear(): void {
  conv?.clear()
  greet()
}
function toggleVoice(): void {
  voiceOn.value = !voiceOn.value && !!speaker
  if (!voiceOn.value) speaker?.stop()
}
const exportCard = () => { if (doc.doc.value) void exportDoc(doc.doc.value.id) }

const HOW = `import { createConversation } from "@hackbuild/converse";
import { createSpeaker } from "@hackbuild/speak";
import { fillMacros } from "@hackbuild/character";
import { AvatarStage } from "@hackbuild/avatar-host/three";

const stage = new AvatarStage(host, { environment: "studio" });
stage.showPlaceholder(); // the mannequin, made in code
const speaker = createSpeaker({ ctx: new AudioContext(), engines: [pocket, browserVoice] });
// one analyser: the mouth follows what the speaker plays
stage.scene.onBeforeRender = () => stage.body?.lip.setLevel(speaker.level());
const names = { char: card.data.name, user: "you" };
const conv = createConversation({
  engine, now: Date.now, speaker, memory: { recall },
  system: fillMacros(card.data.system_prompt, names),
  greeting: fillMacros(card.data.first_mes, names),
});
await conv.restore();
await conv.send("what are you"); // each sentence is spoken once it is whole`

onMounted(async () => {
  const q = route.query.doc
  if (typeof q === 'string') await doc.open(q)
  else {
    const all = (await ws.docs()).filter((d) => d.kind === CHARACTER_KIND)
    // a visit makes no document: the first wake does
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  }
  await boot()
})
onBeforeUnmount(() => {
  gone = true
  conv?.stop()
  off?.()
  speaker?.dispose()
  cs?.dispose()
  cs = null
  for (const l of handles) hub.hub().release(l)
  void ctx?.close()
})
</script>

<template>
  <div class="hb-toolpage is-split">
    <HbWakeGate
      v-if="!awake"
      class="is-full"
      :systems="shown"
      tag="character // in this tab"
      ver="v1"
      :title="`wake ${name} up.`"
      :lede="`${name} lives in this tab: a brain, a voice, a memory and a body. nothing is sent to a server. the models download once and stay in this browser. the wake press also turns on sound.`"
      :size-m-b="brainRec?.sizeMB ?? null"
      :size-source="brainRec?.sizeSource ?? 'unknown'"
      :origin="origin"
      :quota-m-b="quotaMB"
      :webgpu="hub.env.value?.webgpu ?? true"
      :extras="extras"
      :error="gateError"
      :busy="waking"
      wake-label="wake"
      lite-label="no voice"
      lite-title="skip the voice download. replies show as text and captions."
      @wake="wake(false)"
      @wake-lite="wake(true)"
    />

    <div v-show="awake" class="is-full hb-acts">
      <HbPills :items="pills" :label="`${name}, subsystems`" />
      <HbButton variant="secondary" size="sm" :aria-pressed="voiceOn" :disabled="!speaker" @click="toggleVoice">{{ voiceOn ? 'voice on' : 'voice off' }}</HbButton>
      <HbButton variant="secondary" size="sm" :disabled="busy" @click="clear">clear</HbButton>
      <HbButton variant="secondary" size="sm" @click="exportCard">export</HbButton>
      <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
    </div>

    <div v-show="awake" class="hb-toolpage is-side">
      <HbChat
        :lines="lines"
        :streaming="busy"
        split
        label="talk"
        user-name="you"
        :assistant-name="name"
        :placeholder="`say something to ${name}`"
        @send="send"
        @stop="stop"
        @speak="speakAt"
        @retry="() => void conv?.redo()"
      >
        <template #message="{ line, index }">
          <HbMessage
            :who="line.role"
            :name="line.role === 'user' ? 'you' : name"
            :text="line.text"
            :split="line.role === 'assistant'"
            :boxed="line.role !== 'system'"
            :streaming="line.done === false"
            :pending="line.pending ?? ''"
            :error="line.error ? line.note ?? '' : ''"
            :recalled="line.recalled ?? []"
            :actions="line.role === 'assistant' ? (index === lines.length - 1 && index > 0 ? ['speak', 'retry'] : ['speak']) : []"
            @speak="speakAt(index)"
            @retry="() => void conv?.redo()"
          />
          <div v-if="index === 0 && lines.length === 1" class="hb-chat-examples">
            <button v-for="c in CHIPS" :key="c" type="button" class="hb-chip" @click="send(c)">{{ c }}</button>
          </div>
        </template>
      </HbChat>
      <HbHow
        :packages="['@hackbuild/character', '@hackbuild/converse', '@hackbuild/speak', '@hackbuild/avatar-host', '@hackbuild/lipsync', '@hackbuild/presence', '@hackbuild/memory']"
        install="npm i @hackbuild/character @hackbuild/converse @hackbuild/speak @hackbuild/avatar-host"
        :code="HOW"
        persist-key="character-how"
      />
    </div>

    <HbViewport v-show="awake" look="lit" aspect="4/3" :label="`${name} on the stage`" :cover-title="stageCover || undefined" :cover-error="!!stageCover">
      <div ref="host" class="hb-viewport-host" />
      <template #tl><HbNameHud :name="name" :state="hud" :state-text="voiceOn ? '' : hud === 'idle' ? 'no voice' : ''" /></template>
      <template #caption>
        <HbStageCaption :echo="lastUser ? `you: ${lastUser.text}` : ''" :line="lastReply?.text ?? ''" :who="name" :max-chars="160" />
      </template>
    </HbViewport>
  </div>
</template>
