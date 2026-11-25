// Who decides in the room (design 3.10 steps 1, 5 and 10): the planner
// fallback chain of @hackbuild/agent. The model plans first; when it is
// absent, still loading, failing or returning no valid plan the scripted
// planner answers questions about what the body sees and holds; the
// reflex brain maps orders to steps last. Every step down is written to
// the log with its reason. The reflex rules port the room original's
// order chips. Framework free.
import { createPlannerChain, createRegistry, dropLine, Reflex, stepText, type ChainResult, type Drop, type PlanFn, type Registry, type Step } from '@hackbuild/agent'
import { scripted, type ChatEngine, type ChatMessage } from '@hackbuild/chat'
import { SMALL, type LogKind, type World } from './world.ts'

export type Brain = 'reflex only' | 'in tab' | 'your endpoint'
export const BRAINS: readonly Brain[] = ['reflex only', 'in tab', 'your endpoint']
export const BRAIN_NOTES: Record<Brain, string> = {
  'reflex only': 'no model, no download, runs anywhere. orders map to steps by rule.',
  'in tab': 'a small model in this tab plans every turn. reflexes stand in while it loads.',
  'your endpoint': 'any openai style server plans every turn. your words go to that server.',
}

/** Who decides when a model is loaded (P-ROOM-7), the room original's three options. */
export type Decide = 'the model' | 'with hints' | 'reflexes first'
export const DECIDES: readonly Decide[] = ['the model', 'with hints', 'reflexes first']
export const DECIDE_NOTES: Record<Decide, string> = {
  'the model': 'it reads the situation, picks every action, sees each result and goes again.',
  'with hints': 'the same loop, but every prompt carries the step the reflexes would take. best for the smallest models.',
  'reflexes first': 'plain orders run with no model call. the model only gets what the rules cannot parse.',
}

/** Planner parameters, each read at the start of a turn (P-SET-5). */
export interface Params {
  temperature: number
  /** Reply tokens the model may write. */
  tokens: number
  /** Steps a plan may hold. */
  steps: number
  /** Memories recalled into each prompt. */
  hits: number
}
export const PARAMS: Params = { temperature: 0.4, tokens: 320, steps: 6, hits: 3 }

/** An injected event as the body hears it. */
export const eventLine = (text: string): string => `something happened: ${text.trim().replace(/[.\s]+$/, '')}`

const one = (tool: string, ...args: string[]): Step => ({ tool, args })
const fetchSteps = (x: string): Step[] => [one('walk_to', x), one('pick_up', x)]

/** The reflex rules: one clause, one short list of steps. */
export function roomReflex(world: World): Reflex {
  const r = new Reflex()
  const held = () => world.heldThing() ?? 'it'
  r.add(/^(stop|halt|freeze|stay)$/, [one('stop')])
  r.add(/^(come here|come to me|come back|follow me)$/, [one('walk_to', 'you')])
  r.add(/^(hi|hello|hey)\b/, [one('look_at', 'you'), one('say', 'hello. i am here in the room with you.')])
  r.add(/^(explore|look around|wander)\b/, [one('explore')])
  r.add(/^tidy( up)?$/, () => {
    const loose = world.things.find((t) => (SMALL as readonly string[]).includes(t.label) && !t.on && !t.held)
    return loose ? [...fetchSteps(loose.label), one('walk_to', 'shelf'), one('put_on', loose.label, 'shelf')] : [one('say', 'everything is put away.')]
  })
  r.add(/^wait\b/, [one('wait', '2')])
  // an injected event: say so and look around, so a run on reflexes still reacts
  r.add(/^something happened: /, [one('say', 'what was that?'), one('explore')])
  r.add(/^(drop it|let go|put it down)$/, [one('drop')])
  r.add(/^put it (?:on|onto|in) (?:the )?(\w+)$/, (m) => [one('walk_to', m[1]!), one('put_on', held(), m[1]!)])
  r.add(/^(?:put|move|take) (?:the )?(\w+) (?:on|onto|in|to) (?:the )?(\w+)$/, (m) => [...fetchSteps(m[1]!), one('walk_to', m[2]!), one('put_on', m[1]!, m[2]!)])
  r.add(/^(?:the )?(\w+) (?:to|on) (?:the )?(\w+)$/, (m) => [...fetchSteps(m[1]!), one('walk_to', m[2]!), one('put_on', m[1]!, m[2]!)])
  r.add(/^(?:bring|fetch) (?:me )?(?:the )?(\w+)(?: to me)?$/, (m) => [...fetchSteps(m[1]!), one('walk_to', 'you')])
  r.add(/^(?:pick up|grab|take|get|lift) (?:the )?(\w+)$/, (m) => fetchSteps(m[1]!))
  r.add(/^(?:go|walk|move|run) (?:to|over to) (?:the )?(\w+)$/, (m) => [one('walk_to', m[1]!)])
  r.add(/^(?:look at|face|turn to) (?:the )?(\w+)$/, (m) => [one('look_at', m[1]!)])
  r.add(/^find (?:the )?(\w+)$/, (m) => [one('look_at', m[1]!), one('walk_to', m[1]!)])
  return r
}

/** The scripted planner: answers questions from the body's own state, no download. */
export function roomScripted(world: World, seen: () => string[]): PlanFn {
  return (req) => {
    const t = req.text.toLowerCase().trim().replace(/[?.]+$/, '')
    const say = (s: string) => JSON.stringify({ say: s, do: [], done: true })
    if (/^what (are you doing|is going on)|^status$/.test(t)) return say(`${world.doing}. ${world.handsLine()}`)
    if (/^what (do you see|is in view|can you see)/.test(t)) {
      const s = seen()
      return say(s.length ? `i see ${s.slice(0, 4).join('; ')}.` : 'nothing in view right now.')
    }
    if (/^what are you holding|^what is in your hands/.test(t)) return say(world.handsLine())
    if (/^who are you/.test(t)) return say('a body in this room. i see, walk, lift and put things down.')
    const where = /^where is (?:the )?(\w+)/.exec(t)
    if (where) {
      const th = world.thing(where[1]!)
      return say(th ? `the ${th.label} is ${th.held ? `in my ${th.held} hand` : th.on ? `on the ${th.on}` : `on the floor at ${th.x.toFixed(1)}, ${th.z.toFixed(1)}`}.` : `there is no ${where[1]} here.`)
    }
    return null
  }
}

/**
 * The stub model of ?stub pages: plans like a model, from the reflex, so
 * the model tier, the prompt and the reply are exercised with no weights.
 * ?stub&fail=brain makes it fail, so the chain steps down.
 */
export function stubModel(reflex: Reflex, fail: boolean): ChatEngine {
  return scripted({
    replies: (req) => {
      if (fail) throw new Error('out of gpu memory')
      const user = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
      const heard = /^heard: (.*)$/m.exec(user)?.[1] ?? ''
      const r = reflex.parse(heard)
      if (!r) return JSON.stringify({ think: `no plan for "${heard}".`, say: '', do: [], done: true })
      return JSON.stringify({ think: `the order maps to ${r.steps.length} steps.`, say: '', do: r.steps.map((s) => [s.tool, ...s.args]), done: true })
    },
  })
}

export interface TurnLog {
  log(kind: LogKind, text: string): void
}

export interface Last {
  tier: string
  prompt: string
  reply: string
  plan: string
}

export interface Cost {
  model: number
  scripted: number
  reflex: number
  none: number
  tokens: number
  ms: number
}

export interface MindOptions {
  world: World
  persona: () => string
  /** The model planner now, or null. */
  model: () => ChatEngine | null
  loading: () => boolean
  /** Lines of what is in view, for the prompt and the scripted planner. */
  seen: () => string[]
  /** Memories for the prompt, best first. */
  recall?: (text: string) => Promise<string[]>
  stub?: { fail: boolean } | null
  /** False when the tier is reflexes only: a missing model is then no news. */
  wantsModel?: () => boolean
  /** Who decides; default the model. */
  decide?: () => Decide
  /** Planner parameters; default PARAMS. */
  params?: () => Params
  /** Free text added to the persona, at the end of the system prompt. */
  extra?: () => string
  log: TurnLog['log']
}

/** Characters per token for the cost readout (inferred, 4 is the usual rule). */
const CHARS = 4

export class Mind {
  readonly registry: Registry
  readonly reflex: Reflex
  chain: ReturnType<typeof createPlannerChain>
  last: Last = { tier: '', prompt: '', reply: '', plan: '' }
  cost: Cost = { model: 0, scripted: 0, reflex: 0, none: 0, tokens: 0, ms: 0 }
  drops: Drop[] = []
  goal = ''
  private o: MindOptions
  private abort: AbortController | null = null
  private stubEngine: ChatEngine | null
  private built = ''

  constructor(o: MindOptions) {
    this.o = o
    this.registry = createRegistry(o.world.tools())
    this.reflex = roomReflex(o.world)
    this.stubEngine = o.stub ? stubModel(this.reflex, o.stub.fail) : null
    this.chain = this.build()
  }

  get params(): Params {
    return { ...PARAMS, ...this.o.params?.() }
  }

  /** The chain for the parameters as they stand; rebuilt when they change, so they apply on the next turn. */
  private build(): ReturnType<typeof createPlannerChain> {
    const p = this.params
    this.built = JSON.stringify(p)
    return createPlannerChain({
      tools: this.registry.names,
      getModel: () => this.stubEngine && this.o.model() ? this.stubEngine : this.o.model(),
      loading: this.o.loading,
      scripted: roomScripted(this.o.world, this.o.seen),
      reflex: this.reflex,
      tries: 2,
      maxActions: p.steps,
      maxTokens: p.tokens,
      temperature: p.temperature,
    })
  }

  get running(): boolean {
    return this.abort !== null
  }

  system(): string {
    return [
      this.o.persona().trim(),
      'you are a body in a small room. you plan with these tools:',
      this.registry.describe(),
      'reply with one json object: {"think": "...", "say": "...", "do": [["tool", "arg"]], "done": true}.',
      this.o.extra?.().trim() ?? '',
    ].filter(Boolean).join('\n')
  }

  async user(text: string): Promise<string> {
    const hits = this.params.hits
    const mem = this.o.recall && hits > 0 ? (await this.o.recall(text).catch(() => [])).slice(0, hits) : []
    const seen = this.o.seen()
    const hint = this.o.decide?.() === 'with hints' ? this.reflex.parse(text) : null
    return [
      `heard: ${text}`,
      hint ? `hint: the reflexes would do ${hint.steps.map(stepText).join(', then ')}` : '',
      `in view: ${seen.length ? seen.join('; ') : 'nothing'}`,
      `body: ${this.o.world.state()}`,
      mem.length ? `you remember: ${mem.join('; ')}` : '',
      this.goal ? `goal: ${this.goal}` : '',
    ].filter(Boolean).join('\n')
  }

  /** Stops the turn in hand and the act. */
  stop(): void {
    this.abort?.abort()
    this.abort = null
    this.o.world.stop()
  }

  /** One turn: plan through the chain, then run the steps in order. */
  async turn(text: string): Promise<ChainResult | null> {
    this.stop()
    const ac = new AbortController()
    this.abort = ac
    const t0 = performance.now()
    const messages: ChatMessage[] = [{ role: 'system', content: this.system() }, { role: 'user', content: await this.user(text) }]
    const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n\n')
    if (JSON.stringify(this.params) !== this.built) this.chain = this.build()
    // reflexes first: a plain order runs with no model call
    const first = this.o.decide?.() === 'reflexes first' ? this.reflex.parse(text) : null
    const r: ChainResult | null = first
      ? { tier: 'reflex', raw: '', drops: [], plan: { think: '', say: '', do: first.steps.slice(0, this.params.steps), unknown: [], done: true, from: 'json' } }
      : await this.chain.plan({ text, messages, signal: ac.signal })
    this.drops = [...this.chain.log]
    for (const d of first ? [] : this.chain.lastDrops) {
      if (d.reason === 'absent' && (d.from !== 'model' || this.o.wantsModel?.() === false)) continue
      this.o.log('note', dropLine(d))
    }
    this.cost.ms = Math.round(performance.now() - t0)
    if (!r) {
      this.cost.none++
      this.last = { tier: 'none', prompt, reply: '', plan: '' }
      if (!ac.signal.aborted) this.o.log('fail', `no plan for "${text}". try an order chip, or a brain that reads plain words.`)
      if (this.abort === ac) this.abort = null
      return null
    }
    this.cost[r.tier]++
    if (r.tier !== 'reflex') this.cost.tokens += Math.round((prompt.length + r.raw.length) / CHARS)
    const plan = r.plan
    this.last = { tier: r.tier, prompt: r.tier === 'reflex' ? `reflex rules on: ${text}` : prompt, reply: r.raw, plan: JSON.stringify({ think: plan.think, say: plan.say, do: plan.do.map((s) => [s.tool, ...s.args]) }, null, 1) }
    this.goal = plan.do.length ? text : this.goal
    if (plan.think) this.o.log('think', plan.think)
    if (plan.unknown.length) this.o.log('fail', `the plan named tools the body lacks: ${plan.unknown.join(', ')}.`)
    if (plan.say) this.o.world.say(plan.say)
    for (const step of plan.do) {
      if (ac.signal.aborted) break
      const res = await this.registry.run(step, { signal: ac.signal, heard: text })
      if (step.tool === 'say' || step.tool === 'walk_to' || step.tool === 'explore') {
        if (!res.ok) this.o.log('fail', res.text)
      } else this.o.log(res.ok ? 'act' : 'fail', res.ok ? `${stepText(step)}: ${res.text}` : res.text)
      if (!res.ok) break
    }
    if (this.abort === ac) {
      this.abort = null
      this.goal = ''
    }
    return r
  }
}
