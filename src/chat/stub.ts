// The scripted engine: answers with no model and no download. It backs the
// welcome chips before any load and every ?stub page, streaming canned
// tokens with a think block first, so the think fold, the stats strip and
// stop are all exercised without weights.
import { createEngine, type ChatEngine, type ChatMessage, type Driver, type DriverEvent, type DriverRequest } from '@hackbuild/chat'

export interface StubOptions {
  /** Shown as the engine id. Default 'scripted'. */
  id?: string
  /** Characters per streamed piece. Default 3. */
  chunk?: number
  /** Wait between pieces in ms. Default 12. */
  delayMs?: number
  /** Reply for a request; default stubReply. */
  reply?: (messages: readonly ChatMessage[]) => string
}

/** The canned reply: a think block, then an answer that names the script. */
export function stubReply(messages: readonly ChatMessage[], id = 'scripted'): string {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content.trim() ?? ''
  const short = last.length > 60 ? `${last.slice(0, 57)}...` : last
  const turns = messages.filter((m) => m.role === 'user').length
  return (
    `<think>the person wrote "${short}". this is turn ${turns}. no model is loaded, so the ${id} engine answers from a script.</think>` +
    `this answer comes from a script, not a model. you wrote: ${short}\n\npick a model in the engine bar to talk for real. the think fold above shows where reasoning goes.`
  )
}

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    if (!ms || signal?.aborted) return res()
    const t = setTimeout(res, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); res() }, { once: true })
  })

export function stubDriver(o: StubOptions = {}): Driver {
  const id = o.id ?? 'scripted'
  const step = Math.max(1, o.chunk ?? 3)
  const delay = o.delayMs ?? 12
  return {
    id,
    provider: 'stub',
    caps: { schema: false, tools: false, systemRole: true, stop: false },
    async *stream(req: DriverRequest): AsyncGenerator<DriverEvent> {
      const text = (o.reply ?? ((m) => stubReply(m, id)))(req.messages)
      let n = 0
      for (let i = 0; i < text.length; i += step) {
        if (req.signal?.aborted) {
          yield { type: 'done', finish: 'abort' }
          return
        }
        await wait(delay, req.signal)
        n++
        yield { type: 'text', text: text.slice(i, i + step) }
      }
      yield { type: 'done', finish: 'stop', }
    },
  }
}

/** A chat engine over the stub driver; the engine splits the think block from the answer. */
export function stubChat(o: StubOptions = {}): ChatEngine {
  return createEngine(stubDriver(o))
}
