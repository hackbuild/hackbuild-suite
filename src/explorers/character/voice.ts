// The voice: lines spoken one after another through the loaded engine, the
// mouth on the stage moving with the audio and the word times it reports,
// and the voice clone of a pocket engine from a file or ten seconds of mic.
import { prepareClone, renderSpeech, renderedBuffer, renderedWav, toMono, type Engine, type PocketEngine, type VoiceConfig } from '@hackbuild/speak'
import type { CharacterStageHandle, Speech } from '@hackbuild/motion-views/vanilla'

export const canClone = (e: unknown): e is PocketEngine => !!e && typeof (e as PocketEngine).cloneVoice === 'function'

export interface Voice {
  /** Queues a line; resolves when it has been said or dropped. */
  say(text: string): Promise<void>
  stop(): void
  /** Clones from an audio file; resolves to seconds of reference used. */
  cloneFile(file: Blob): Promise<number>
  /** Records `seconds` of mic and clones from it. */
  cloneMic(seconds: number, onTick?: (left: number) => void): Promise<number>
  /** The prepared reference as a wav, or null with no clone. */
  cloneWav(): Blob | null
  clearClone(): void
  readonly cloned: boolean
}

export function voice(engine: () => Engine | null, stage: () => CharacterStageHandle | null, onLine?: (text: string) => void): Voice {
  let ac: AudioContext | null = null
  let chain: Promise<void> = Promise.resolve()
  let ctl = new AbortController()
  let ref: Float32Array | null = null
  let config: VoiceConfig = {}
  const audio = () => (ac ??= new AudioContext())

  const speak = async (text: string, signal: AbortSignal) => {
    const e = engine()
    const s = stage()
    if (signal.aborted || !s) return
    onLine?.(text)
    if (!e) return void (await s.say({ text }))
    if (e.kind === 'native') {
      void e.speak(text, config, { onBoundary: () => undefined }, signal)
      return void (await s.say({ text }))
    }
    const r = await renderSpeech(e, text, { voice: config, signal })
    if (signal.aborted) return
    const speech: Speech = { text, audio: renderedBuffer(audio(), r), words: r.words, phonemes: r.phonemes }
    await s.say(speech)
  }

  const decode = async (blob: Blob) => {
    const buf = await audio().decodeAudioData(await blob.arrayBuffer())
    const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i))
    return { samples: toMono(chans), rate: buf.sampleRate }
  }
  const clone = async (samples: Float32Array, rate: number) => {
    const e = engine()
    if (!canClone(e)) throw new Error('this voice cannot clone. load pocket in the voice list first.')
    ref = prepareClone(samples, rate)
    await e.cloneVoice(ref, 24000)
    config = { voice: 'custom' }
    return ref.length / 24000
  }

  return {
    get cloned() { return !!ref },
    say(text) {
      const signal = ctl.signal
      chain = chain.then(() => speak(text, signal)).catch(() => undefined)
      return chain
    },
    stop() {
      ctl.abort()
      ctl = new AbortController()
      chain = Promise.resolve()
      stage()?.stop()
    },
    async cloneFile(file) {
      const { samples, rate } = await decode(file)
      return clone(samples, rate)
    },
    async cloneMic(seconds, onTick) {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(media)
      const parts: Blob[] = []
      rec.ondataavailable = (ev) => parts.push(ev.data)
      const done = new Promise<void>((ok) => (rec.onstop = () => ok()))
      rec.start()
      for (let left = seconds; left > 0; left--) {
        onTick?.(left)
        await new Promise((r) => setTimeout(r, 1000))
      }
      rec.stop()
      await done
      media.getTracks().forEach((t) => t.stop())
      const { samples, rate } = await decode(new Blob(parts, { type: rec.mimeType }))
      return clone(samples, rate)
    },
    cloneWav() {
      if (!ref) return null
      return renderedWav({ samples: ref, sampleRate: 24000, duration: ref.length / 24000, engine: 'clone', words: [], phonemes: [] })
    },
    clearClone() {
      ref = null
      config = {}
    },
  }
}
