// The ears (design 3.9 step 13, F-8 step 6): the mic through the listen
// package. Hands free, the energy gate finds each utterance and a pause
// sends it; push to talk, the mic is heard only while the button is held
// and the release ends the utterance. While the character speaks the gate
// takes the stricter bar, so its own voice from the speakers is not heard,
// and an utterance that began while it spoke, or within GATE_MS after, is
// dropped. Words heard so far come through `interim` every 0.8 s of new
// audio (vendor default), replaced by the next, until the utterance ends.
// The transcriber is the hub's speech to text row. Framework free.
import type { MicState } from '@virgilvox/hackbuild-ui/vanilla'
import type { Interim, Transcriber } from '@hackbuild/listen'

/** Drop an utterance that began this soon after the voice stopped, ms (inferred). */
export const GATE_MS = 400

export interface EarsHooks {
  state(s: MicState): void
  level(v: number): void
  /** The words of one utterance, after the phantom filter. */
  heard(text: string): void
  /** Words heard so far in the utterance in progress. */
  interim?(i: Interim): void
  /** An utterance the filter dropped, with the reason. */
  dropped(why: string): void
  failed(message: string): void
}

export interface Ears {
  /** Hands free on: every pause sends. Off: push to talk. */
  setHandsFree(on: boolean): void
  /** Push to talk: hold. */
  press(): void
  /** Push to talk: release; the utterance ends here. */
  release(): Promise<void>
  setTalking(on: boolean): void
  stop(): void
}

/** Open the mic and start the listener. Throws a named error when the mic is blocked. */
export async function openEars(ctx: AudioContext, transcribe: Transcriber, hooks: EarsHooks, handsFree: boolean): Promise<Ears> {
  const { createListener, energyVad, openMic, micBlocks, CONVERSATION } = await import('@hackbuild/listen')
  let stream: MediaStream
  try {
    stream = await openMic()
  } catch (e) {
    const name = (e as { name?: string }).name ?? ''
    throw new Error(name === 'NotAllowedError' || name === 'SecurityError' ? 'the mic is blocked. type instead, or allow it in the address bar.' : `the mic did not open: ${e instanceof Error ? e.message : String(e)}`)
  }
  let free = handsFree
  let held = false
  const listener = createListener({
    vad: energyVad(),
    transcribe,
    inputRate: ctx.sampleRate,
    machine: CONVERSATION,
    dropWhileTalking: true,
    gateMs: GATE_MS,
    interim: { everySec: 0.8 },
    onInterim: (i) => hooks.interim?.(i),
    onUtterance: (u) => {
      if (u.dropped) hooks.dropped(u.dropped)
      else if (u.text.trim()) hooks.heard(u.text.trim())
    },
    onState: (s) => hooks.state(s === 'hearing' ? 'hearing' : s === 'stopped' ? 'off' : 'listening'),
    onProb: (p) => hooks.level(p),
    onError: (e) => hooks.failed(e instanceof Error ? e.message : String(e)),
  })
  listener.start()
  const stopBlocks = await micBlocks(ctx, stream, (b) => { if (free || held) listener.push(b) })
  hooks.state(free ? 'listening' : 'off')
  return {
    setHandsFree(on) {
      free = on
      hooks.state(on ? 'listening' : 'off')
    },
    press() {
      held = true
      hooks.state('listening')
    },
    async release() {
      held = false
      await listener.flush()
      if (!free) hooks.state('off')
    },
    setTalking: (on) => listener.setTalking(on),
    stop() {
      listener.stop()
      stopBlocks()
      for (const t of stream.getTracks()) t.stop()
      hooks.state('off')
      hooks.level(0)
    },
  }
}
