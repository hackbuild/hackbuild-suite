<script setup lang="ts">
// The room once awake (design 3.10 steps 2 to 9, F-2): the shared stage
// and toolbar of the agents tools with the seven rack tabs of the room
// original. Header items: the brain pill (jumps to the brain tab), the
// state, prompted or free run, stop, open rack. Stage: a click on a thing
// opens a menu that sends a sentence (P-ROOM-2), the speech bubble over the
// head clamped to the stage (P-STAGE-15), goal and thought in the hud
// (P-ROOM-4), the eye inset with its modes (P-ROOM-3), map and grippers
// toggles (P-STAGE-5) and the minimap (P-ROOM-5). Talk: the tagged line
// log with live rows and order chips (P-ROOM-1). Mind: state, goals, cost,
// drives, in view, seen earlier, the last plan, prompt and reply, with the
// fast and slow feeds apart (P-ROOM-6, P-TRACE-6, P-TRACE-9). Eyes: sense
// controls with the cost note, depth card, readout and captions
// (P-ROOM-15). Memory: the shared panel; "remember that ..." teaches.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from 'vue'
import {
  HbBubble, HbButton, HbCausalLog, HbChat, HbChip, HbChoiceBars, HbCodeBlock, HbEventLog, HbFold, HbGauges, HbHudStat, HbInset, HbKv, HbList,
  HbMemoryPanel, HbMicButton, HbNameHud, HbPanel, HbParamRow, HbPill, HbSeg, HbSelect, HbSparkRows, HbSwitch, HbTable, HbTabs,
  usePersisted, type HbCausalEvent, type HbChoiceOption, type HbEventRow, type HbGaugeRow, type HbMemoryEntry, type HbSparkRow, type HudState,
} from '@virgilvox/hackbuild-ui'
import { Vector2, Vector3 } from 'three'
import type { Rng } from '@hackbuild/organic'
import type { Memory } from '@hackbuild/memory'
import type { MicState } from '@virgilvox/hackbuild-ui/vanilla'
import StageTool from '../stagekit/StageTool.vue'
import { useStageTool } from '../stagekit/useStageTool'
import { tone } from '../vision/frame'
import { propDef, seededLayout } from '../agents/props.ts'
import { INSETS, FEEDS, bearingDeg, depthFeed, feedText, inViewLine, seenEarlierLine, type Feed, type InsetMode } from '../senses/kind.ts'
import type { SenseCore } from '../senses/core.ts'
import type { SenseRig } from '../senses/bind.ts'
import { rememberLine, toEntries, traceEntries, ADD_KINDS } from '../memory/lines.ts'
import * as hub from '../models/hub.ts'
import { BRAINS, BRAIN_NOTES, Mind } from './brain.ts'
import { DRIVES, FURNITURE, ROOM_THINGS, World, type LogKind } from './world.ts'
import * as room from './state.ts'

const TABS = ['talk', 'mind', 'eyes', 'memory', 'body', 'brain', 'voice']
const KINDS: LogKind[] = ['you', 'me', 'act', 'fail', 'eye', 'note', 'think']
const ORDERS = ['explore', 'mug to the shelf', 'tidy up', 'what are you doing', 'pick up the ball', 'put it on the table', 'bring me the box', 'what do you see', 'come here', 'remember that the mug lives on the shelf']
const EMPTY = 'the agent is waking. give it an order, or switch to free run.'
const failQ = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('fail') ?? '' : ''

const tool = useStageTool({
  id: 'room',
  empty: EMPTY,
  tunables: (reg) => {
    reg.define({ key: 'eye.fov', group: 'eyes', label: 'field of view', def: 74, min: 50, max: 110, step: 1, unit: 'deg', note: 'vertical; the fan on the floor shows the horizontal field.', source: 'vendor', cite: 'eye prototype 74' })
    reg.define({ key: 'eye.rate', group: 'eyes', label: 'sense rate', def: 3, min: 1, max: 10, step: 0.5, unit: '/s', note: 'sense passes a second; each pass renders the eye three times.', source: 'inferred' })
    reg.define({ key: 'eye.floor', group: 'eyes', label: 'detector floor', def: 4, min: 1, max: 40, step: 1, unit: 'px', note: 'a thing is seen only if it covers this many pixels of the 192 by 108 eye frame.', source: 'inferred' })
    reg.define({ key: 'run.every', group: 'brain', label: 'free run every', def: 6, min: 2, max: 30, step: 1, unit: 's', note: 'in free run, an own idea from the drives when the body is idle this long.', source: 'inferred' })
    reg.define({ key: 'walk.speed', group: 'body', label: 'drive speed', def: 1.2, min: 0.2, max: 3, step: 0.1, unit: 'm/s', note: 'manual drive with the pad or wasd, at full stick.', source: 'inferred' })
  },
  restart: (rng) => begin(rng),
  tick: (dt, t) => frame(dt, t),
  menu: (at) => menuAt(at),
  say: (s) => void send(s),
  hints: () => [
    { keys: 'wasd', label: 'drive' },
    { keys: 'space', label: 'pause' },
    { keys: '.', label: 'step' },
    { keys: 'right click', label: 'a thing for things to say' },
  ],
})

const tab = ref<string | number>('talk')
const run = ref<'prompted' | 'free run'>('prompted')
const stageMap = usePersisted('suite-room-map', false)
const grippers = usePersisted('suite-room-grippers', false)
const captions = usePersisted('suite-room-captions', true)
const speakOn = usePersisted('suite-room-speak', false)
const feed = usePersisted<Feed>('suite-room-feed', 'three clearances')
const insetMode = usePersisted<InsetMode>('suite-room-inset', 'what it sees')
const insetOpen = ref(true)
const depthSource = ref('own render')
const open = reactive({ state: true, drives: true, view: true, plan: true, prompt: false, fast: true, slow: true })

const world = shallowRef<World | null>(null)
const mind = shallowRef<Mind | null>(null)
const rig = shallowRef<SenseRig | null>(null)
const core = shallowRef<SenseCore | null>(null)
const inset = shallowRef<HTMLCanvasElement | null>(null)
const mini = shallowRef<HTMLCanvasElement | null>(null)
const mapCv = shallowRef<HTMLCanvasElement | null>(null)
let bind: typeof import('../senses/bind.ts') | null = null
let loaded: Promise<void> | null = null

const live = reactive({
  log: [] as HbCausalEvent[], slow: [] as HbEventRow[], view: [] as string[], earlier: [] as string[],
  gauges: [] as HbGaugeRow[], sparks: [] as HbSparkRow[], choice: [] as HbChoiceOption[], why: '',
  goal: '', think: '', doing: 'standing', hands: '', tier: '', cost: { model: 0, scripted: 0, reflex: 0, none: 0, tokens: 0, ms: 0 },
  last: { tier: '', prompt: '', reply: '', plan: '' }, clear: { left: 0, ahead: 0, right: 0 }, grid: [] as number[][], fed: '', tokens: 0,
  known: 0, edges: 0, tools: [] as string[], deciding: false,
})
const bubble = reactive({ text: '', show: false, x: 0, y: 0 })
const hud = ref<HudState>('idle')
let nextId = 1
let acc = 0
let idle = 0
let sparkAt = 0
const history: Record<string, number[]> = Object.fromEntries(DRIVES.map((d) => [d, [] as number[]]))
const seenBefore = new Set<string>()

const fov = computed(() => tool.values['eye.fov'] ?? 74)
const rate = computed(() => tool.values['eye.rate'] ?? 3)
const floor = computed(() => tool.values['eye.floor'] ?? 4)
const every = computed(() => tool.values['run.every'] ?? 6)

// ------------------------------------------------------------- log

function log(kind: LogKind, text: string, liveRow?: { id: number }): number {
  const t = tool.transport.time
  if (liveRow) {
    const row = live.log.find((e) => e.id === liveRow.id)
    if (row) {
      row.text = text
      return liveRow.id
    }
  }
  const id = nextId++
  live.log.push({ id, t, agent: room.name.value, kind, text })
  if (live.log.length > 160) live.log.splice(0, live.log.length - 160)
  if (kind === 'you' || kind === 'think' || kind === 'fail' || kind === 'note') {
    live.slow.push({ id, kind: kind === 'fail' ? 'fail' : kind === 'note' ? 'warn' : 'note', text, t: `${t.toFixed(1)} s` })
    if (live.slow.length > 80) live.slow.splice(0, live.slow.length - 80)
  }
  if (kind === 'think') live.think = text
  if (kind === 'act' || kind === 'fail') tool.body.line = text
  return id
}

function said(text: string) {
  log('me', text)
  bubble.text = text
  bubble.show = true
  tool.body.line = text
  hud.value = 'talking'
  if (speakOn.value && typeof speechSynthesis !== 'undefined') {
    const u = new SpeechSynthesisUtterance(text)
    u.onend = () => { hud.value = 'idle' }
    speechSynthesis.speak(u)
  } else setTimeout(() => { if (hud.value === 'talking') hud.value = 'idle' }, 1500 + text.length * 60)
}

// ------------------------------------------------------------- memory

const mem = shallowRef<Memory | null>(null)
const memItems = ref<HbMemoryEntry[]>([])
const memQuery = ref('')
const memKind = ref('')
const memFound = ref<HbMemoryEntry[] | null>(null)
async function memOpen(): Promise<Memory | null> {
  if (mem.value) return mem.value
  try {
    const { memory } = await import('../memory/store.ts')
    mem.value = await memory('room')
    await memRefresh()
  } catch (e) {
    log('fail', `memory did not open: ${e instanceof Error ? e.message : String(e)}.`)
  }
  return mem.value
}
async function memRefresh() {
  const m = mem.value
  if (m) memItems.value = toEntries(m.all(), m.core.lines)
}
async function memSearch(q: string) {
  const m = mem.value
  if (!m || !q.trim()) { memFound.value = null; return }
  memFound.value = traceEntries(await m.explain(q, { k: 6 }), m.all())
}
async function memAdd(e: { text: string; kind: string }) {
  const m = await memOpen()
  if (!m) return
  const r = await m.add(e.text, { kind: e.kind as 'fact', meta: { from: 'room' } })
  log('note', r.merged ? `strengthened a memory like: ${e.text}` : `kept in memory: ${e.text}`)
  await memRefresh()
}
async function memForget(id: string) {
  const m = mem.value
  if (!m) return
  await m.remove([Number(id)])
  log('note', 'forgot one memory.')
  await memRefresh()
}
async function memImport(file: File) {
  const m = await memOpen()
  if (!m) return
  try {
    const { readExport } = await import('../memory/kind.ts')
    const n = await m.import(readExport(await file.text(), file.name))
    log('note', `imported ${n} memories from ${file.name}.`)
    await memRefresh()
  } catch (e) {
    log('fail', e instanceof Error ? e.message : String(e))
  }
}
async function memConsolidate() {
  const m = mem.value
  if (!m) return
  const r = await m.consolidate()
  log('note', `consolidated memory: ${JSON.stringify(r)}.`.replace(/[{}"]/g, ''))
  await memRefresh()
}
async function recall(text: string): Promise<string[]> {
  const m = mem.value
  if (!m || !m.size) return []
  const r = await m.recall(text, { k: 3 })
  return r.hits.map((h) => h.item.text)
}

// ------------------------------------------------------------- run

function seen(): string[] {
  return live.view
}

/** A restart: the seeded room, a fresh body, mind and percept memory. */
function begin(rng: Rng) {
  void (async () => {
    if (!loaded) return
    await loaded
    const w = tool.walk.value
    if (!w || !bind) return
    mind.value?.stop()
    const layout = seededLayout(rng, ROOM_THINGS)
    const wd = new World(layout, rng, { log, said })
    world.value = wd
    mind.value = new Mind({
      world: wd,
      persona: () => `your name is ${room.name.value}. ${room.persona.value}`,
      model: () => (room.brain.value === 'reflex only' ? null : room.engine.value),
      loading: () => room.brain.value === 'in tab' && room.brainState.value === 'downloading',
      seen,
      recall,
      stub: hub.STUB ? { fail: failQ.split(',').includes('brain') } : null,
      wantsModel: () => room.brain.value !== 'reflex only',
      log,
    })
    live.tools = mind.value.registry.describe().split('\n').map((l) => l.replace(/^- /, ''))
    core.value?.dispose()
    core.value = new bind.SenseCore(rng, wd.things)
    if (!rig.value) {
      rig.value = new bind.SenseRig(w.stage.scene, w.stage.renderer, wd.things, rng, {
        cone: tone('--hb-pink') || '#e0457b', gaze: tone('--hb-pink') || '#e0457b', puff: tone('--hb-slime') || '#8f6',
      })
    } else rig.value.restart(wd.things, rng)
    w.place(0, 0, 0)
    Object.assign(live, { log: [], slow: [], view: [], earlier: [], goal: '', think: '' })
    seenBefore.clear()
    for (const d of DRIVES) history[d] = []
    acc = 1
    idle = 0
    log('note', `${room.name.value} is awake in a room of ${ROOM_THINGS.length} things, seed ${tool.seed.value}. ${BRAIN_NOTES[room.brain.value]}`)
    void memOpen()
  })()
}

/** Meshes follow the world: held things in the hands, things on furniture up top. */
function syncMeshes() {
  const r = rig.value
  const wd = world.value
  if (!r || !wd) return
  for (const t of wd.things) {
    const m = r.room.meshes.get(t.label)
    const d = propDef(t.label)
    if (!m || !d) continue
    const top = t.on ? (propDef(t.on)?.h ?? 0) : 0
    m.position.set(t.x, t.held ? 0.95 : top + d.h / 2, t.z)
    m.updateMatrixWorld(true)
  }
}

function frame(dt: number, t: number) {
  const r = rig.value
  const c = core.value
  const wd = world.value
  const md = mind.value
  const w = tool.walk.value
  const root = w?.stage.body?.avatar.root
  if (!r || !c || !wd || !md || !w || !root) return
  if (wd.busy) {
    wd.tick(dt)
    w.place(wd.pose.x, wd.pose.z, wd.pose.yaw)
  } else {
    wd.tick(dt)
    wd.pose.x = root.position.x
    wd.pose.z = root.position.z
    wd.pose.yaw = root.rotation.y
    wd.carry()
  }
  syncMeshes()
  r.pose(wd.pose, fov.value)
  placeBubble()
  // free run: an own idea from the drives once the body has idled long enough
  idle = wd.busy || md.running ? 0 : idle + dt
  if (run.value === 'free run' && idle >= every.value) {
    idle = 0
    const best = [...wd.scores()].sort((a, b) => b.score - a.score)[0]!
    log('think', `own idea: ${best.idea}. ${best.id} is highest at ${best.score.toFixed(2)}.`)
    void decide(md, best.idea)
  }
  sparkAt += dt
  if (sparkAt >= 0.5) {
    sparkAt = 0
    for (const d of DRIVES) {
      history[d]!.push(wd.drives[d])
      if (history[d]!.length > 120) history[d]!.shift()
    }
  }
  acc += dt
  if (acc < 1 / rate.value) return
  acc = 0
  const hide = [root, ...wd.things.filter((x) => x.held).map((x) => r.room.meshes.get(x.label)!).filter(Boolean)]
  const p = r.pass(wd.pose, fov.value, t, hide)
  c.sense(t, wd.pose, () => true, p.pixels, floor.value)
  if (p.fixation?.label) c.look(t, p.fixation.label)
  read(t)
}

/** The panes from the world, the mind and the senses after a pass. */
function read(t: number) {
  const c = core.value!
  const r = rig.value!
  const wd = world.value!
  const a = wd.pose
  const ex = a.x + Math.sin(a.yaw) * 0.1
  const ez = a.z + Math.cos(a.yaw) * 0.1
  const vis = c.percepts.filter((p) => p.visible && !wd.thing(p.label)?.held).sort((x, y) => x.dist - y.dist)
  live.view = vis.map((p) => { const th = wd.thing(p.label)!; return inViewLine(p.label, bearingDeg(th.x - ex, th.z - ez, a.yaw), p.dist) })
  live.earlier = c.seenEarlier(t).map((e) => seenEarlierLine(e.label, e.near, e.ago, e.confidence))
  const fresh = vis.map((p) => p.label).filter((l) => !seenBefore.has(l))
  if (fresh.length) {
    for (const l of fresh) seenBefore.add(l)
    if (captions.value) log('eye', `new things in view: ${fresh.join(', ')}`)
  }
  const last = r.last
  if (last) {
    const f = depthFeed(last.depth, last.dw, last.dh, fov.value)
    live.clear = { left: f.left, ahead: f.ahead, right: f.right }
    live.grid = f.grid
    const fed = feedText(feed.value, f, live.view)
    live.fed = feed.value === 'nothing' ? '' : fed.text
    live.tokens = feed.value === 'nothing' ? 0 : fed.tokens
  }
  readMind()
  void nextTick(() => {
    if (inset.value && insetOpen.value) r.drawInset(inset.value, insetMode.value, tone('--hb-pink') || '#e0457b')
    const tones = { unknown: tone('--hb-sunk') || '#ddd', free: tone('--hb-paper') || '#fff', wall: tone('--hb-ink') || '#111', me: tone('--hb-pink') || '#e0457b' }
    for (const cv of [stageMap.value ? mini.value : null, tab.value === 'mind' ? mapCv.value : null]) {
      if (!cv) continue
      const g = r.drawGrid(cv, a, tones)
      live.known = g.known
      live.edges = g.edges
    }
  })
}

function readMind() {
  const wd = world.value
  const md = mind.value
  if (!wd || !md) return
  live.doing = wd.doing
  live.hands = wd.handsLine()
  live.goal = md.goal
  live.tier = md.last.tier
  live.cost = { ...md.cost }
  live.last = { ...md.last }
  live.gauges = DRIVES.map((d) => ({ label: d, value: wd.drives[d] }))
  const sc = wd.scores()
  const top = [...sc].sort((x, y) => y.score - x.score)[0]!
  live.choice = sc.map((s) => ({ id: s.id, label: `${s.id}: ${s.idea}`, score: s.score, chosen: s.id === top.id }))
  live.why = `free run picks the highest drive: ${top.id}, ${top.idea}.`
  live.sparks = DRIVES.map((d) => ({ id: d, label: d, values: [...history[d]!], value: wd.drives[d] }))
}

// ------------------------------------------------------------- bubble

const head = new Vector3()
/** The bubble over the head, projected each frame and clamped inside the stage. */
function placeBubble() {
  const w = tool.walk.value
  const wd = world.value
  if (!w || !wd || !bubble.show) return
  const cv = w.stage.renderer.domElement
  const vp = (cv.closest('.hb-viewport') as HTMLElement | null) ?? cv
  const box = cv.getBoundingClientRect()
  const outer = vp.getBoundingClientRect()
  head.set(wd.pose.x, 1.95, wd.pose.z).project(w.stage.camera)
  const x = box.left - outer.left + ((head.x + 1) / 2) * box.width
  const y = box.top - outer.top + ((1 - head.y) / 2) * box.height
  const half = Math.min(150, outer.width / 2)
  bubble.x = Math.round(Math.max(half, Math.min(outer.width - half, x)))
  bubble.y = Math.round(Math.max(72, Math.min(outer.height - 8, y)))
}

// ------------------------------------------------------------- talk

async function send(text: string) {
  const s = text.trim()
  const md = mind.value
  if (!s || !md) return
  log('you', s)
  const line = rememberLine(s)
  if (line) {
    await memAdd({ text: line, kind: 'fact' })
    world.value?.say('i will remember that.')
    return
  }
  idle = 0
  await decide(md, s)
}

async function decide(md: Mind, text: string) {
  live.deciding = true
  try {
    await md.turn(text)
  } finally {
    live.deciding = md.running
    readMind()
  }
}

// the stage menu over a thing (P-ROOM-2): each entry is a sentence, sent as typed
function menuAt(at: { x: number; y: number }) {
  const w = tool.walk.value
  const r = rig.value
  const wd = world.value
  if (!w || !r || !wd) return null
  const box = w.stage.renderer.domElement.getBoundingClientRect()
  const hit = r.room.pick(new Vector2((at.x / box.width) * 2 - 1, -(at.y / box.height) * 2 + 1), w.stage.camera)
  if (!hit || !('label' in hit)) return null
  const l = hit.label
  const held = wd.heldThing()
  const items = (FURNITURE as readonly string[]).includes(l)
    ? [{ label: 'go there', say: `go to the ${l}` }, ...(held ? [{ label: `put the ${held} here`, say: `put it on the ${l}` }] : []), { label: 'look at it', say: `look at the ${l}` }]
    : [{ label: 'pick it up', say: `pick up the ${l}` }, { label: 'put it on the shelf', say: `put the ${l} on the shelf` }, { label: 'bring it to me', say: `bring me the ${l}` }, { label: 'where is it?', say: `where is the ${l}` }]
  return { title: l, items }
}

// ------------------------------------------------------------- mic

const mic = ref<MicState>('off')
const micLevel = ref(0)
let ears: { stop(): void } | null = null
async function micStart() {
  mic.value = 'asking'
  try {
    const [{ addTranscribeRuntimes }, { defaultTranscribeId }, { hubTranscriber }, { openEars }] = await Promise.all([
      import('../transcribe/runtimes.ts'), import('@hackbuild/transcribe'), import('@hackbuild/listen'), import('../character/ears.ts'),
    ])
    await addTranscribeRuntimes()
    const id = defaultTranscribeId(hub.env.value?.webgpu ?? false)
    await hub.load(id)
    const ctx = new AudioContext()
    void ctx.resume().catch(() => undefined)
    ears = await openEars(ctx, hubTranscriber(hub.hub(), { model: id }), {
      state: (s) => { mic.value = s },
      level: (v) => { micLevel.value = v },
      heard: (t) => void send(t),
      dropped: (why) => log('note', `the mic heard noise, not words: ${why}.`),
      failed: (m) => log('fail', `the mic stopped: ${m}.`),
    }, true)
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e)
    mic.value = /blocked/.test(m) ? 'blocked' : 'off'
    log('fail', m)
  }
}
function micStop() {
  ears?.stop()
  ears = null
  mic.value = 'off'
}

// ------------------------------------------------------------- header

function stop() {
  mind.value?.stop()
  run.value = 'prompted'
  log('note', 'stopped. the body stands still.')
  readMind()
}
const brainPill = computed(() => {
  const b = room.brain.value
  if (b === 'reflex only') return { text: 'reflex brain', status: 'ok' as const }
  if (b === 'your endpoint') return { text: room.engine.value ? 'your endpoint' : 'endpoint not set', status: room.engine.value ? ('ok' as const) : ('warn' as const) }
  const s = room.brainState.value
  return { text: s === 'loaded' ? 'brain in tab' : s === 'downloading' ? 'brain loading' : 'no brain loaded', status: s === 'loaded' ? ('ok' as const) : s === 'downloading' ? ('load' as const) : ('warn' as const) }
})
const statePill = computed(() => (live.deciding ? 'deciding' : live.doing))
async function loadBrain() {
  const id = room.brainId.value
  if (!id) return
  await hub.load(id)
}

// ------------------------------------------------------------- start

onMounted(async () => {
  loaded = (async () => {
    const m = await import('../senses/bind.ts')
    await m.ready()
    bind = m
  })()
  await loaded
  tool.restart()
})
onBeforeUnmount(() => {
  mind.value?.stop()
  micStop()
  rig.value?.dispose()
  core.value?.dispose()
  rig.value = null
  core.value = null
})

// for the smoke: the room handle on the stage host, no global
watch(rig, (r) => {
  const el = tool.host.value as (HTMLElement & { room?: unknown }) | null
  const w = tool.walk.value
  if (el && r && w && bind) {
    const sc = bind.screenOf
    el.room = { live, bubble, world: () => world.value, mind: () => mind.value, send, screenOf: (x: number, z: number) => sc(x, z, w.stage.camera, w.stage.renderer.domElement) }
  }
})

const gridRows = computed(() => live.grid.map((row, i) => ({ row: String(i + 1), ...Object.fromEntries(row.map((v, j) => [`c${j}`, v.toFixed(1)])) })))
const gridCols = [{ key: 'row', label: 'row' }, ...Array.from({ length: 8 }, (_, j) => ({ key: `c${j}`, label: String(j + 1), numeric: true }))]
const memShown = computed(() => (memFound.value ?? memItems.value).filter((e) => !memKind.value || e.kind === memKind.value))
const memKinds = computed(() => [...new Set([...ADD_KINDS, ...memItems.value.map((e) => e.kind)])])
const tierWord = computed(() => ({ model: 'the brain', scripted: 'the scripted planner', reflex: 'reflexes', none: 'nothing', '': 'no turn yet' })[live.tier] ?? live.tier)
const dropRows = computed<HbEventRow[]>(() => live.slow.filter((r) => r.kind === 'warn'))
</script>

<template>
  <StageTool :tool="tool" title="room">
    <template #tools>
      <HbButton variant="ghost" size="sm" :title="`who decides: ${room.brain.value}. open the brain tab`" data-pill="brain" @click="tab = 'brain'">
        <HbPill :status="brainPill.status">{{ brainPill.text }}</HbPill>
      </HbButton>
      <HbPill status="none" data-pill="state">{{ statePill }}</HbPill>
      <HbSeg v-model="run" :options="['prompted', 'free run']" label="who starts" />
      <HbButton variant="secondary" @click="stop">stop</HbButton>
    </template>
    <template #tools-end>
      <HbButton variant="secondary" @click="room.rackOpen.value = true">open rack</HbButton>
    </template>

    <template #tl><HbNameHud :name="room.name.value" :state="hud" /></template>
    <template #hud>
      <HbHudStat label="goal" :value="live.goal || 'none'" />
      <HbHudStat label="think" :value="live.think || 'nothing yet'" />
      <HbHudStat v-if="grippers" label="hands" :value="live.hands" />
    </template>
    <template #cams>
      <div class="hb-cams" role="group" aria-label="stage tools">
        <HbChip v-model="stageMap" toggle>map</HbChip>
        <HbChip v-model="grippers" toggle>grippers</HbChip>
      </div>
    </template>
    <template #over>
      <HbBubble v-model:show="bubble.show" :x="bubble.x" :y="bubble.y" :text="bubble.text" :lines="3" ttl="auto" :hold="hud === 'talking'" />
    </template>
    <template #br>
      <HbInset v-if="stageMap" title="map" aux="own depth" ratio="1 / 1"><canvas ref="mini" data-map="mini" /></HbInset>
    </template>
    <template #inset>
      <HbInset v-model:mode="insetMode" v-model:open="insetOpen" :modes="[...INSETS]" :title="insetMode === 'what it sees' ? 'eye' : insetMode" ratio="16 / 9" collapsible>
        <canvas ref="inset" data-inset="eye" />
      </HbInset>
    </template>

    <template #rack>
      <HbTabs v-model="tab" :tabs="TABS" label="rack" persist-key="suite-room-rack" overflow="collapse">
        <template #default="{ value }">
          <div v-if="value === 'talk'" class="hb-stack" data-pane="talk">
            <HbCausalLog :events="live.log" :kinds="KINDS" :limit="160" label="talk log" />
            <div class="hb-acts">
              <button v-for="o in ORDERS" :key="o" type="button" class="hb-chip" @click="send(o)">{{ o }}</button>
            </div>
            <HbChat :lines="[]" :log="false" :placeholder="`tell ${room.name.value} what to do`" label="talk to the agent" @send="send">
              <template #composer-start>
                <HbMicButton v-model:state="mic" :level="micLevel" :listen="false" @start="micStart" @stop="micStop" />
              </template>
            </HbChat>
            <p v-if="mic === 'blocked'" class="hb-hint">the mic is blocked. type instead, or allow it in the address bar.</p>
          </div>

          <div v-else-if="value === 'mind'" class="hb-stack hb-instrument" data-pane="mind">
            <HbFold v-model="open.state" summary="state" persist-key="room-mind-state">
              <HbKv label="doing" :value="live.doing" />
              <HbKv label="goal" :value="live.goal || 'none, kept until done'" />
              <HbKv label="hands" :value="live.hands" />
              <HbKv label="last turn by" :value="tierWord" />
              <HbInset title="map" aux="own depth" ratio="1 / 1"><canvas ref="mapCv" data-map="mind" /></HbInset>
              <HbKv label="floor known" :value="`${live.known.toFixed(1)} square meters (computed), ${live.edges} unexplored edges, room ${tool.seed.value}`" />
            </HbFold>
            <HbFold v-model="open.drives" summary="drives and cost" persist-key="room-mind-drives">
              <HbGauges :rows="live.gauges" :max="1" label="drives" />
              <HbSparkRows :rows="live.sparks" label="drives over time" :min="0" :max="1" :window="60" :digits="2" />
              <HbChoiceBars :options="live.choice" sort="none" :why="live.why" label="own idea scores" :digits="2" />
              <HbKv label="model turns" :value="live.cost.model" />
              <HbKv label="scripted turns" :value="live.cost.scripted" />
              <HbKv label="reflex turns" :value="live.cost.reflex" />
              <HbKv label="prompt and reply" :value="`${live.cost.tokens} tokens this session (inferred, 4 characters a token)`" />
              <HbKv label="last turn" :value="`${live.cost.ms} ms (measured)`" />
            </HbFold>
            <HbFold v-model="open.view" summary="in view and seen earlier" persist-key="room-mind-view">
              <HbList>
                <div v-for="l in live.view" :key="l" class="hb-row">{{ l }}</div>
                <div v-if="!live.view.length" class="hb-row">nothing in view</div>
              </HbList>
              <HbList>
                <div v-for="l in live.earlier" :key="l" class="hb-row">{{ l }}</div>
                <div v-if="!live.earlier.length" class="hb-row">nothing seen earlier</div>
              </HbList>
            </HbFold>
            <HbFold v-model="open.plan" summary="last plan" persist-key="room-mind-plan">
              <HbCodeBlock v-if="live.last.plan" :code="live.last.plan" lang="json" />
              <p v-else class="hb-hint">no plan yet. give an order.</p>
            </HbFold>
            <HbFold v-model="open.prompt" summary="last prompt and reply" persist-key="room-mind-prompt">
              <pre class="hb-code" data-prompt>{{ live.last.prompt || 'no prompt yet.' }}</pre>
              <pre class="hb-code" data-reply>{{ live.last.reply || 'no model reply: reflexes and the scripted planner write none.' }}</pre>
            </HbFold>
            <HbFold v-model="open.fast" summary="fast feed: acts and senses" persist-key="room-mind-fast">
              <HbCausalLog :events="live.log.filter((e) => e.kind === 'act' || e.kind === 'eye')" :limit="40" label="fast feed" />
            </HbFold>
            <HbFold v-model="open.slow" summary="slow feed: orders, ideas and the brain" persist-key="room-mind-slow">
              <HbEventLog :rows="live.slow" label="slow feed" :max="80" />
            </HbFold>
          </div>

          <div v-else-if="value === 'eyes'" class="hb-stack hb-instrument" data-pane="eyes">
            <HbPanel heading="inset" sunk>
              <HbSelect v-model="insetMode" :options="[...INSETS]" label="inset shows" />
              <label class="hb-check"><HbSwitch v-model="captions" label="captions" /> captions in the log</label>
            </HbPanel>
            <HbPanel heading="feed the brain" sunk>
              <HbParamRow :model-value="fov" label="field of view" :min="50" :max="110" :step="1" unit="deg" :default-value="74" @update:model-value="(v) => tool.reg.set('eye.fov', Number(v))" />
              <HbParamRow :model-value="rate" label="sense rate" :min="1" :max="10" :step="0.5" unit="/s" :default-value="3" @update:model-value="(v) => tool.reg.set('eye.rate', Number(v))" />
              <HbParamRow :model-value="floor" label="detector floor" :min="1" :max="40" :step="1" unit="px" :default-value="4" @update:model-value="(v) => tool.reg.set('eye.floor', Number(v))" />
              <HbSelect v-model="feed" :options="[...FEEDS]" label="feed the brain" />
              <pre v-if="live.fed" class="hb-code" data-fed>{{ live.fed }}</pre>
              <HbKv label="prompt cost" :value="`${live.tokens} tokens a turn (inferred, 4 characters a token)`" />
              <p class="hb-hint">give a small model a few clearances and labelled sightings with ranges, not raw pixels. the grid costs prompt tokens, so turn it on for bigger models.</p>
            </HbPanel>
            <HbPanel heading="depth" sunk>
              <HbSelect v-model="depthSource" :options="['own render', 'depth model']" label="depth from" />
              <p v-if="depthSource === 'depth model'" class="hb-hint">the depth model loads from the rack. until it does, depth comes from the eye's own render.</p>
              <HbKv label="clear left" :value="`${live.clear.left.toFixed(1)} m`" />
              <HbKv label="clear ahead" :value="`${live.clear.ahead.toFixed(1)} m`" />
              <HbKv label="clear right" :value="`${live.clear.right.toFixed(1)} m`" />
              <HbTable v-if="feed === 'clearances and an 8 by 5 grid' && gridRows.length" :columns="gridCols" :rows="gridRows" />
            </HbPanel>
          </div>

          <div v-else-if="value === 'memory'" class="hb-stack" data-pane="memory">
            <HbMemoryPanel
              v-model:query="memQuery"
              v-model:kind="memKind"
              :items="memShown"
              :all="memItems"
              :kinds="memKinds"
              :readonly="!mem"
              @search="memSearch"
              @add="memAdd"
              @forget="memForget"
              @import="memImport"
            />
            <HbButton variant="secondary" size="sm" :disabled="!mem" @click="memConsolidate">consolidate</HbButton>
            <p class="hb-hint">teach by talking: "remember that the mug lives on the shelf". the line is kept here and recalled into later prompts.</p>
          </div>

          <div v-else-if="value === 'body'" class="hb-stack hb-instrument" data-pane="body">
            <HbKv label="body" :value="tool.body.name" />
            <HbKv label="hands" :value="live.hands" />
            <HbPanel heading="the body api" sunk>
              <HbList>
                <div v-for="l in live.tools" :key="l" class="hb-row"><code>{{ l }}</code></div>
              </HbList>
              <p class="hb-hint">the same list the prompt carries. {{ live.tools.length }} tools.</p>
            </HbPanel>
          </div>

          <div v-else-if="value === 'brain'" class="hb-stack hb-instrument" data-pane="brain">
            <HbSelect v-model="room.brain.value" :options="[...BRAINS]" label="who decides" />
            <p class="hb-hint">{{ BRAIN_NOTES[room.brain.value] }}</p>
            <HbButton v-if="room.brain.value === 'in tab' && room.brainState.value !== 'loaded'" variant="secondary" size="sm" @click="loadBrain">load the brain</HbButton>
            <HbPanel heading="fallback chain" sunk>
              <HbKv label="last turn by" :value="tierWord" />
              <HbEventLog :rows="dropRows" label="steps down" :max="40" />
              <p class="hb-hint">the brain plans first, then the scripted planner, then reflexes. each step down is written with its reason.</p>
            </HbPanel>
          </div>

          <div v-else class="hb-stack hb-instrument" data-pane="voice">
            <label class="hb-check"><HbSwitch v-model="speakOn" label="speak replies" /> speak replies with the browser voice</label>
            <p class="hb-hint">replies always show in the bubble, the caption and the log.</p>
          </div>
        </template>
      </HbTabs>
    </template>
  </StageTool>
</template>
