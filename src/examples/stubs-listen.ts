// Stand in runtimes for the listen examples, under ?stub only: what
// jobLoader("transcribe") and jobLoader("voice") resolve to, written in code.
import type { Job, Transcriber } from '@hackbuild/ai-views'
import type { PcmEngine, Timed } from '@hackbuild/speak'
import type { ExampleDef } from './registry'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const LINES: Record<string, string[]> = {
  transcribe: ['stand in line one. no model ran.', 'stand in line two, from the gate.', 'stand in line three.'],
  dictate: ['stand in words from the gate. no model ran.'],
}

/** A hum shaped like speech, one swell per syllable, with the word timings a speech engine reports. */
export function codeVoice(text: string, rate = 22050): { samples: Float32Array; words: Timed[] } {
  const words: Timed[] = []
  let t = 0.08
  for (const m of text.matchAll(/[a-z0-9']+/gi)) {
    const syl = Math.max(1, (m[0].match(/[aeiouy]+/gi) ?? []).length)
    const d = 0.16 + syl * 0.13
    words.push({ t0: t, t1: t + d, start: m.index!, end: m.index! + m[0].length })
    t += d + (/[.,]/.test(text[m.index! + m[0].length] ?? '') ? 0.22 : 0.06)
  }
  const length = Math.ceil((t + 0.1) * rate)
  const out = new Float32Array(length)
  // overtones near the first two formants of an open vowel, 700 and 1200 hz
  const gain = (hz: number) => Math.exp(-(((hz - 700) / 260) ** 2)) + 0.6 * Math.exp(-(((hz - 1200) / 320) ** 2)) + 0.25 / (1 + hz / 300)
  let phase = 0
  for (const w of words) {
    const syl = Math.max(1, Math.round((w.t1 - w.t0 - 0.16) / 0.13))
    for (let i = Math.floor(w.t0 * rate); i < Math.min(length, Math.ceil(w.t1 * rate)); i++) {
      const u = (i / rate - w.t0) / (w.t1 - w.t0)
      const f0 = 128 - 14 * u
      phase += (2 * Math.PI * f0) / rate
      const env = Math.sin(Math.PI * u) * (0.55 + 0.45 * Math.abs(Math.sin(Math.PI * u * syl)))
      let v = 0
      for (let k = 1; k * f0 < 3000; k++) v += gain(k * f0) * Math.sin(k * phase)
      out[i] = 0.12 * env * v
    }
  }
  return { samples: out, words }
}

const voice: PcmEngine = {
  kind: 'pcm',
  id: 'stand-in-voice',
  licence: 'written in code',
  load: async () => undefined,
  async *synth(text) {
    const { samples, words } = codeVoice(text)
    yield { samples, sampleRate: 22050, words }
  },
}

export function runtimeFor(job: Job, def: ExampleDef): unknown {
  if (job === 'voice') return voice
  if (job === 'transcribe') {
    const lines = LINES[def.id] ?? LINES.transcribe!
    const run: Transcriber = async (_file, ctx) => {
      for (let f = 0.25; f <= 1; f += 0.25) {
        await sleep(120)
        ctx.onProgress(f)
      }
      return { segments: lines.map((text, i) => ({ start: i * 3, end: i * 3 + 2.6, text })), duration: lines.length * 3, language: 'en', model: 'stand in' }
    }
    return run
  }
  return undefined
}
