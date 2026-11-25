<script setup lang="ts">
// The character tool, F-1 steps 1 to 8 in part (design 3.9). The wake
// gate starts every subsystem from one press, which is also the audio
// gesture; each row reports alone and only the brain holds the gate. The
// same rows become the pills once it closes. The character greets
// first, talks through the conversation core with memory recall, speaks
// each sentence as it is whole on the speech chain (Pocket TTS first,
// the browser voice after), and its mouth follows the speaker's one
// analyser on the 3d stage. A failing voice or stage marks its pill and
// the rest goes on (P-FAIL-8). Steps 7 to 14: the sheet tabs apply live
// (persona, voice, brain, memory, moves, look) and the mind tab shows the
// last prompt, reply, plan and cost; the brain is picked as tier cards on
// the gate and the brain tab; "new" makes a character and shows its setup
// rows with reasons; the stage menu sends lines; the mic listens hands free
// or push to talk; the conversation is saved inside the character file.
// Twin mode fills the body, voice and persona from files the person drops
// on the gate: no url, no default, held in memory unless kept, flagged
// local, and left out of exports unless ticked there.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbApiKey, HbButton, HbChat, HbContextMenu, HbDropzone, HbField, HbFold, HbHow, HbInput, HbMessage, HbMicButton, HbNameHud, HbPersonaEditor, HbPills,
  HbPromptInspector, HbReasons, HbSeg, HbSlider, HbStageCaption, HbStepCard, HbTabs, HbTag, HbTierCards, HbToggleRow, HbViewport, HbWakeGate,
  type HbChatLine, type HbContextItem, type HbReasonRow, type HbTier, type HudState, type WakeSystem,
} from '@virgilvox/hackbuild-ui'
import { tokenEstimate, wakeError, wakePills, type MicState, type PersonaFile, type PersonaPreset, type PromptMessage, type StepState } from '@virgilvox/hackbuild-ui/vanilla'
import { createConversation, type ChatMessage, type ChatSession, type Conversation, type ConverseEngine, type EngineEvent } from '@hackbuild/converse'
import type { ChatEngine } from '@hackbuild/chat'
import type { CardV2 } from '@hackbuild/character'
import type { Engine, Speaker } from '@hackbuild/speak'
import type { Loaded, ModelRecord } from '@hackbuild/models'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, useStop } from '../shell/shell.ts'
import { settings } from '../shell/settings.ts'
import { claimDrops, exportDoc, kinds, pickFiles, registerKind, useDocument, ws } from '../workspace/state'
import { blobRef } from '../workspace/workspace.ts'
import { addChatRuntimes } from '../chat/runtimes.ts'
import { stubChat } from '../chat/stub.ts'
import { addSpeakRuntimes, SYSTEM_ID } from '../speak/runtimes.ts'
import { EMBED_ID } from '../memory/store.ts'
import { characterKind, CHARACTER_KIND, CHIPS, greetingOf, profileFor, systemOf, newCard } from './kind.ts'
import type { CharacterStage } from './stage.ts'
import { BUILT_IN, cardSink, EXT, extOf, LENGTHS, loadPresets, personaOf, planOf, REGISTERS, savePresets, setExt, withPersona, type Length, type Plan, type Register, type TierKey } from './sheet.ts'
import type { Ears } from './ears.ts'
import { showBodyFiles } from '../stagekit/body.ts'
import { BODY_ACCEPT, PERSONA_ACCEPT, personaFrom, sizeOf, slotOf, TWIN_EMPTY, VOICE_ACCEPT, whereLine, type SlotKey, type TwinExt } from './twin.ts'
import type { DropRoute } from '@virgilvox/hackbuild-ui/vanilla'
import how from '@hackbuild/character/how'

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
  })()
  return booted
}

// The voice: one audio context from the wake press, one speaker, one analyser.
let ctx: AudioContext | null = null
let speaker: Speaker | null = null
const speaking = ref(false)
let voiceEngines: Engine[] = []
type Cloner = Engine & { cloneVoice?: (s: Float32Array, rate: number) => Promise<void> }
let pocket: Cloner | null = null
const cloned = ref(false)
/** The speaker from the card's voice; the voice tab makes a new one. */
async function makeSpeaker(): Promise<void> {
  if (!voiceEngines.length || !ctx) return
  const voice = profileFor(card.value).voice
  const { createSpeaker } = await import('@hackbuild/speak')
  speaker?.dispose()
  speaker = createSpeaker({
    ctx,
    engines: voiceEngines,
    voice: { rate: voice.rate, pitch: voice.pitch },
    ...(cloned.value ? { voices: { [POCKET_ID]: { voice: 'custom' } } } : voice.voiceId ? { voices: { [POCKET_ID]: { voice: voice.voiceId } } } : {}),
    onSpeaking: (s) => {
      speaking.value = s
      cs?.setSpeaking(s)
      ears?.setTalking(s)
    },
    onStatus: (s) => { if (s.kind === 'failed' || s.kind === 'watchdog') logEvent('warn', `character voice: ${s.text} the next voice takes over.`) },
  })
}
async function startVoice(): Promise<void> {
  if (!voiceOn.value) return set('voice', { state: 'off', note: 'off, no voice. replies show as text and captions.' })
  if (speaker) return set('voice', { state: 'ready', note: 'ready, the voice is up' })
  const engines: Engine[] = []
  let pocketErr = ''
  set('voice', { state: 'loading', model: POCKET_ID, note: 'loading pocket tts' })
  try {
    pocket = (await hold(POCKET_ID)).value as Cloner
    engines.push(pocket)
  } catch (e) {
    pocketErr = why(e)
  }
  try {
    engines.push((await hold(SYSTEM_ID)).value as Engine)
  } catch (e) {
    if (!engines.length) return set('voice', { state: 'error', pill: 'voice*', note: `voice is off: ${pocketErr || why(e)}. replies still show as text and captions.` })
  }
  voiceEngines = engines
  await makeSpeaker()
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
  if (cs) return set('body', { state: 'ready', note: 'ready, the stage is up' })
  set('body', { state: 'loading', pct: null, note: 'starting the 3d stage' })
  try {
    if (forced('3d')) throw new Error('webgl is blocked')
    const { createCharacterStage } = await import('./stage.ts')
    if (gone || !host.value) return
    cs = createCharacterStage(host.value, {
      level: () => speaker?.level() ?? 0,
      onBody: (b) => set('body', { state: 'ready', note: b.placeholder ? 'placeholder mannequin. drop a glb, vrm, pmx or pmd on the stage.' : `ready, ${b.name}${b.mouth ? '' : '. no mouth rig: the head moves instead'}` }),
      onBodyFailed: (msg) => {
        const m = msg.replace(/\.+$/, '')
        set('body', { state: 'ready', pill: 'body*', note: `that body did not load: ${m}. the mannequin stays.` })
        logEvent('warn', `that body did not load: ${m}. the mannequin stays.`)
      },
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

// Persona tiers (F-7 steps 1 and 2, P-MODEL-6, P-MODEL-7): no model, in
// this tab, a lighter one, and your endpoint. A failed load marks the card
// and the gate stays; a fall to the lighter brain happens once and is
// written on the row.
const lightRec = computed<ModelRecord | undefined>(() => {
  const big = brainRec.value
  return chatRecords.value
    .filter((r) => r.id !== big?.id && r.sizeMB !== null && r.provider === big?.provider && (big?.sizeMB ?? 0) > (r.sizeMB ?? 0) && hub.fits.value[r.id]?.ok !== false)
    .sort((x, y) => (x.sizeMB ?? 0) - (y.sizeMB ?? 0))[0]
})
const tier = ref<TierKey>('tab')
const tierFault = ref<Partial<Record<TierKey, string>>>({})
const remoteUrl = ref('')
const remoteModel = ref('')
const remoteKey = ref('')
const keyOk = ref(false)
const mb = (r?: ModelRecord) => (r?.sizeMB ? `${r.sizeMB >= 1024 ? `${(r.sizeMB / 1024).toFixed(1)} gb` : `${Math.round(r.sizeMB)} mb`} (${r.sizeSource})` : 'size unknown')
const tiers = computed<HbTier[]>(() => {
  const f = tierFault.value
  const t: HbTier[] = [
    { key: 'none', label: 'no model', sub: 'scripted replies', size: 'none', cost: 'free, no download', privacy: 'nothing leaves this tab', note: 'answers from a script. the voice, memory and stage still work.', error: f.none, bar: 0.1 },
    { key: 'tab', label: 'in this tab', sub: brainRec.value ? (brainRec.value.label ?? brainRec.value.id) : 'no chat model', size: mb(brainRec.value), cost: 'free, runs on your gpu', privacy: 'nothing leaves this tab', note: 'holds the persona and the tags best of the local brains.', error: f.tab, bar: 0.6, disabled: !brainRec.value },
  ]
  if (lightRec.value) t.push({ key: 'light', label: 'lighter', sub: lightRec.value.label ?? lightRec.value.id, size: mb(lightRec.value), cost: 'free, less gpu memory', privacy: 'nothing leaves this tab', note: 'loads faster. drifts from the persona and misses tags more often.', error: f.light, bar: 0.35 })
  t.push({ key: 'remote', label: 'your endpoint', sub: 'any openai style server', size: 'api', cost: 'what your server charges', privacy: 'your words go to that server', note: 'the key stays in this tab for this visit and is never saved.', error: f.remote, bar: 0.9 })
  return t
})
const canStart = computed(() => tier.value !== 'remote' || (keyOk.value || !remoteKey.value) && /^https?:\/\/\S+$/.test(remoteUrl.value))
const tierLabel = computed(() => tiers.value.find((t) => t.key === tier.value)?.label ?? tier.value)

async function loadRec(r: ModelRecord): Promise<ChatEngine> {
  if (forced('brain')) throw new Error('out of gpu memory')
  const l = await hold(r.id)
  const v = l.value as Partial<ChatEngine> | null
  return v && typeof v.stream === 'function' ? (v as ChatEngine) : scripted(`stub ${r.label ?? r.id}`)
}
async function startBrain(): Promise<boolean> {
  const k = tier.value
  const r = k === 'light' ? lightRec.value : brainRec.value
  if (k === 'none') {
    engine.value = scripted('no model')
    set('brain', { state: 'ready', note: 'ready, no model: scripted replies' })
    return true
  }
  if (k === 'remote') {
    set('brain', { state: 'loading', note: `connecting to ${remoteUrl.value}` })
    const { openaiCompatible } = await import('@hackbuild/chat/remote')
    engine.value = openaiCompatible({ base: remoteUrl.value.replace(/\/+$/, ''), model: remoteModel.value || 'default', ...(remoteKey.value ? { apiKey: remoteKey.value } : {}) })
    set('brain', { state: 'ready', note: `ready, your endpoint ${remoteUrl.value}` })
    return true
  }
  if (!r) {
    set('brain', { state: 'error', note: 'no chat model in the catalogue' })
    gateError.value = wakeError('brain', 'no chat model in the catalogue')
    return false
  }
  set('brain', { state: 'loading', model: r.id, note: `loading ${r.label ?? r.id}` })
  try {
    engine.value = await loadRec(r)
    set('brain', { state: 'ready', note: `ready, ${r.label ?? r.id}${hub.STUB ? ', scripted' : ''}` })
    return true
  } catch (e) {
    const first = why(e)
    tierFault.value = { ...tierFault.value, [k]: `failed: ${first}.` }
    // the fall to the lighter brain, once, written on the row
    const l = k === 'tab' ? lightRec.value : undefined
    if (l) {
      set('brain', { state: 'loading', model: l.id, note: `${r.label ?? r.id} failed: ${first}. trying the lighter ${l.label ?? l.id} once.` })
      try {
        engine.value = await loadRec(l)
        tier.value = 'light'
        set('brain', { state: 'ready', note: `ready, ${l.label ?? l.id}. fell from ${r.label ?? r.id}: ${first}.` })
        return true
      } catch (e2) {
        tierFault.value = { ...tierFault.value, light: `failed: ${why(e2)}.` }
      }
    }
    set('brain', { state: 'error', note: `failed: ${first}` })
    gateError.value = wakeError('brain', first, 'pick no model or a smaller brain above, or use your own endpoint.')
    return false
  }
}
/** The brain tab's start: the old brain answers until the new one is ready (P-MODEL-18). */
async function swapBrain(): Promise<void> {
  const before = engine.value
  const ok = await startBrain()
  if (!ok) {
    engine.value = before
    set('brain', { state: 'ready', note: `kept the old brain: ${gateError.value}` })
    gateError.value = ''
  } else {
    doc.edit((c) => setExt(c, { tier: tier.value }))
    logEvent('note', `character: the brain is now ${tierLabel.value}.`)
  }
}

// The agent inspector (P-TRACE-2, P-TRACE-4, P-TRACE-6): every model call
// is recorded as it streams, with the prompt the model saw.
interface Turn { n: number; prompt: PromptMessage[]; reply: string; plan: Plan; ms: number; in: number; out: number; state: StepState; recalled: number; why?: string }
const turns = ref<Turn[]>([])
const calls = ref(0)
const fails = ref(0)
const lastTurn = computed(() => turns.value[turns.value.length - 1])
let sysAtStart = ''
const liveSystem = (m: readonly ChatMessage[]): ChatMessage[] => {
  // the persona applies live: the system prefix is rewritten from the card on every call
  const now = systemOf(card.value)
  return m.map((x, i) => (i === 0 && x.role === 'system' && x.content.startsWith(sysAtStart) ? { ...x, content: now + x.content.slice(sysAtStart.length) } : x))
}
async function* traced(m: readonly ChatMessage[], o?: { signal?: AbortSignal }): AsyncIterable<EngineEvent> {
  const sent = liveSystem(m)
  const t0 = performance.now()
  calls.value++
  const turn: Turn = { n: calls.value, prompt: sent.map((x) => ({ role: x.role, content: x.content })), reply: '', plan: { say: [], do: [] }, ms: 0, in: tokenEstimate(sent.map((x) => x.content).join('\n')), out: 0, state: 'thinking', recalled: session.value?.messages.at(-1)?.recalled?.length ?? 0 }
  turns.value = [...turns.value.slice(-11), turn]
  const touch = () => { turns.value = turns.value.map((t) => (t.n === turn.n ? { ...turn } : t)) }
  try {
    for await (const e of engine.value!.stream(sent, o) as AsyncIterable<EngineEvent>) {
      if (e.type === 'text') turn.reply += e.text
      if (e.type === 'done') {
        turn.reply = e.result.text || turn.reply
        if (e.result.stats) turn.out = e.result.stats.tokens
      }
      yield e
    }
    turn.state = 'ok'
  } catch (err) {
    fails.value++
    turn.state = 'fail'
    turn.why = err instanceof Error ? err.message : String(err)
    throw err
  } finally {
    turn.ms = Math.round(performance.now() - t0)
    turn.out ||= tokenEstimate(turn.reply)
    turn.plan = planOf(turn.reply)
    touch()
  }
}
const counters = computed<Array<[string, number | string]>>(() => [['model calls', calls.value], ['failed calls', fails.value], ['brain', tierLabel.value], ['memories in the last prompt', lastTurn.value?.recalled ?? 0]])

let conv: Conversation | null = null
let off: (() => void) | null = null
const session = shallowRef<ChatSession | null>(null)
const busy = ref(false)
const live = ref<{ id: string; text: string } | null>(null)
const proxy: ConverseEngine = { stream: (m, o) => traced(m, o) }
const speakerLike = {
  feed: (t: string, final?: boolean) => (voiceOn.value && speaker ? speaker.feed(t, final) : 0),
  stop: () => speaker?.stop(),
}
// the conversation lives inside the character file
const sink = cardSink({
  read: () => (doc.doc.value ? { id: doc.doc.value.id, card: card.value } : null),
  write: (t) => doc.edit((c) => setExt(c, { transcript: t })),
})

async function startTalk(): Promise<void> {
  conv?.stop()
  off?.()
  // the old conversation's last busy event is not heard after off
  busy.value = false
  live.value = null
  if (!doc.doc.value) await doc.create(name.value)
  sysAtStart = systemOf(card.value)
  conv = createConversation({
    engine: proxy,
    now: Date.now,
    id: doc.doc.value!.id,
    system: sysAtStart,
    greeting: greetingOf(card.value),
    speaker: speakerLike,
    memory: { recall },
    sink,
    debounceMs: 250,
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
  const others = Promise.all([startVoice().then(cloneTwin), startMemory(), startBody().then(showTwinBody)])
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
const exportCard = (format?: string) => { if (doc.doc.value) void exportDoc(doc.doc.value.id, format ? { format } : {}) }

// The sheet (step 7): every tab writes the card, and the card applies live.
const SHEET = ['persona', 'voice', 'brain', 'memory', 'moves', 'look', 'mind']
const sheetTab = ref<string | number>('persona')
const presets = ref<PersonaPreset[]>([...BUILT_IN, ...loadPresets()])
const keepPresets = () => savePresets(presets.value.slice(BUILT_IN.length))
const persona = computed<PersonaFile>({
  get: () => personaOf(card.value),
  set: (f) => doc.edit((c) => withPersona(c, f)),
})
const register = computed<Register>({ get: () => extOf(card.value).register ?? 'person', set: (v) => doc.edit((c) => setExt(c, { register: v })) })
const length = computed<Length>({ get: () => extOf(card.value).length ?? 'normal', set: (v) => doc.edit((c) => setExt(c, { length: v })) })
const promptTokens = computed(() => tokenEstimate(systemOf(card.value)))
function editProfile(fn: (p: ReturnType<typeof profileFor>) => void): void {
  doc.edit((c) => {
    const p = structuredClone(profileFor(c))
    fn(p)
    c.data.extensions = { ...c.data.extensions, hackbuild: p }
    return c
  })
}
const rate = computed<number>({ get: () => profileFor(card.value).voice.rate, set: (v) => editProfile((p) => { p.voice.rate = v }) })
const pitch = computed<number>({ get: () => profileFor(card.value).voice.pitch, set: (v) => editProfile((p) => { p.voice.pitch = v }) })
let voiceT: ReturnType<typeof setTimeout> | undefined
watch([rate, pitch], () => {
  clearTimeout(voiceT)
  voiceT = setTimeout(() => void makeSpeaker(), 300)
})
const memOnModel = computed<boolean>({ get: () => memOn.value, set: (v) => editProfile((p) => { p.memory.enabled = v }) })
const BEHAVIOURS = ['gaze', 'blink', 'breath', 'idle'] as const
const behaviour = (k: (typeof BEHAVIOURS)[number]) => computed<boolean>({ get: () => profileFor(card.value).behavior[k], set: (v) => editProfile((p) => { p.behavior[k] = v }) })
const behaviours = BEHAVIOURS.map((k) => ({ k, model: behaviour(k) }))
const background = ref<'studio' | 'none'>('studio')
watch(background, (b) => void cs?.stage.showEnvironment(b === 'studio' ? 'studio' : null))
const camera = (how: 'full' | 'closer' | 'further') => {
  const st = cs?.stage
  if (!st) return
  if (how === 'full') st.resetView()
  else st.zoomBy(how === 'closer' ? 0.8 : 1.25)
}
const clips = computed(() => (rows.value.find((r: Row) => r.id === 'body')?.state === 'ready' ? (cs?.stage.body?.caps.clips ?? []) : []))

// New character (step 10): made at once, then its setup rows with reasons.
const setupOpen = ref(false)
async function newCharacter(): Promise<void> {
  const n = `character ${(await ws.docs()).filter((d) => d.kind === CHARACTER_KIND).length + 1}`
  await doc.create(n)
  doc.edit((c) => {
    c.data.name = n
    return setExt(c, { tier: tier.value })
  })
  turns.value = []
  if (awake.value) {
    await startTalk()
    greet()
  }
  setupOpen.value = true
  logEvent('note', `character: made ${n}.`)
}
const brainState = computed(() => {
  const r = tier.value === 'light' ? lightRec.value : tier.value === 'tab' ? brainRec.value : undefined
  return r ? { r, ready: ['stored', 'loaded'].includes(hub.states.value[r.id]?.state ?? 'none') } : null
})
const setupRows = computed<HbReasonRow[]>(() => [
  { key: 'name', label: 'name', value: name.value, why: 'a new name. change it on the persona tab.' },
  { key: 'persona', label: 'persona', value: `${promptTokens.value} tokens`, why: 'the starter prompt. insert the template on the persona tab.' },
  { key: 'brain', label: 'brain', value: `${tierLabel.value}${brainState.value ? `, ${brainState.value.r.label ?? brainState.value.r.id}` : ''}`, why: tier.value === 'none' ? 'no download. replies come from a script.' : 'the brain that is awake now, kept for the new character.' },
  { key: 'voice', label: 'voice', value: speaker ? (rows.value.find((r: Row) => r.id === 'voice')?.pill ? 'browser voice' : 'pocket tts') : 'off', why: 'the voice of the gate. rate and pitch are on the voice tab.' },
  { key: 'look', label: 'body', value: 'mannequin', why: 'no body file yet. drop a glb, vrm, pmx or pmd on the stage.' },
  { key: 'memory', label: 'memory', value: memOn.value ? 'on' : 'off', why: 'recalls notes from the memory tool into each prompt.' },
])
function setupEdit(key: string): void {
  setupOpen.value = false
  sheetTab.value = key === 'name' ? 'persona' : key
}

// The stage menu (step 12): right click or long press, lines to say.
const menuItems = computed<HbContextItem[]>(() => [
  { label: 'say hello', say: 'hello' },
  { label: 'ask what it is', say: 'what are you' },
  { label: 'ask for a story', say: 'tell me a short story' },
  { label: 'ask it to be brief', say: 'keep it short from now on' },
  { label: 'stop talking', say: '', disabled: !busy.value && !speaking.value },
])
const menuTitle = ref('')
const menuOpen = ref(false)
function menuPick(item: HbContextItem, say: string): void {
  if (!item.say) return stop()
  send(say)
}

// The ears (step 13): hands free or push to talk, gated while speaking.
const handsFree = ref(false)
const micState = ref<MicState>('off')
const micLevel = ref(0)
const draft = ref('')
let ears: Ears | null = null
let opening: Promise<Ears | null> | null = null
async function openMicEars(): Promise<Ears | null> {
  opening ??= (async () => {
    micState.value = 'asking'
    try {
      const [{ addTranscribeRuntimes }, { defaultTranscribeId }, { hubTranscriber }, { openEars }] = await Promise.all([
        import('../transcribe/runtimes.ts'), import('@hackbuild/transcribe'), import('@hackbuild/listen'), import('./ears.ts'),
      ])
      await addTranscribeRuntimes()
      const id = defaultTranscribeId(hub.env.value?.webgpu ?? false)
      await hold(id)
      ctx ??= new AudioContext()
      void ctx.resume().catch(() => undefined)
      ears = await openEars(ctx, hubTranscriber(hub.hub(), { model: id }), {
        state: (s) => { micState.value = s },
        level: (v) => { micLevel.value = v },
        heard: (t) => {
          draft.value = t
          void nextTick(() => {
            draft.value = ''
            send(t)
          })
        },
        dropped: (w) => logEvent('note', `character: the mic heard noise, not words: ${w}.`),
        failed: (m) => logEvent('warn', `character: the mic stopped: ${m}.`),
      }, handsFree.value)
      ears.setTalking(speaking.value)
      return ears
    } catch (e) {
      micState.value = /blocked/.test(why(e)) ? 'blocked' : 'off'
      logEvent('warn', `character: ${why(e)}.`)
      return null
    } finally {
      opening = null
    }
  })()
  return opening
}
async function micStart(): Promise<void> {
  const e = ears ?? (await openMicEars())
  if (!e) return
  if (handsFree.value) e.setHandsFree(true)
  else e.press()
}
async function micStop(): Promise<void> {
  if (!ears) return
  if (handsFree.value) {
    ears.stop()
    ears = null
  } else await ears.release()
}
watch(handsFree, (on) => {
  ears?.setHandsFree(on)
  if (!on && micState.value !== 'off' && ears) micState.value = 'off'
})

// Twin mode (design 3.9, section 5 item 5): three slots filled only by a
// dropped file. The body and voice are held in memory; "keep on this
// device" stores them as local blobs the card points at, and unticking it
// deletes them from this browser.
const MODES = [{ label: 'character', value: 'character' }, { label: 'twin', value: 'twin' }]
const mode = ref<'character' | 'twin'>('character')
const twinBody = shallowRef<File | null>(null)
const twinVoice = shallowRef<File | null>(null)
const twinPersona = ref('')
const twinError = ref('')
const keep = ref(false)
const twinEmpty = computed(() => !twinBody.value && !twinVoice.value && !twinPersona.value)
const twinRows = computed<HbReasonRow[]>(() => {
  const where = keep.value ? 'kept in this browser, local only.' : 'in this tab only, in memory.'
  return [
    { key: 'body', label: 'body', value: twinBody.value ? `${twinBody.value.name}, ${sizeOf(twinBody.value.size)}` : 'empty', why: twinBody.value ? where : 'drop a glb, vrm, pmx or pmd. the mannequin stands in until then.' },
    { key: 'voice', label: 'voice', value: twinVoice.value ? `${twinVoice.value.name}, ${sizeOf(twinVoice.value.size)}` : 'empty', why: twinVoice.value ? `${where} pocket tts clones it at wake.` : 'drop a wav of your voice, 8 s or more.' },
    { key: 'persona', label: 'persona', value: twinPersona.value || 'empty', why: twinPersona.value ? 'written into the character. it is text and exports with it.' : 'drop a persona json or a character card.' },
  ]
})
async function ensureDoc(): Promise<void> {
  if (!doc.doc.value) await doc.create(name.value)
}
const twinOf = (): TwinExt | undefined => extOf(card.value).twin
async function storeTwin(): Promise<void> {
  await ensureDoc()
  const before = twinOf()
  const t: TwinExt = { keep: true }
  for (const [k, f] of [['body', twinBody.value], ['voice', twinVoice.value]] as const) {
    if (f) t[k] = blobRef(await ws.putBlob(new Uint8Array(await f.arrayBuffer()), { name: f.name, type: f.type || (k === 'body' ? 'model/gltf-binary' : 'audio/wav'), local: true }))
  }
  doc.edit((c) => setExt(c, { twin: t }))
  for (const k of ['body', 'voice'] as const) {
    const h = before?.[k]?.$blob
    if (h && h !== t[k]?.$blob) await ws.deleteBlob(h)
  }
}
async function forgetTwin(): Promise<void> {
  const t = twinOf()
  if (!t) return
  doc.edit((c) => {
    const x = { ...extOf(c) }
    delete x.twin
    c.data.extensions = { ...c.data.extensions, [EXT]: x }
    return c
  })
  for (const k of ['body', 'voice'] as const) if (t[k]) await ws.deleteBlob(t[k]!.$blob)
}
let restoring = false
watch(keep, (on) => {
  if (restoring) return
  void (on ? storeTwin() : forgetTwin()).then(() => logEvent('note', `twin: ${whereLine(on)}`))
})
async function restoreTwin(): Promise<void> {
  const t = twinOf()
  if (!t) return
  restoring = true
  for (const k of ['body', 'voice'] as const) {
    const b = t[k] && (await ws.getBlob(t[k]!.$blob))
    if (b) (k === 'body' ? twinBody : twinVoice).value = new File([b.data as Uint8Array<ArrayBuffer>], b.name, { type: b.type })
  }
  keep.value = true
  mode.value = 'twin'
  await nextTick()
  restoring = false
}
async function fillSlot(slot: SlotKey, files: File[]): Promise<void> {
  const f = files[0]
  if (!f) return
  twinError.value = ''
  if (slot === 'persona') {
    try {
      const p = personaFrom(JSON.parse(await f.text()))
      await ensureDoc()
      doc.edit((c) => withPersona(c, p))
      twinPersona.value = `${p.name}, from ${f.name}`
    } catch (e) {
      twinError.value = e instanceof SyntaxError ? `${f.name} is not json.` : why(e) + '.'
    }
    return
  }
  ;(slot === 'body' ? twinBody : twinVoice).value = f
  if (keep.value) await storeTwin()
}
async function clearSlot(slot: string): Promise<void> {
  if (slot === 'persona') twinPersona.value = ''
  else (slot === 'body' ? twinBody : twinVoice).value = null
  if (keep.value && slot !== 'persona') await storeTwin()
}
const twinRoutes: DropRoute[] = [
  { name: 'body', accept: BODY_ACCEPT, on: (f) => void fillSlot('body', f) },
  { name: 'voice', accept: VOICE_ACCEPT, on: (f) => void fillSlot('voice', f) },
  { name: 'persona', accept: PERSONA_ACCEPT, on: (f) => void fillSlot('persona', f) },
]
const twinReject = (files: File[]) => {
  const f = files.find((x) => !slotOf(x))
  twinError.value = f ? `${f.name} fills no slot. the body takes a glb, vrm, pmx or pmd, the voice a wav, the persona a json.` : ''
}
const twinOn = computed(() => mode.value === 'twin')
// a file dropped anywhere on the page fills its slot while the twin gate shows
watch([twinOn, awake], ([on, up]) => claimDrops(on && !up ? { accept: (f) => !!slotOf(f), take: (files) => { for (const f of files) void fillSlot(slotOf(f)!, [f]) } } : null), { immediate: true })
async function showTwinBody(): Promise<void> {
  if (twinOn.value && twinBody.value && cs) await showBodyFiles(cs.stage, [twinBody.value], (m) => { twinError.value = m })
}
async function cloneTwin(): Promise<void> {
  const f = twinVoice.value
  if (!twinOn.value || !f || !voiceOn.value) return
  if (!pocket?.cloneVoice) return set('voice', { state: 'error', pill: 'voice*', note: `no clone: pocket tts did not start. the browser voice speaks.` })
  try {
    const [{ decodeAudio }, { toMono }] = await Promise.all([import('@hackbuild/media'), import('@hackbuild/speak')])
    const a = await decodeAudio(f)
    await pocket.cloneVoice(toMono(a.channels), a.sampleRate)
    cloned.value = true
    await makeSpeaker()
    const short = a.duration < 8 ? `. the clip is ${a.duration.toFixed(0)} s; 8 s or more copies a voice better` : ''
    set('voice', { state: 'ready', note: `ready, pocket tts cloned from ${f.name}${short}` })
  } catch (e) {
    set('voice', { state: 'error', pill: 'voice*', note: `no clone: ${why(e)}. pocket tts speaks in its own voice.` })
  }
}

onMounted(async () => {
  const q = route.query.doc
  if (typeof q === 'string') await doc.open(q)
  else {
    const all = (await ws.docs()).filter((d) => d.kind === CHARACTER_KIND)
    // a visit makes no document: the first wake does
    if (all.length) await doc.open(all.sort((a, b) => b.updated - a.updated)[0]!.id)
  }
  tier.value = extOf(card.value).tier ?? 'tab'
  await restoreTwin()
  await boot()
})
// an imported or picked character opens here: talk to it at once
watch(() => route.query.doc, async (id) => {
  if (typeof id !== 'string' || id === doc.doc.value?.id) return
  await doc.open(id)
  turns.value = []
  if (awake.value) await startTalk()
  logEvent('note', `character: opened ${name.value}.`)
})
onBeforeUnmount(() => {
  gone = true
  claimDrops(null)
  clearTimeout(voiceT)
  ears?.stop()
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
      :lede="`${name} lives in this tab: a brain, a voice, a memory and a body. nothing is sent to a server unless you pick your endpoint. the models download once and stay in this browser. the wake press also turns on sound.`"
      :size-m-b="tier === 'tab' || tier === 'light' ? ((tier === 'light' ? lightRec : brainRec)?.sizeMB ?? null) : 0"
      :size-source="brainRec?.sizeSource ?? 'unknown'"
      :origin="origin"
      :quota-m-b="quotaMB"
      :webgpu="hub.env.value?.webgpu ?? true"
      :extras="extras"
      :error="gateError"
      :busy="waking || !canStart"
      wake-label="wake"
      lite-label="no voice"
      lite-title="skip the voice download. replies show as text and captions."
      @wake="wake(false)"
      @wake-lite="wake(true)"
    >
      <template #picker>
        <HbField label="mode"><HbSeg v-model="mode" :options="MODES" /></HbField>
        <div v-if="twinOn" class="hb-stack">
          <p class="hb-hint">{{ twinEmpty ? TWIN_EMPTY : whereLine(keep) }}</p>
          <HbDropzone :routes="twinRoutes" :accept="`${BODY_ACCEPT},${VOICE_ACCEPT},${PERSONA_ACCEPT}`" multiple label="pick files" hint="or drop a glb, vrm, pmx or pmd, a wav and a persona json here" :error="twinError" @rejected="twinReject" />
          <HbReasons :rows="twinRows" label="twin slots">
            <template #edit="{ row }">
              <HbButton v-if="row.value !== 'empty'" variant="ghost" size="sm" @click="clearSlot(row.key ?? row.label)">remove</HbButton>
            </template>
          </HbReasons>
          <HbToggleRow v-model="keep" label="keep on this device" :description="whereLine(keep)" />
        </div>
        <HbTierCards v-model="tier" :tiers="tiers" label="brain" />
        <div v-if="tier === 'remote'" class="hb-stack">
          <HbField label="endpoint url" for="char-remote-url" hint="an openai style server, such as http://localhost:11434/v1">
            <HbInput id="char-remote-url" v-model="remoteUrl" placeholder="http://localhost:11434/v1" autocomplete="off" />
          </HbField>
          <HbField label="model" for="char-remote-model"><HbInput id="char-remote-model" v-model="remoteModel" placeholder="llama3.2" autocomplete="off" /></HbField>
          <HbApiKey v-model="remoteKey" v-model:valid="keyOk" label="key, if the server asks for one" note="sent only to that url, kept in this tab for this visit, never saved." />
        </div>
      </template>
    </HbWakeGate>

    <div v-show="awake" class="is-full hb-acts">
      <HbPills :items="pills" :label="`${name}, subsystems`" />
      <HbTag v-if="twinOn && !twinEmpty" variant="outline" :title="whereLine(keep)">local only</HbTag>
      <HbButton variant="secondary" size="sm" :aria-pressed="voiceOn" :disabled="!speaker" @click="toggleVoice">{{ voiceOn ? 'voice on' : 'voice off' }}</HbButton>
      <HbButton variant="secondary" size="sm" :disabled="busy" @click="clear">clear</HbButton>
      <HbButton variant="secondary" size="sm" @click="newCharacter">new</HbButton>
      <HbButton variant="secondary" size="sm" @click="exportCard()">export</HbButton>
      <HbButton variant="secondary" size="sm" @click="exportCard('card')">card only</HbButton>
      <HbButton variant="secondary" size="sm" @click="pickFiles()">import</HbButton>
    </div>

    <div v-show="awake" class="hb-toolpage is-side">
      <template v-if="setupOpen">
        <HbReasons :rows="setupRows" :label="`${name}, setup`" @edit="setupEdit">
          <template #edit="{ row }">
            <HbButton v-if="row.key === 'brain' && brainState && !brainState.ready" variant="secondary" size="sm" @click="hub.load(brainState.r.id)">download {{ mb(brainState.r) }}</HbButton>
            <HbButton v-else variant="ghost" size="sm" @click="setupEdit(row.key ?? row.label)">edit</HbButton>
          </template>
        </HbReasons>
        <div class="hb-acts"><HbButton size="sm" @click="setupOpen = false">done</HbButton></div>
      </template>
      <HbChat
        v-else
        v-model:draft="draft"
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
        <template #composer-start>
          <HbMicButton v-model:state="micState" :level="micLevel" :hold="!handsFree" :speaking="speaking" note @start="micStart" @stop="micStop" />
        </template>
        <template #above>
          <HbToggleRow v-model="handsFree" label="hands free" :description="handsFree ? 'a pause sends. the mic ignores the voice.' : 'off: hold the mic to talk.'" />
        </template>
      </HbChat>

      <HbTabs v-model="sheetTab" :tabs="SHEET" label="character sheet" id-prefix="char-sheet" overflow="scroll">
        <template #default="{ value }">
          <div v-if="value === 'persona'" class="hb-stack">
            <HbPersonaEditor
              v-model="persona"
              :presets="presets"
              :cost="promptTokens"
              @save-preset="(p) => { presets = [...presets, p]; keepPresets() }"
              @remove-preset="(i) => { presets = presets.filter((_, j) => j !== i); keepPresets() }"
              @export="() => exportCard()"
            />
            <HbField label="who is it talking to"><HbSeg v-model="register" :options="REGISTERS" /></HbField>
            <HbField label="reply length"><HbSeg v-model="length" :options="LENGTHS" /></HbField>
          </div>
          <div v-else-if="value === 'voice'" class="hb-stack">
            <HbSlider v-model="rate" label="rate" :min="0.5" :max="2" :step="0.05" :format="(v) => `${v.toFixed(2)}x`" :disabled="!speaker" />
            <HbSlider v-model="pitch" label="pitch" :min="0.5" :max="1.5" :step="0.05" :format="(v) => v.toFixed(2)" :disabled="!speaker" />
            <p class="hb-hint">{{ speaker ? 'saved with the character. the next sentence uses it.' : 'no voice: wake with the voice on to change it.' }}</p>
          </div>
          <div v-else-if="value === 'brain'" class="hb-stack">
            <HbTierCards v-model="tier" :tiers="tiers" label="brain" start start-label="use this brain" :can-start="canStart" @start="swapBrain" />
            <div v-if="tier === 'remote'" class="hb-stack">
              <HbField label="endpoint url" for="char-sheet-url"><HbInput id="char-sheet-url" v-model="remoteUrl" placeholder="http://localhost:11434/v1" autocomplete="off" /></HbField>
              <HbField label="model" for="char-sheet-model"><HbInput id="char-sheet-model" v-model="remoteModel" placeholder="llama3.2" autocomplete="off" /></HbField>
              <HbApiKey v-model="remoteKey" v-model:valid="keyOk" label="key, if the server asks for one" note="sent only to that url, kept in this tab for this visit, never saved." />
            </div>
            <p class="hb-hint">prompt cost: about {{ promptTokens }} tokens (inferred, four characters a token).</p>
            <HbFold summary="what the model is told"><pre class="hb-code">{{ systemOf(card) }}</pre></HbFold>
          </div>
          <div v-else-if="value === 'memory'" class="hb-stack">
            <HbToggleRow v-model="memOnModel" label="recall into each prompt" description="notes from the memory tool join the prompt." />
            <p class="hb-hint">{{ memOn ? `the last prompt carried ${lastTurn?.recalled ?? 0} notes. the notes live in the memory tool.` : 'memory is off: nothing is recalled.' }}</p>
          </div>
          <div v-else-if="value === 'moves'" class="hb-stack">
            <div class="hb-acts">
              <HbButton variant="secondary" size="sm" @click="camera('full')">full body</HbButton>
              <HbButton variant="secondary" size="sm" @click="camera('closer')">closer</HbButton>
              <HbButton variant="secondary" size="sm" @click="camera('further')">further</HbButton>
            </div>
            <p class="hb-hint">{{ clips.length ? `clips: ${clips.join(', ')}` : 'the mannequin has no clips. drop a glb or vrm with animations on the stage.' }}</p>
          </div>
          <div v-else-if="value === 'look'" class="hb-stack">
            <HbField label="background"><HbSeg v-model="background" :options="['studio', 'none']" /></HbField>
            <HbToggleRow v-for="b in behaviours" :key="b.k" v-model="b.model.value" :label="b.k" />
            <p class="hb-hint">saved with the character. a vrm body reads them; the mannequin has no eyes to aim.</p>
          </div>
          <div v-else class="hb-instrument hb-stack">
            <HbPromptInspector
              :prompt="lastTurn?.prompt ?? []"
              :reply="lastTurn?.reply ?? ''"
              :plan="lastTurn?.plan"
              :cost="lastTurn ? { in: lastTurn.in, out: lastTurn.out, ms: lastTurn.ms } : {}"
              :counters="counters"
            />
            <HbStepCard
              v-for="t in [...turns].reverse()"
              :key="t.n"
              :n="t.n"
              :title="t.plan.do.length ? t.plan.do.join(', ') : 'say'"
              :text="t.plan.say.join(' / ')"
              :thought="`${t.recalled} notes recalled, ${t.in} tokens in (inferred)`"
              :result="t.state === 'fail' ? `the call failed: ${t.why || 'the engine gave no reason'}` : `${t.plan.say.length} boxes, ${t.out} tokens out`"
              :ms="t.ms"
              :state="t.state"
              :clip="160"
            />
            <p class="hb-hint">tools the model sees: none. this character only talks; the room adds body tools.</p>
          </div>
        </template>
      </HbTabs>

      <HbHow v-bind="how" persist-key="character-how" />
    </div>

    <HbContextMenu v-show="awake" v-model:open="menuOpen" :title="menuTitle" :items="menuItems" label="right click or long press the stage for things to say" @request="menuTitle = `say to ${name}`" @pick="menuPick">
      <HbViewport look="lit" aspect="4/3" :label="`${name} on the stage`" :cover-title="stageCover || undefined" :cover-error="!!stageCover">
        <div ref="host" class="hb-viewport-host" />
        <template #tl><HbNameHud :name="name" :state="hud" :state-text="voiceOn ? '' : hud === 'idle' ? 'no voice' : ''" /></template>
        <template #caption>
          <HbStageCaption :echo="lastUser ? `you: ${lastUser.text}` : ''" :line="lastReply?.text ?? ''" :who="name" :max-chars="160" />
        </template>
      </HbViewport>
    </HbContextMenu>
  </div>
</template>
