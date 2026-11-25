// Mic dictation into a text box (P-VIN-1, design 3.7): the system speech
// recognizer of @hackbuild/listen with interim words written into the box
// as they come, committed on the final, and a self hearing gate that drops
// results while any suite voice speaks and for 400 ms after (inferred).
// Under ?stub a scripted recognizer stands in, so smokes reach no service.
// The listen package loads on the first press. Framework free.
import type { MicState } from '@virgilvox/hackbuild-ui/vanilla'
import type { DictateTarget, Interim, SelfGate, SpeechEngine } from '@hackbuild/listen'

const STUB = typeof location !== 'undefined' && new URLSearchParams(location.search).has('stub')
export const TAIL_MS = 400
/** What the ?stub recognizer hears, word by word. */
export const STUB_WORDS = 'what is on the shelf'

let gate: SelfGate | null = null
let talking = false
/** A suite voice started or stopped: the gate closes while it speaks. Call from a speaker's onSpeaking. */
export function setSpeaking(on: boolean): void {
  talking = on
  gate?.setSpeaking(on)
}

type Result = { transcript: string }[] & { isFinal: boolean }
/** A recognizer that hears STUB_WORDS one word at a time, then ends the result. */
class StubRecognition {
  lang = 'en-US'
  continuous = true
  interimResults = true
  onresult: ((ev: { resultIndex: number; results: Result[] }) => void) | null = null
  onerror: ((ev: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  private timers: ReturnType<typeof setTimeout>[] = []
  start(): void {
    const words = STUB_WORDS.split(' ')
    const res = (text: string, isFinal: boolean) => Object.assign([{ transcript: text }], { isFinal }) as Result
    words.forEach((_, i) => this.timers.push(setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res(words.slice(0, i + 1).join(' '), false)] }), 300 * (i + 1))))
    this.timers.push(setTimeout(() => this.onresult?.({ resultIndex: 0, results: [res(STUB_WORDS, true)] }), 300 * (words.length + 2)))
  }
  stop(): void {
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    this.onend?.()
  }
}

export interface DictationHooks {
  state(s: MicState): void
  /** Interim words on screen, for a status line. */
  interim?(i: Interim): void
  /** The final words landed in the box. */
  committed?(value: string): void
  failed?(message: string): void
}

export interface Dictator {
  stop(): void
}

/** Start dictating into `target`. The words stay in the box for the person to send. */
export async function startDictation(target: DictateTarget, hooks: DictationHooks): Promise<Dictator> {
  const { dictate, selfGate, speechEngine } = await import('@hackbuild/listen')
  gate ??= selfGate({ tailMs: TAIL_MS })
  gate.setSpeaking(talking)
  const d = dictate(target, { onCommit: (v) => hooks.committed?.(v) })
  let engine: SpeechEngine | null = null
  engine = speechEngine({
    gate,
    ...(STUB ? { Recognition: StubRecognition as never } : {}),
    onInterim: (i) => {
      d.interim(i)
      hooks.interim?.(i)
      hooks.state('hearing')
    },
    onFinal: (t) => {
      d.final(t)
      hooks.state('listening')
    },
    onState: (s) => {
      if (s === 'listening') hooks.state('listening')
      else if (s === 'denied') {
        hooks.state('blocked')
        hooks.failed?.('the mic is blocked. type instead, or allow it in the address bar.')
      } else if (s === 'unsupported') {
        hooks.state('unsupported')
        hooks.failed?.('this browser has no speech recognition. type instead.')
      } else hooks.state('off')
    },
    onError: (e) => { if (e !== 'no-speech' && e !== 'aborted') hooks.failed?.(`speech recognition stopped: ${e}.`) },
  })
  engine.start()
  return {
    stop() {
      if (d.active) d.cancel()
      engine?.stop()
      engine = null
    },
  }
}
