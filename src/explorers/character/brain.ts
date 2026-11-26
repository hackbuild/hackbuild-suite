// The brain as the thread sees it: the loaded chat engine wrapped so the
// settings of the brain tab reach every call (temperature, who he is
// talking to, reply length) and typos land only in what the reader sees.
// The clean text of each reply is kept: the voice speaks it and the history
// sent back to the model carries it, as the original did.
import type { ChatEngine, ChatEvent, ChatMessage, ChatResult, StreamOptions } from '@hackbuild/chat'

export interface BrainSettings {
  temperature: number
  /** slack: a person in chat; terminal: a developer at a prompt. */
  register: 'slack' | 'terminal'
  /** 0 a line, 1 a few lines, 2 a paragraph, 3 long. */
  length: number
  /** 0 none, 1 light, 2 heavy. */
  flaws: number
}

export const LENGTHS = ['a line', 'a few lines', 'paragraph', 'long'] as const
export const FLAWS = ['none', 'light', 'heavy'] as const
const TOKENS = [60, 140, 320, 700]
const REGISTER = {
  slack: 'you are chatting with a person in a work chat. short lines, lowercase is fine, no lists, no headings.',
  terminal: 'you are talking to a developer at a terminal. plain text, exact, no small talk.',
}
const SHAPE = ['answer in one line.', 'answer in two or three short lines.', 'answer in one paragraph.', 'answer at length when it helps.']

/** The system line the settings add. */
export const styleLine = (s: BrainSettings) => `${REGISTER[s.register]} ${SHAPE[s.length]}`

/** A seeded typo pass over whole words: swapped letters, a dropped letter, a lost apostrophe. */
export function flaw(word: string, level: number, n: number): string {
  if (!level || word.length < 4 || !/^[a-z']+$/i.test(word)) return word
  const roll = ((n * 2654435761) >>> 0) % 100
  if (roll >= (level === 1 ? 6 : 16)) return word
  const i = 1 + (roll % (word.length - 2))
  if (word.includes("'")) return word.replace("'", '')
  if (roll % 3 === 0) return word.slice(0, i) + word.slice(i + 1)
  return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2)
}

export interface Brain {
  /** The engine to hand the thread, or null with none loaded. */
  wrap(engine: ChatEngine | null): ChatEngine | null
  /** The clean text of a reply as shown, or the shown text. */
  clean(shown: string): string
}

export function brain(settings: () => BrainSettings, system: () => string): Brain {
  const cleanOf = new Map<string, string>()
  const clean = (shown: string) => cleanOf.get(shown.trim()) ?? shown
  const rewrite = (m: readonly ChatMessage[]): ChatMessage[] => {
    const out = m.map((x) => (x.role === 'assistant' && typeof x.content === 'string' ? { ...x, content: clean(x.content) } : x))
    const sys = `${system()}\n${styleLine(settings())}`
    return out[0]?.role === 'system' ? [{ ...out[0], content: `${sys}\n${String(out[0].content)}` }, ...out.slice(1)] : [{ role: 'system', content: sys }, ...out]
  }
  const opts = (o?: StreamOptions): StreamOptions => ({ ...o, temperature: settings().temperature, maxTokens: TOKENS[settings().length] })

  return {
    clean,
    wrap(engine) {
      if (!engine) return null
      async function* stream(m: readonly ChatMessage[], o?: StreamOptions): AsyncGenerator<ChatEvent, ChatResult> {
        const level = settings().flaws
        let raw = ''
        let shown = ''
        let pending = ''
        let n = 0
        const words = (text: string, final: boolean) => {
          pending += text
          const cut = final ? pending.length : Math.max(pending.lastIndexOf(' '), pending.lastIndexOf('\n')) + 1
          const ready = pending.slice(0, cut)
          pending = pending.slice(cut)
          return ready.replace(/[a-z']+/gi, (w) => flaw(w, level, ++n + raw.length))
        }
        const it = engine!.stream(rewrite(m), opts(o))
        for (;;) {
          const r = await it.next()
          if (r.done) {
            const tail = words('', true)
            shown += tail
            if (tail) yield { type: 'text', text: tail }
            cleanOf.set(shown.trim(), raw)
            return { ...r.value, text: shown }
          }
          const e = r.value
          if (e.type === 'text') {
            raw += e.text
            const out = words(e.text, false)
            shown += out
            if (out) yield { type: 'text', text: out }
          } else if (e.type === 'done') {
            const tail = words('', true)
            shown += tail
            if (tail) yield { type: 'text', text: tail }
            cleanOf.set(shown.trim(), raw)
            yield { type: 'done', result: { ...e.result, text: shown } }
          } else yield e
        }
      }
      return {
        id: engine.id,
        provider: engine.provider,
        caps: engine.caps,
        stream,
        complete: (m, o) => engine.complete(rewrite(m), opts(o)),
        dispose: () => engine.dispose(),
      }
    },
  }
}
