// The mind: an @hackbuild/agent over the room's tools. Rules map plain
// orders to steps with no model; goals (explore, find, fetch, tidy) keep
// going until done; a loaded chat model decides with forced JSON when one
// is there. In free run, @hackbuild/drives picks what to do next.
import { Goals, Reflex, createAgent, storageSink, type Agent, type AgentEvent, type AgentMemory, type Goal, type GoalStep, type Perception, type Step } from '@hackbuild/agent'
import type { ChatEngine } from '@hackbuild/chat'
import { Chooser, Drives, seededRng } from '@hackbuild/drives'
import type { Seen, World } from './world'

export type Mode = 'reflex' | 'hints' | 'model'
export const MODES: { value: Mode; label: string }[] = [
  { value: 'reflex', label: 'rules first, the model for the rest' },
  { value: 'hints', label: 'the model, with the rules as hints' },
  { value: 'model', label: 'the model decides everything' },
]
export const SOUL = 'you live in a small workshop room in a browser tab. you have a body, eyes and two hands. you are curious and plain spoken. you act with your tools and say short things out loud.'
export const ORDERS = ['explore', 'find the coin', 'bring me the mug', 'put it on the shelf', 'tidy up', 'turn on the lamp', 'what do you see', 'sit down']

export interface MindOptions {
  world: World
  goals: Goals<World>
  brain: () => ChatEngine | null
  memory: AgentMemory
  mode: Mode
  budgetTokens: number
  steps: number
  cache: boolean
  soul: string
  perceive: () => Perception<World>
  onEvent: (e: AgentEvent) => void
  onSay: (text: string, final: boolean) => void
}

const step = (tool: string, ...args: string[]): Step => ({ tool, args })

export function reflex(world: World): Reflex {
  const r = new Reflex()
  r.add(/^(?:go|walk|come)(?: over)? to (?:the )?(.+)$/, (m) => [step('walk_to', m[1]!)])
  r.add(/^(?:pick up|grab|take) (?:the )?(.+)$/, (m) => [step('walk_to', m[1]!), step('pick_up', m[1]!)])
  r.add(/^(?:put|place) (?:it|that|the .+?) (?:on|onto) (?:the )?(.+)$/, (m) => [step('walk_to', m[1]!), step('put_on', m[1]!)])
  r.add(/^(?:put it down|drop it)$/, [step('put_down')])
  r.add(/^(?:look around|explore|look)$/, [step('look_around')])
  r.add(/^turn (?:on|off) (?:the )?(.+)$/, (m) => [step('walk_to', m[1]!), step('turn_on', m[1]!)])
  r.add(/^sit(?: down)?$/, [step('walk_to', 'chair'), step('gesture', 'bow')])
  r.add(/^(?:dance|wave|nod)$/, (m) => [step('gesture', m[0] === 'dance' ? 'wave' : m[0]!)])
  r.add(/^(?:what do you see|describe the room)$/, () => [step('say', describe(world.seen()))])
  r.add(/^(?:what are you holding)$/, () => [step('say', world.held ? `the ${world.held.name}.` : 'nothing.')])
  return r
}

export const describe = (seen: Seen[]) => (seen.length ? `i see ${seen.slice(0, 5).map((s) => `the ${s.name}, ${s.dist.toFixed(1)} m`).join('; ')}.` : 'nothing i know is in front of me.')

/** Planners that need no model: given the room, the next steps of a goal. */
export function makeGoals(world: World): Goals<World> {
  const where = (name: string | null) => (name ? world.find(name) : null)
  // goals survive a reload where storage is allowed; a blocked store keeps them for this visit
  let store: Pick<Storage, 'getItem' | 'setItem'>
  try {
    store = localStorage
    store.getItem('room-goals')
  } catch {
    const m = new Map<string, string>()
    store = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) }
  }
  const g = new Goals<World>({ sink: storageSink(store, 'room-goals') })
  g.planner('explore', (goal): GoalStep => (goal.tries > 3 ? { done: 'i have looked all round the room.' } : { steps: [step('look_around'), step('walk_to', ['table', 'shelf', 'workbench', 'lamp'][goal.tries % 4]!)] }))
  g.planner('find', (goal): GoalStep => {
    const t = where(goal.target)
    if (!t) return { failed: `there is no ${goal.target} in this room.` }
    if (world.near(t.id) < 1.2) return { done: `found the ${t.name}.` }
    return world.beliefs.has(t.id) ? { steps: [step('walk_to', t.name)] } : { steps: [step('look_around')] }
  })
  g.planner('fetch', (goal): GoalStep => {
    const t = where(goal.target)
    if (!t) return { failed: `there is no ${goal.target} in this room.` }
    if (world.held?.id === t.id) return world.near('person') < 1 ? { done: `here is the ${t.name}.` } : { steps: [step('walk_to', 'you'), step('put_down')] }
    return { steps: [step('walk_to', t.name), step('pick_up', t.name)] }
  })
  g.planner('tidy', (): GoalStep => {
    const loose = world.things.find((t) => t.on !== 'shelf' && t.id !== 'radio' && t !== world.held)
    if (world.held) return { steps: [step('walk_to', 'shelf'), step('put_on', 'shelf')] }
    return loose ? { steps: [step('walk_to', loose.name), step('pick_up', loose.name)] } : { done: 'everything is on the shelf.' }
  })
  return g
}

export function mind(o: MindOptions): Agent<World> {
  return createAgent<World>({
    tools: o.world.tools(),
    brain: o.brain(),
    mode: o.brain() ? o.mode : 'reflex',
    soul: o.soul,
    body: 'you stand on the floor of the room. walk to a thing before you pick it up or put something on it. you hold one thing at a time.',
    perceive: o.perceive,
    memory: o.memory,
    reflex: reflex(o.world),
    goals: o.goals,
    budgetTokens: o.budgetTokens,
    steps: o.steps,
    goalSteps: Math.max(o.steps, 8),
    cacheSize: o.cache ? 60 : 0,
    idle: [[step('look_around')], [step('gesture', 'nod')]],
    onEvent: o.onEvent,
    onSay: o.onSay,
  })
}

export type Need = 'energy' | 'social' | 'curiosity'
export type Act = 'explore' | 'rest' | 'chat' | 'tidy'
const EFFECT: Record<Act, Partial<Record<Need, number>>> = {
  explore: { curiosity: -0.5, energy: 0.1 },
  rest: { energy: -0.6 },
  chat: { social: -0.6 },
  tidy: { curiosity: -0.2, energy: 0.15 },
}
export const ACT_ORDER: Record<Act, string> = { explore: 'explore', rest: 'sit down', chat: 'what do you see', tidy: 'tidy up' }
const GROW: Record<Need, number> = { energy: 0.01, social: 0.02, curiosity: 0.03 }

/** Drives and a chooser for free run; call tick once a second. */
export function freeRun() {
  const drives = new Drives<Need>({ energy: 1, social: 1, curiosity: 1 })
  drives.set({ energy: 0.2, social: 0.3, curiosity: 0.6 })
  const chooser = new Chooser<Act>({ rng: seededRng(11), options: ['explore', 'rest', 'chat', 'tidy'], start: 'explore' })
  let now = 0
  let since = 0
  return {
    drives,
    chooser,
    tick(dt: number) {
      now += dt
      drives.grow(dt, GROW)
      const scores = Object.fromEntries((Object.keys(EFFECT) as Act[]).map((a) => [a, drives.rewardOf(EFFECT[a])])) as Record<Act, number>
      const d = chooser.update(now, scores)
      if (d.switched) since = now
      return { decision: d, now, seconds: now - since }
    },
    /** The act ran: its effect lands on the drives. */
    done(act: Act) {
      const v = drives.values
      drives.set(Object.fromEntries(Object.entries(EFFECT[act]).map(([k, e]) => [k, Math.min(1, Math.max(0, v[k as Need] + (e as number)))])))
      chooser.markDone()
    },
  }
}

export const goalLine = (g: Goal) => `${g.kind}${g.target ? ` ${g.target}` : ''}, ${g.status}${g.note ? `: ${g.note}` : ''}`

// --- mutters and reflections (ported from mortise): with a brain loaded and no
// order running, a fleeting thought fragment every few seconds, and every
// seventh plan a line that finishes "right now my attention is on". The
// reflection goes to memory and back into the next prompt.
const META = /\b(user|assistant|prompt|instruction|as an ai)\b/i
const firstLine = (t: string) => t.split('\n')[0]!.replace(/^["'\s~-]+|["'\s]+$/g, '').trim()

/** Seconds between mutters (inferred from mortise: 6.5 s less up to 2.8 s when excited). */
export const MUTTER_EVERY = 6.5
/** A reflection after this many plans, at most once in this many seconds (mortise). */
export const REFLECT_PLANS = 7
export const REFLECT_GAP = 25

export async function mutter(brain: ChatEngine, soul: string, state: string): Promise<string> {
  const r = await brain.complete([
    { role: 'system', content: `you are the inner voice of a small being living its own life in one room. ${soul} there is no user and you are not an assistant. write one fleeting thought fragment, first person, under 16 words. sensory, about the body or the room. never advice.` },
    { role: 'user', content: `${state} one fragment:` },
  ], { maxTokens: 26, temperature: 0.95 })
  const line = firstLine(r.text).slice(0, 140)
  return line && !META.test(line) ? line : ''
}

const STEM = 'right now my attention is on '
export async function reflect(brain: ChatEngine, recent: string): Promise<string> {
  const r = await brain.complete([
    { role: 'system', content: 'you are the attention watching part of a small being. you finish its sentences in first person. use only details from the notes given. invent nothing. no advice, no second person.' },
    { role: 'user', content: `notes: ${recent}\nfinish this sentence in under 22 words: "${STEM}` },
  ], { maxTokens: 40, temperature: 0.65 })
  const tail = firstLine(r.text).replace(/["'].*$/, '').trim()
  return tail && !META.test(tail) && !/^you\b/i.test(tail) ? (STEM + tail).slice(0, 240) : ''
}
