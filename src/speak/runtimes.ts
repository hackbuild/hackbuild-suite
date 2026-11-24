// The speech runtimes on the one hub (design 2.2, 3.3). The voice rows of
// @hackbuild/speak join the catalogue and each provider gets a factory
// that returns a loaded engine. Under ?stub every provider returns the
// tone voice: one short tone per word with real word times, so playback,
// the word highlight and the wav export run with no weight and no fetch.
//
// Kokoro stays opt in (design 6.3 item 4): its runtime phonemizes with a
// GPL-3.0-or-later phonemizer, so the factory refuses until the kokoro
// switch in voice settings is on, and only then fetches kokoro-js.
import type { FactoryContext, ModelRecord } from '@hackbuild/models'
import type { Engine, PcmChunk, PcmEngine, Timed } from '@hackbuild/speak'
import { wordSpans } from '@hackbuild/speak'

/** Engine rows in the order the cards show them. */
export const SPEAK_ORDER = ['web-speech', 'bellows-voice', 'pocket-tts', 'kokoro-82m'] as const
export const KOKORO_ID = 'kokoro-82m'
export const SYSTEM_ID = 'web-speech'

/** The trade of each engine, on its card (P-VOUT-1, P-MODEL-14). Times are inferred from earlier builds. */
export const TRADES: Record<string, { trade: string; time: string; quality: number }> = {
  'web-speech': { trade: 'speaks at once with a voice of this system. no download. it plays live, so it cannot save a wav.', time: 'at once', quality: 1 },
  'bellows-voice': { trade: 'a modelled vocal tract, no weights. robotic, exact phoneme times, saves a wav.', time: 'under 1 s', quality: 1 },
  'pocket-tts': { trade: 'a neural voice in a worker, with clones. a download, then natural speech.', time: 'about 2 s', quality: 3 },
  // kokoro's time sits in its trade: the meta row of a method card does not wrap at 320 px (hackbuild-ui gap)
  'kokoro-82m': { trade: 'the most natural voice here. it speaks after the full line is made. a gpl phonemizer.', time: '', quality: 3 },
}

const BELLOWS_URL = 'https://cdn.jsdelivr.net/npm/bellows-voice@0.8.0/engine/+esm'
const KOKORO_URL = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/+esm'

export const KOKORO_OFF = 'kokoro is off. its phonemizer is gpl, so it loads only if you turn it on in settings.'

/**
 * The stub voice: a tone per word at a pitch that steps with the word, a
 * short rest between words, and the word times it really played. No
 * weights, deterministic, renders offline.
 */
export function toneEngine(id = 'tone', o: { rate?: number; secPerChar?: number; restSec?: number } = {}): PcmEngine {
  const sr = o.rate ?? 24000
  const spc = o.secPerChar ?? 0.055
  const rest = o.restSec ?? 0.06
  return {
    kind: 'pcm',
    id,
    licence: 'none, no weights',
    async load() {},
    async *synth(text, cfg, signal): AsyncGenerator<PcmChunk> {
      const speed = cfg.rate ?? 1
      const pitch = cfg.pitch ?? 1
      const words: Timed[] = []
      const parts: Float32Array[] = []
      let t = 0
      wordSpans(text).forEach((w, i) => {
        const dur = Math.max(0.08, ((w.end - w.start) * spc) / speed)
        const n = Math.round(dur * sr)
        const hz = (200 + (i % 5) * 40) * pitch
        const s = new Float32Array(n + Math.round(rest * sr))
        for (let k = 0; k < n; k++) {
          const env = Math.min(1, k / 240, (n - k) / 240)
          s[k] = 0.2 * env * Math.sin((2 * Math.PI * hz * k) / sr)
        }
        words.push({ start: w.start, end: w.end, t0: t, t1: t + dur })
        parts.push(s)
        t += s.length / sr
      })
      // one chunk per word, so playback starts on the first and the times stay chunk relative
      let at = 0
      for (let i = 0; i < parts.length; i++) {
        if (signal.aborted) return
        await Promise.resolve()
        const w = words[i]!
        yield { samples: parts[i]!, sampleRate: sr, words: [{ ...w, t0: w.t0 - at, t1: w.t1 - at }] }
        at += parts[i]!.length / sr
      }
    },
    voices: () => ['tone'],
  }
}

async function report(ctx: FactoryContext, steps = 3): Promise<void> {
  for (let i = 1; i <= steps; i++) {
    if (ctx.signal?.aborted) throw new DOMException('stopped', 'AbortError')
    await new Promise((r) => setTimeout(r, 80))
    ctx.report('fetch', i / steps)
  }
}

let added = false
/** Add the voice rows and a factory per voice provider. Safe to call more than once. */
export async function addSpeakRuntimes(o: { kokoro: () => boolean }): Promise<void> {
  if (added) return
  added = true
  const [speak, hub] = await Promise.all([import('@hackbuild/speak'), import('../models/hub.ts')])
  hub.addRows(speak.SPEAK_RECORDS)
  const providers = new Set(speak.SPEAK_RECORDS.map((r: ModelRecord) => r.provider))
  if (hub.STUB) {
    for (const p of providers) {
      hub.provideRuntime(p, async (ctx: FactoryContext) => {
        if (ctx.record.id === KOKORO_ID && !o.kokoro()) throw new Error(KOKORO_OFF)
        await report(ctx)
        return toneEngine(ctx.record.id)
      })
    }
    return
  }
  const { runtimeLoader } = await import('@hackbuild/devices')
  const loaded = async (ctx: FactoryContext, e: Engine): Promise<Engine> => {
    await e.load({ ...(ctx.signal ? { signal: ctx.signal } : {}), onStatus: (s) => { if (s.progress !== undefined) ctx.report('fetch', s.progress) } })
    return e
  }
  hub.provideRuntime('system', (ctx: FactoryContext) => loaded(ctx, speak.webSpeechEngine()))
  hub.provideRuntime('bellows-voice', (ctx: FactoryContext) => loaded(ctx, speak.bellowsEngine({ runtime: runtimeLoader([BELLOWS_URL]), rng: Math.random })))
  hub.provideRuntime('pocket-worker', (ctx: FactoryContext) => loaded(ctx, speak.pocketEngine({})))
  hub.provideRuntime('kokoro-js', async (ctx: FactoryContext) => {
    // the switch is the opt in: without it the gpl phonemizer is never fetched
    if (!o.kokoro()) throw new Error(KOKORO_OFF)
    return loaded(ctx, speak.kokoroEngine({ runtime: runtimeLoader([KOKORO_URL]), allowGplPhonemizer: true }))
  })
}
