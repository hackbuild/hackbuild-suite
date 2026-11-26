<script setup lang="ts">
// room (rebuild plan 4; originals arbor, mortise, vision-humanoid-room): a
// gate with presets over the live room, then the stage and a rack. A body in
// a workshop room sees through its own eyes (colour, depth, a detector), keeps
// a map from what it saw, remembers, and acts on orders with an agent: rules
// with no model, or a chat model loaded in this tab deciding in forced json.
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import { MeshDepthMaterial, WebGLRenderer } from 'three'
import { probe, type Env } from '@hackbuild/ai-env'
import type { AgentEvent, Agent, Perception } from '@hackbuild/agent'
import type { ChatEngine } from '@hackbuild/chat'
import { canClone, jobLoader, jobRecords, speaker, useJobsPick, type AskFn, type DepthFn, type DetectFn, type Job, type JobsPick, type Loader, type PickPreset } from '@hackbuild/ai-views'
import { MemoryPane, ModelJobs, SourcesDrop, VoiceClone } from '@hackbuild/ai-views/vue'
import type { MemoryPaneHandle } from '@hackbuild/ai-views/elements'
import { DrivesBars, EyeInset, MapInset, PlanLog, StepLog } from '@hackbuild/agents-views/vue'
import { drivesBarsState, planBook, type DrivesBarsState, type EyeWho, type MapState, type PlanLogState } from '@hackbuild/agents-views'
import { load as loadDrives } from '@hackbuild/drives'
import { hashedEmbedder, loadCore, open, type Embedder, type Memory } from '@hackbuild/memory'
import type { Engine } from '@hackbuild/speak'
import { MEMORY_WASM_BASE64 } from '@hackbuild/memory/inline'
import { characterStage, type CharacterStageHandle, type Speech, type Verb } from '@hackbuild/motion-views/vanilla'
import { AvatarDrop } from '@hackbuild/motion-views/vue'
import { HbMicButton, HbRack, HbRackLog, HbSelect, HbSlider, HbToggleRow, type HbLogLine } from '@virgilvox/hackbuild-ui'
import { chipPick } from '../../shell/chip'
import { cloneOwnVoice, HUMAN_CLIPS, HUMAN_GLB } from '../../shell/dog'
import { World, HALF } from './world'
import { ACT_ORDER, MODES, MUTTER_EVERY, ORDERS, REFLECT_GAP, REFLECT_PLANS, SOUL, freeRun, goalLine, makeGoals, mind, mutter, reflect, type Act, type Mode, type MindOptions } from './mind'

const STUB = new URLSearchParams(location.search).has('stub')
const hooks: { env?: Env; loaderFor?: (job: Job) => Loader } = {}
const TABS = [{ id: 'talk', label: 'talk' }, { id: 'mind', label: 'mind' }, { id: 'eyes', label: 'eyes' }, { id: 'memory', label: 'memory' }, { id: 'setup', label: 'setup' }]
const JOBS: Job[] = ['chat', 'vision', 'detect', 'depth', 'voice', 'embed']

// presets as mortise had them, by catalogue id; an id the catalogue lacks is left out
const PRESETS: PickPreset[] = [
  { id: 'feather', label: 'feather', picks: { chat: 'smollm2-360m-instruct', vision: 'smolvlm-256m-instruct', voice: 'web-speech', embed: 'potion-base-8m' } },
  { id: 'standard', label: 'standard', picks: { chat: 'qwen3-0.6b', vision: 'smolvlm-256m-instruct', detect: 'yolov10n', depth: 'depth-anything-v2-small', voice: 'bellows-voice', embed: 'potion-base-8m' } },
  { id: 'heavy', label: 'heavy', picks: { chat: 'qwen3-1.7b-mlc', vision: 'smolvlm-500m-instruct', detect: 'yolov10m', depth: 'depth-anything-v2-small', voice: 'pocket-tts', embed: 'minilm-l6' } },
].map((p) => ({ ...p, picks: Object.fromEntries(Object.entries(p.picks).filter(([job, id]) => jobRecords(job as Job).some((r) => r.id === id))) }))

// --- state
const stageEl = ref<HTMLElement | null>(null)
const stage = shallowRef<CharacterStageHandle | null>(null)
const jobs = shallowRef<JobsPick | null>(null)
const tick = ref(0)
const awake = ref(false)
const waking = ref(false)
const preset = ref('feather')
const gateNote = ref('')
const log = ref<HbLogLine[]>([])
const book = planBook()
const plan = shallowRef<PlanLogState>(book.state())
const mutters = ref(true)
const speakingNow = ref(false)
const order = ref('')
const busy = ref(false)
const free = ref(false)
const follow = ref(false)
const mapOn = ref(false)
const grippers = ref(true)
const drivesState = shallowRef<DrivesBarsState | null>(null)
const lastPrompt = ref('')
const cost = ref('')
const inView = ref<string[]>([])
const earlier = ref<string[]>([])
const eyeWho = ref('colour')
const settings = reactive({ mode: 'reflex' as Mode, budget: 4096, steps: 6, cache: true, soul: '', depthFrom: 'scene', feed: 'clear', captions: false, every: 20, prompt: 'describe what is in front of you in one sentence.' })
const say = (kind: 'eye' | 'body' | 'note' | 'heard' | 'said', line: string, level: HbLogLine['level'] = 'info') => (log.value = [...log.value.slice(-200), { t: Date.now(), line: `${kind}: ${line}`, level }])
const canCloneNow = computed(() => (void tick.value, canClone(jobs.value?.picks.get('voice')?.snapshot().loaded)))
const loaded = <T,>(job: Job) => jobs.value?.picks.get(job)?.snapshot().loaded as T | undefined

// --- the world and the body
const world = new World({
  log: (k, l) => say(k, l),
  say: async (text) => (say('said', text), await voice.say(text)),
  gesture: (g) => stage.value?.gesture(g),
})
const voice = speaker(() => loaded<Engine>('voice') ?? null, {
  play: async (line) => {
    const s = stage.value
    if (!s) return
    speakingNow.value = true
    try { await s.say(line as Speech) } finally { speakingNow.value = false }
  },
  halt: () => stage.value?.stop(),
})
const bodyName = ref('mannequin')
const bodyLoaded = ref(false)
let head = 1.6

// --- memory
let mem: Memory | null = null
const memRef = shallowRef<Memory | null>(null)
const count = ref(0)
const memNote = ref('')
const memLine = ref('')
const KINDS: Record<string, string> = { episode: 'episodes', gist: 'gists', fact: 'facts', rule: 'rules', lesson: 'lessons', doc: 'imported', lore: 'background' }
const ACTS = [{ id: 'consolidate', label: 'consolidate' }]
const core = loadCore({ base64: MEMORY_WASM_BASE64 })
const openMem = (embed: Embedder) => core.then((c) => open('room', { core: c, embed })).then((m) => ((mem = m), (memRef.value = m), (count.value = m.all().length)))
const memReady = openMem(hashedEmbedder())
const pane = shallowRef<MemoryPaneHandle | null>(null)
const onPane = (h: MemoryPaneHandle) => (pane.value = h)
const memChanged = () => (count.value = mem?.all().length ?? 0)
const memWrote = () => (memChanged(), pane.value?.refresh())
const memory = {
  recall: async (q: string) => (await memReady, mem ? (await mem.recall(q, { k: 4 })).hits.map((h) => h.item.text) : []),
  write: async (kind: 'episode' | 'lesson' | 'gist', text: string) => { await memReady; await mem?.add(text, { kind }); memWrote() },
}
async function memAdd() {
  await memReady
  const t = memNote.value.trim()
  if (!mem || !t) return
  await mem.add(t.replace(/^rule:\s*/i, ''), { kind: /^rule:/i.test(t) ? 'rule' : 'fact' })
  memNote.value = ''
  memWrote()
}
async function memAct(id: string) {
  if (id !== 'consolidate' || !mem) return
  const r = await mem.compact()
  memWrote()
  memLine.value = r ? `consolidated: ${JSON.stringify(r).slice(0, 80)}` : ''
}
const readIn = async (files: File[], o: { onFile: (e: { name: string; chunks: number; note?: string }) => void }) => {
  await memReady
  if (!mem) return { files: 0, chunks: 0 }
  const { ingest } = await import('@hackbuild/memory/ingest')
  const r = await ingest(mem, files, { onFile: o.onFile })
  memWrote()
  return r
}

// --- eyes: an offscreen renderer draws what the body sees
let eyeGL: WebGLRenderer | null = null
const depthMat = new MeshDepthMaterial()
let depthCache: { at: number; img: ImageData | null } = { at: 0, img: null }
let detectCache: { at: number; boxes: { label: string; x: number; y: number; w: number; h: number }[] } = { at: 0, boxes: [] }
let caption = ''
const EYES: EyeWho[] = [{ id: 'colour', label: 'colour', title: 'what he sees' }, { id: 'depth', label: 'depth', title: 'how far things are' }, { id: 'detector', label: 'detector', title: 'what he recognizes' }]
const eyeRef = ref<{ frame(): void } | null>(null)
const mapRef = ref<{ frame(): void } | null>(null)

function render(w: number, h: number, depth: boolean) {
  const s = stage.value
  if (!s) return null
  eyeGL ??= new WebGLRenderer({ antialias: false, preserveDrawingBuffer: true })
  eyeGL.setSize(w, h, false)
  world.eye.aspect = w / h
  world.eye.updateProjectionMatrix()
  world.mover.visible = false
  const scene = s.stage.scene
  const prev = scene.overrideMaterial
  if (depth) scene.overrideMaterial = depthMat
  eyeGL.render(scene, world.eye)
  scene.overrideMaterial = prev
  world.mover.visible = true
  return eyeGL.domElement
}
function drawEye(canvas: HTMLCanvasElement, who: EyeWho): string {
  const g = canvas.getContext('2d')
  if (!g) return ''
  const depthModel = settings.depthFrom === 'model' ? loaded<DepthFn>('depth') : undefined
  const src = render(canvas.width, canvas.height, who.id === 'depth' && !depthModel)
  if (!src) return ''
  g.drawImage(src, 0, 0, canvas.width, canvas.height)
  if (who.id === 'depth' && depthModel) {
    if (performance.now() - depthCache.at > 1500) {
      depthCache.at = performance.now()
      const frame = g.getImageData(0, 0, canvas.width, canvas.height)
      void depthModel(frame).then((d) => {
        const img = new ImageData(d.width, d.height)
        for (let i = 0; i < d.data.length; i++) img.data.set([d.data[i]! * 255, d.data[i]! * 255, d.data[i]! * 255, 255], i * 4)
        depthCache.img = img
      }).catch(() => undefined)
    }
    if (depthCache.img) createImageBitmap(depthCache.img).then((b) => g.drawImage(b, 0, 0, canvas.width, canvas.height))
    return 'depth anything'
  }
  if (who.id === 'detector') {
    const model = loaded<DetectFn>('detect')
    if (model && performance.now() - detectCache.at > 1000) {
      detectCache.at = performance.now()
      void model(canvas).then((b) => (detectCache.boxes = b.map((x) => ({ label: x.label ?? 'thing', x: x.x, y: x.y, w: x.w, h: x.h })))).catch(() => undefined)
    }
    const boxes = model ? detectCache.boxes : world.boxes(canvas.width, canvas.height)
    g.strokeStyle = '#fe0386'
    g.fillStyle = '#fe0386'
    g.lineWidth = 2
    g.font = '11px "IBM Plex Mono", monospace'
    for (const b of boxes) (g.strokeRect(b.x, b.y, b.w, b.h), g.fillText(b.label, b.x + 2, Math.max(10, b.y - 2)))
    return model ? 'detector model' : 'scene labels'
  }
  return who.id === 'depth' ? 'depth from the scene' : 'colour'
}
const mapState = (): MapState => ({ cols: 30, rows: 30, cells: world.map, half: HALF, trail: world.trail, at: world.at })

// --- perception
let depthText = ''
let selfNote = ''
function perceive(): Perception<World> {
  const seen = world.seen()
  const scene = stage.value?.stage.scene
  if (scene) {
    if (settings.feed === 'clear') {
      const d = world.depth(3, 1, scene)
      depthText = `clear ahead: left ${d[0]!.toFixed(1)} m, centre ${d[1]!.toFixed(1)} m, right ${d[2]!.toFixed(1)} m`
    } else {
      const d = world.depth(8, 5, scene)
      depthText = Array.from({ length: 5 }, (_, r) => Array.from(d.slice(r * 8, r * 8 + 8)).map((v) => v.toFixed(1)).join(' ')).join('\n')
    }
  }
  const seenIds = new Set(seen.map((s) => s.id))
  const before = [...world.beliefs.entries()].filter(([id]) => !seenIds.has(id))
  inView.value = seen.map((s) => `${s.name}, ${s.dist.toFixed(1)} m, ${s.bearing > 0 ? 'right' : s.bearing < 0 ? 'left' : 'ahead'} ${Math.abs(s.bearing)} deg`)
  earlier.value = before.map(([id, b]) => `${id}${b.on ? ` on the ${b.on}` : ''}, ${Math.round((Date.now() - b.at) / 1000)} s ago`)
  return {
    sections: [
      { name: 'I SEE NOW', priority: 8, text: seen.map((s) => `${s.name} ${s.dist.toFixed(1)} m at ${s.bearing} deg`).join('\n') || 'nothing' },
      { name: 'DEPTH', priority: 7, text: depthText },
      { name: 'I SAW EARLIER', priority: 6, text: earlier.value.join('\n') },
      ...(caption ? [{ name: 'MY EYES SAY', priority: 5, text: caption }] : []),
      ...(selfNote ? [{ name: 'MY ATTENTION', priority: 4, text: selfNote }] : []),
    ],
    fixed: [`HANDS: ${world.held ? `holding the ${world.held.name}` : 'empty'}`],
    state: world,
  }
}

// --- the mind
let agent: Agent<World> | null = null
let saying = ''
const goalBook = makeGoals(world)
const options = (): MindOptions => ({
    world,
    goals: goalBook,
    brain: () => loaded<ChatEngine>('chat') ?? null,
    memory,
    mode: settings.mode,
    budgetTokens: Math.round(settings.budget / 4),
    steps: settings.steps,
    cache: settings.cache,
    soul: settings.soul.trim() ? `${SOUL}\n${settings.soul.trim()}` : SOUL,
    perceive,
    onEvent: onAgent,
    onSay: (text, final) => {
      saying += text
      if (final && saying.trim()) (say('said', saying.trim()), void voice.say(saying.trim()), (saying = ''))
    },
  })
const build = () => (agent = mind(options()))
function onAgent(e: AgentEvent) {
  if (book.push(e)) {
    plan.value = book.state()
    if (e.type === 'plan') void maybeReflect()
  } else if (e.type === 'goal') say('note', `goal ${goalLine(e.goal)}`)
  else if (e.type === 'end' && agent) {
    const c = agent.cost
    cost.value = `${c.modelCalls} model calls, ${c.reflexHits} rule hits, ${c.cacheHits} reused plans, last prompt ${c.lastPromptTokens} tokens, last reply ${c.lastReplyMs} ms`
    lastPrompt.value = agent.system().slice(0, 1200)
  }
}
async function run(text: string, why: 'heard' | 'free' = 'heard', once = false) {
  if (!text.trim() || !agent) return
  if (why === 'heard') say('heard', text)
  busy.value = true
  try {
    // step once: the same mind with one model call per order
    const a = once ? mind({ ...options(), steps: 1 }) : agent
    const r = await a.handle(text.trim().toLowerCase(), 'heard')
    if (r.ended === 'no-brain' && !r.results.length) say('note', 'no rule fits that, and no brain is loaded. load one in setup, or try an order below.', 'warn')
  } catch (err) {
    say('note', err instanceof Error ? err.message : String(err), 'warn')
  } finally {
    busy.value = false
    book.setGoals(goalBook.list().filter((g) => g.status === 'active' || Date.now() - g.updated < 60000).map(goalLine))
    plan.value = book.state()
  }
}
function send() {
  const t = order.value
  order.value = ''
  void run(t)
}
function stopAll() {
  agent?.cancel()
  world.stop()
  voice.stop()
  free.value = false
  busy.value = false
}

// --- mutters and reflections: only with a brain, and never over an order
let mutterAt = 0
let plans = 0
let reflectAt = 0
let thinking = false
const recent = () => log.value.slice(-5).map((l) => l.line).join(' / ')
async function maybeMutter(t: number) {
  const b = loaded<ChatEngine>('chat')
  if (!b || !mutters.value || busy.value || thinking || t - mutterAt < MUTTER_EVERY * 1000) return
  mutterAt = t
  thinking = true
  try {
    const line = await mutter(b, settings.soul, `holding ${world.held?.name ?? 'nothing'}. just now: ${log.value.at(-1)?.line ?? 'nothing'}.`)
    if (!line) return
    book.think('mutter', line)
    plan.value = book.state()
    // now and then he says it, under his breath (mortise: about one in six)
    if (!speakingNow.value && Math.random() < 0.16) void voice.say(line)
  } catch { /* a mutter that fails is dropped */ } finally { thinking = false }
}
async function maybeReflect() {
  const b = loaded<ChatEngine>('chat')
  if (!b || ++plans % REFLECT_PLANS || performance.now() - reflectAt < REFLECT_GAP * 1000) return
  reflectAt = performance.now()
  try {
    const line = await reflect(b, `${goalBook.list().map(goalLine).join('; ') || 'no goal'}. recent: ${recent()}`)
    if (!line) return
    selfNote = line
    book.think('reflection', line)
    plan.value = book.state()
    await memory.write('gist', line)
  } catch { /* dropped */ }
}

// --- free run with drives
let drivesLoop: ReturnType<typeof freeRun> | null = null
let freeTimer = 0
watch(free, async (on) => {
  clearInterval(freeTimer)
  if (!on) return
  await loadDrives()
  drivesLoop ??= freeRun()
  freeTimer = window.setInterval(() => {
    const r = drivesLoop!.tick(1)
    drivesState.value = drivesBarsState(r.decision, drivesLoop!.drives, { now: r.now, seconds: r.seconds })
    if (!busy.value && !world.busy) {
      const act = r.decision.current as Act
      say('note', `${act}: ${r.decision.why}`)
      void run(ACT_ORDER[act], 'free').then(() => drivesLoop?.done(act))
    }
  }, 1000)
})

// --- captions on a timer
let captionAt = 0
async function glance() {
  const ask = loaded<AskFn>('vision')
  const src = render(320, 160, false)
  if (!ask || !src) return say('eye', 'no eyes model loaded. pick one in setup.', 'warn')
  try {
    caption = await ask(src, settings.prompt)
    say('eye', caption)
  } catch (err) {
    say('eye', err instanceof Error ? err.message : String(err), 'warn')
  }
}

// --- the stage verbs
const VERBS = computed<Verb[]>(() => [
  { id: 'follow', label: follow.value ? 'free camera' : 'follow' },
  { id: 'map', label: mapOn.value ? 'hide map' : 'map' },
  { id: 'grippers', label: grippers.value ? 'hide grippers' : 'grippers' },
  { id: 'free', label: free.value ? 'prompted' : 'free run' },
  ...(busy.value || free.value ? [{ id: 'stop', label: 'stop' }] : []),
])
watch(VERBS, (v) => { if (awake.value) stage.value?.setVerbs(v) })

// --- gate
const presetOptions = computed(() => {
  void tick.value
  const totals = new Map((jobs.value?.presets() ?? []).map((p) => [p.id, p.total]))
  return [...PRESETS.map((p) => ({ value: p.id, label: `${p.label}, ${totals.get(p.id) ?? ''}`.replace(/, $/, '') })), { value: 'rules', label: 'rules only, no download' }]
})
const goLabel = computed(() => {
  void tick.value
  if (waking.value) return 'waking...'
  if (preset.value === 'rules') return 'wake him up'
  const t = jobs.value?.presets().find((p) => p.id === preset.value)?.total
  return t ? `wake him up, ${t}` : 'wake him up'
})
async function wake() {
  if (waking.value || !jobs.value) return
  waking.value = true
  gateNote.value = ''
  try {
    if (preset.value !== 'rules') {
      jobs.value.applyPreset(preset.value)
      await jobs.value.loadAll().catch((err: unknown) => say('note', `not everything loaded: ${err instanceof Error ? err.message : String(err)}. he wakes with what did.`, 'warn'))
      if (!STUB && canCloneNow.value) await cloneOwnVoice(voice)
    }
    await memReady
    build()
    awake.value = true
    stage.value?.setVerbs(VERBS.value)
    say('note', loaded('chat') ? 'awake. a brain is loaded; it decides in json.' : 'awake on rules. give an order, or load a brain in setup.')
  } finally {
    waking.value = false
  }
}

// his own body by default, from the dog site; the mannequin offline or on ?stub
let ownTry = false
function wearOwn() {
  const s = stage.value
  if (!s || STUB) return
  ownTry = true
  void s.show(HUMAN_GLB).then((b) => { if (!b) s.showPlaceholder() }, () => s.showPlaceholder())
}
function heard(text: string) {
  if (text.trim()) void run(text)
}
function useBody(e: { files: readonly unknown[] }) {
  void stage.value?.show(e.files as never)
}
function newRoom() {
  world.build(Math.floor(Math.random() * 1e6) + 1)
  world.trail.length = 0
  say('note', 'a new room.')
}
function forgetRoom() {
  world.map.fill(0)
  world.beliefs.clear()
  world.trail.length = 0
  say('note', 'forgot this room: the map and what he saw.')
}

watch(() => settings.mode + settings.budget + settings.steps + settings.cache + settings.soul, () => { if (awake.value) build() })

let raf = 0
let last = 0
let perceiveAt = 0
const offs: Array<() => void> = []
onMounted(async () => {
  if (STUB) Object.assign(hooks, await import('./stubs').then((m) => ({ env: m.env, loaderFor: m.loaderFor })))
  const shared = hooks.env ? { env: hooks.env } : {}
  jobs.value = useJobsPick(JOBS.map((job) => ({ job, required: job === 'chat', options: { ...shared, loader: hooks.loaderFor?.(job) ?? jobLoader(job) } })), PRESETS, shared)
  offs.push(jobs.value.subscribe(() => tick.value++))
  chipPick.value = jobs.value.picks.get('chat') ?? null
  if (!hooks.env) void probe().then((env) => jobs.value?.update({ env }))
  offs.push(watch(() => tick.value, () => { if (awake.value && agent) build() }))

  const s = characterStage(stageEl.value!, { name: 'him', clips: HUMAN_CLIPS, verbs: [], framing: 'full', hello: 'hello.' })
  stage.value = s
  s.stage.scene.add(world.group)
  const place = () => {
    world.wear(s.body?.avatar.root ?? null)
    head = s.body?.avatar.humanoid?.headHeight ?? 1.6
    s.stage.setFollow(follow.value)
    s.stage.camera.position.set(4.2, 3.6, 5.6)
    s.stage.controls.target.set(0, 0.7, 0)
    s.stage.controls.update()
  }
  offs.push(s.on((e) => {
    if (e.type === 'loaded') {
      place()
      bodyName.value = e.placeholder ? (ownTry ? 'mannequin. his own body did not load here.' : 'mannequin') : ownTry ? 'his own body' : e.name
      bodyLoaded.value = !e.placeholder
      ownTry = false
    } else if (e.type === 'failed') {
      bodyName.value = ownTry ? 'mannequin. his own body did not load here.' : e.message
      ownTry = false
    }
    else if (e.type === 'verb') {
      if (e.id === 'follow') (follow.value = !follow.value, s.stage.setFollow(follow.value), follow.value || place())
      else if (e.id === 'map') mapOn.value = !mapOn.value
      else if (e.id === 'grippers') grippers.value = !grippers.value
      else if (e.id === 'free') free.value = !free.value
      else if (e.id === 'stop') stopAll()
    }
  }))
  place()
  wearOwn()
  const frame = (t: number) => {
    const dt = Math.min(0.1, (t - (last || t)) / 1000)
    last = t
    const mx = world.mover.position.x, mz = world.mover.position.z
    world.tick(dt, head)
    // his walk clip plays while the mover carries him, the idle when it stops
    if (dt > 0) s.move(Math.hypot(world.mover.position.x - mx, world.mover.position.z - mz) / dt)
    world.hands.visible = grippers.value
    s.stage.loop.invalidate()
    if (awake.value) {
      eyeRef.value?.frame()
      if (mapOn.value) mapRef.value?.frame()
      void maybeMutter(t)
      if (t - perceiveAt > 700) (perceiveAt = t, perceive())
      if (settings.captions && loaded('vision') && t - captionAt > settings.every * 1000) (captionAt = t, void glance())
    }
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  clearInterval(freeTimer)
  offs.forEach((f) => f())
  agent?.cancel()
  voice.stop()
  eyeGL?.dispose()
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
            <div class="hb-gate-head"><span>room</span><span>a room for a mind</span></div>
            <div class="hb-gate-body">
              <h2 class="hb-gate-name">room</h2>
              <p class="hb-gate-note">a body with eyes, two hands, a memory and a voice, dropped into a workshop. with a model loaded the model makes every decision. without one he runs on rules.</p>
              <label class="hb-field"><span class="hb-label">models</span><HbSelect v-model="preset" :options="presetOptions" /></label>
              <p v-if="gateNote" class="hb-note is-err" role="alert">{{ gateNote }}</p>
              <div class="hb-gate-acts">
                <button type="button" class="hb-btn hb-btn-go hb-btn-lg hb-gate-go" :aria-busy="waking || undefined" @click="wake">{{ goLabel }}</button>
              </div>
            </div>
          </section>
        </div>
      </Teleport>
      <Teleport v-if="stage && awake" :to="stage.inset">
        <EyeInset ref="eyeRef" v-model:selected="eyeWho" :who="EYES" :draw="drawEye" :width="320" :height="160" />
        <MapInset v-if="mapOn" ref="mapRef" :map="mapState" :size="160" />
      </Teleport>

      <HbRack v-if="awake" :tabs="TABS" label="room">
        <template #talk>
          <div class="sx-x-talk">
            <HbRackLog class="sx-x-log" :lines="log" empty="nothing yet. give him an order." label="what happened" />
            <p class="sx-x-row"><button v-for="o in ORDERS" :key="o" type="button" class="hb-btn hb-btn-sm" @click="run(o)">{{ o }}</button></p>
            <form class="sx-x-compose" @submit.prevent="send">
              <input v-model="order" class="hb-input" type="text" placeholder="say something or give an order" aria-label="order">
              <button type="submit" class="hb-btn hb-btn-go">send</button>
              <HbMicButton listen :speaking="speakingNow" @final="heard" />
            </form>
          </div>
        </template>
        <template #mind>
          <section class="sx-x-pad">
            <DrivesBars v-if="drivesState" :state="drivesState" />
            <p v-else class="hb-note">drives move in free run. press free run on the stage.</p>
            <PlanLog :state="plan" :steps="false" />
            <h3 class="hb-panel-hd">steps</h3>
            <StepLog :steps="plan.steps" />
            <HbToggleRow v-model="mutters" label="mutters" description="thoughts of his own between orders, with a brain loaded" />
            <label class="hb-field"><span class="hb-label">who decides</span><HbSelect v-model="settings.mode" :options="MODES" /></label>
            <HbSlider v-model="settings.steps" label="max steps per order" :min="1" :max="14" :step="1" />
            <HbSlider v-model="settings.budget" label="context" :min="2048" :max="12288" :step="1024" unit=" tokens" />
            <HbToggleRow v-model="settings.cache" label="reuse plans" description="an order heard before runs its old plan" />
            <label class="hb-field"><span class="hb-label">extra soul</span><textarea v-model="settings.soul" class="hb-input" rows="2" placeholder="a line about who he is" /></label>
            <p class="sx-x-row"><button v-if="order.trim() || log.length" type="button" class="hb-btn" @click="run(order || 'look around', 'heard', true)">step once</button></p>
          </section>
        </template>
        <template #eyes>
          <section class="sx-x-pad">
            <h3 class="hb-panel-hd">in view</h3>
            <ul v-if="inView.length" class="hb-list"><li v-for="l in inView" :key="l">{{ l }}</li></ul>
            <p v-else class="hb-note">nothing he knows is in front of him.</p>
            <h3 class="hb-panel-hd">seen earlier</h3>
            <ul v-if="earlier.length" class="hb-list"><li v-for="l in earlier" :key="l">{{ l }}</li></ul>
            <p v-else class="hb-note">nothing yet.</p>
            <label class="hb-field"><span class="hb-label">depth from</span><HbSelect v-model="settings.depthFrom" :options="[{ value: 'scene', label: 'the scene, no model' }, { value: 'model', label: 'the depth model' }]" /></label>
            <label class="hb-field"><span class="hb-label">depth goes to the mind as</span><HbSelect v-model="settings.feed" :options="[{ value: 'clear', label: 'three clearances' }, { value: 'grid', label: 'an 8 by 5 grid' }]" /></label>
            <HbToggleRow v-model="settings.captions" label="describe the scene on a timer" description="needs an eyes model" />
            <HbSlider v-if="settings.captions" v-model="settings.every" label="every" :min="5" :max="120" :step="5" unit=" s" />
            <label class="hb-field"><span class="hb-label">what the eyes are asked</span><textarea v-model="settings.prompt" class="hb-input" rows="2" /></label>
            <p class="sx-x-row"><button type="button" class="hb-btn" @click="glance">glance now</button></p>
          </section>
        </template>
        <template #memory>
          <section class="sx-x-pad">
            <p class="hb-note">{{ count }} memories. he writes an episode each turn, a lesson when something fails twice, and a gist when he reflects.</p>
            <MemoryPane v-if="memRef" :memory="memRef" name="his memory" by="kind" :kinds="KINDS" :acts="ACTS" export-label="bake into a file" @pane="onPane" @change="memChanged" @act="memAct" />
            <label class="hb-field"><span class="hb-label">teach him a rule</span><input v-model="memNote" class="hb-input" type="text" placeholder="rule: mugs live on the shelf" @keydown.enter="memAdd"></label>
            <p v-if="memNote.trim()" class="sx-x-row"><button type="button" class="hb-btn" @click="memAdd">add</button></p>
            <SourcesDrop :ingest="readIn" />
            <p v-if="memLine" class="hb-note">{{ memLine }}</p>
          </section>
        </template>
        <template #setup>
          <section class="sx-x-pad">
            <ModelJobs v-if="jobs" :jobs="jobs" :go="false" />
            <h3 class="hb-panel-hd">body</h3>
            <AvatarDrop :options="{ label: 'load a body file', hint: 'drop a vrm, glb, gltf or fbx' }" @use="useBody" />
            <p class="sx-x-row"><button v-if="bodyLoaded" type="button" class="hb-btn" @click="stage?.showPlaceholder()">back to the mannequin</button><button v-else-if="!STUB" type="button" class="hb-btn" @click="wearOwn">his own body</button></p>
            <p class="hb-note">{{ bodyName }}</p>
            <h3 class="hb-panel-hd">voice clone</h3>
            <VoiceClone :speaker="voice" :can="canCloneNow" />
            <h3 class="hb-panel-hd">room</h3>
            <p class="sx-x-row"><button type="button" class="hb-btn" @click="newRoom">new random room</button><button type="button" class="hb-btn" @click="forgetRoom">forget this room</button></p>
          </section>
        </template>
        <template #detail>
          <p class="hb-note">session cost: {{ cost || 'nothing run yet' }}</p>
          <details><summary>last system prompt</summary><pre class="sx-x-pre">{{ lastPrompt }}</pre></details>
          <p class="hb-note">clips for a dropped body and a remote endpoint as the brain come from the model list's own model form; walk clips are not in the libraries yet.</p>
        </template>
      </HbRack>
    </div>
  </div>
</template>

<style scoped>
.sx-x { height: calc(100svh - 52px); grid-template-rows: minmax(0, 1fr); }
.sx-x > .hb-lay-body { grid-row: 1; }
/* the doing chip in ink: the one pink in view is the action */
.sx-x :deep(.hb-stage-tag > span) { background: var(--hb-paper); color: var(--hb-ink); box-shadow: inset 0 0 0 1.5px var(--hb-ink); }
.sx-x-pad { display: grid; gap: var(--hb-s3); }
.sx-x-row { display: flex; flex-wrap: wrap; gap: var(--hb-s2); margin: 0; }
.sx-x-talk { display: flex; flex-direction: column; gap: var(--hb-s2); height: 100%; min-height: 0; }
.sx-x-log { flex: 1; min-height: 160px; }
.sx-x-compose { position: sticky; bottom: 0; display: flex; gap: var(--hb-s2); padding-top: var(--hb-s2); background: var(--hb-paper); }
.sx-x-compose .hb-input { flex: 1; min-width: 0; }
.sx-x-pre { white-space: pre-wrap; font-size: 11px; max-height: 200px; overflow: auto; }
@media (max-width: 900px) {
  .sx-x { height: auto; min-height: calc(100svh - 52px); }
}
</style>
