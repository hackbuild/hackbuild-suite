// The tools rack of chat studio (satchel-chat's tool loop on @hackbuild/agent).
// The page's own tools, all in this tab: search memory, keep a note, the
// clock and arithmetic. With tools on, the chat engine is wrapped so a send
// runs one agent turn (plan, steps, repeat and failure guards, a tolerant
// parse of the model's json) and streams what the agent says as the reply.
import { Agent, ToolError, type AgentEvent, type Tool } from '@hackbuild/agent'
import type { ChatEngine, ChatEvent, ChatMessage, ChatResult, StreamOptions } from '@hackbuild/chat'
import type { Memory } from '@hackbuild/memory'

/** Arithmetic on + - * / % and brackets, no eval. */
export function calc(src: string): number {
  const s = src.replace(/\s+/g, '')
  let i = 0
  const fail = (): never => { throw new ToolError(`i cannot read "${src}" as arithmetic.`) }
  const num = (): number => {
    if (s[i] === '(') { i++; const v = sum(); if (s[i++] !== ')') fail(); return v }
    if (s[i] === '-') { i++; return -num() }
    const m = /^\d+(\.\d+)?/.exec(s.slice(i))
    if (!m) fail()
    i += m![0].length
    return Number(m![0])
  }
  const prod = (): number => {
    let v = num()
    while (s[i] === '*' || s[i] === '/' || s[i] === '%') { const o = s[i++]; const r = num(); v = o === '*' ? v * r : o === '/' ? v / r : v % r }
    return v
  }
  const sum = (): number => {
    let v = prod()
    while (s[i] === '+' || s[i] === '-') { const o = s[i++]; const r = prod(); v = o === '+' ? v + r : v - r }
    return v
  }
  const v = sum()
  if (i < s.length || !Number.isFinite(v)) fail()
  return v
}

/** The tools the model may call, over this page's memory. */
export function chatTools(mem: () => Promise<Memory>): Tool[] {
  const one = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  return [
    { name: 'recall', description: 'search the memory for lines about a topic', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }, async run([q]) {
      const r = await (await mem()).recall(q ?? '', { k: 4 })
      const hits = r.hits.filter((h) => h.score > 0.01).map((h) => h.item.text)
      if (!hits.length) throw new ToolError(`my memory has nothing on ${q}.`)
      return hits.join(' | ')
    } },
    { name: 'remember', description: 'keep a note in the memory', parameters: one, async run([t]) {
      if (!t) throw new ToolError('there is nothing to keep.')
      await (await mem()).add(t, { kind: 'fact' })
      return 'kept.'
    } },
    { name: 'clock', description: 'the date and time here', run: () => new Date().toString().slice(0, 24) },
    { name: 'calc', description: 'work out arithmetic', parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] }, run: ([e]) => String(calc(e ?? '')) },
  ]
}

export interface ToolsOptions {
  tools: Tool[]
  soul: () => string
  steps: () => number
  memory: () => Promise<Memory>
  onEvent: (e: AgentEvent) => void
}

const RESULT: Omit<ChatResult, 'text' | 'stats'> = { think: '', finish: 'stop', toolCalls: [], schemaFallback: false, schemaIndex: -1 }

/** Wraps a chat engine so each send runs one agent turn with tools. */
export function withTools(brain: ChatEngine, o: ToolsOptions): ChatEngine {
  async function* stream(messages: readonly ChatMessage[], opts?: StreamOptions): AsyncGenerator<ChatEvent, ChatResult> {
    const heard = [...messages].reverse().find((m) => m.role === 'user')
    const queue: string[] = []
    let wake = () => {}
    let done = false
    const agent = new Agent({
      tools: o.tools, brain, mode: 'model', soul: o.soul(), steps: o.steps(), maxTokens: opts?.maxTokens, temperature: opts?.temperature,
      memory: { recall: async (q) => (await (await o.memory()).recall(q, { k: 3 })).hits.map((h) => h.item.text), write: () => {} },
      onSay: (t, final) => { if (t) queue.push(t); else if (final) queue.push(' '); wake() },
      onEvent: o.onEvent,
    })
    opts?.signal?.addEventListener('abort', () => agent.cancel())
    const t0 = performance.now()
    const turn = agent.handle(typeof heard?.content === 'string' ? heard.content : '', 'heard').finally(() => { done = true; wake() })
    let text = ''
    while (!done || queue.length) {
      if (!queue.length) await new Promise<void>((ok) => (wake = ok))
      while (queue.length) { const t = queue.shift()!; text += t; yield { type: 'text', text: t } }
    }
    const r = await turn
    if (!text) { text = r.said.join(' ') || `no reply: the turn ended (${r.ended}).`; yield { type: 'text', text } }
    const result: ChatResult = { ...RESULT, text, stats: { tokens: 0, tokensSource: 'inferred', tokensPerSecond: null, firstTokenMs: null, totalMs: performance.now() - t0 } }
    yield { type: 'done', result }
    return result
  }
  return {
    id: brain.id, provider: brain.provider, caps: brain.caps, stream,
    async complete(m, opts) { const g = stream(m, opts); let n = await g.next(); while (!n.done) n = await g.next(); return n.value },
    dispose: () => brain.dispose(),
  }
}
