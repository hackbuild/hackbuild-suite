// Viseme tracks for the lipsync tool, made with @hackbuild/lipsync: from a
// line of text (words spread by syllables), from audio samples (the level
// and three formant bands per frame, with timed words on top when speech
// sent them), and frame by frame from a live level (the mic). Every track
// is sampled at one rate, so the strip, the mouth and the export read the
// same frames. Framework free; the tests run it in node.
import { LipSync, bandsFromSpectrum, estimateWords, rms, syllables, type Bands, type SpeechEvent } from '@hackbuild/lipsync'
import { VISEMES, type SourceKind, type Track } from './kind.ts'

/** Frames a second of every track (proposed: one per display frame at 60 Hz). */
export const FPS = 60
/** Seconds of quiet before and after a line (proposed). */
const PAD = 0.25
/** Seconds a syllable takes when only text is known (inferred, about 4 a second in speech). */
const SYLLABLE = 0.24

export interface TimedWord { text: string; t0: number; t1: number }

const SOURCE = { silent: 0, timeline: 1, energy: 2 } as const

/** A track recorder: one LipSync stepped at FPS. */
export class TrackWriter {
  readonly lip: LipSync
  private frames: number[] = []
  private sources: number[] = []
  constructor(lead = 0.04, strength = 1) {
    this.lip = new LipSync({ lead, strength })
  }
  get length() { return this.sources.length }
  /** One frame at time t with the level and bands of that frame, if any. */
  step(level = 0, bands?: Bands): Float32Array {
    const t = this.sources.length / FPS
    this.lip.setLevel(level, bands)
    const f = this.lip.update(t, 1 / FPS)
    this.frames.push(...f.visemes)
    this.sources.push(SOURCE[f.source])
    return f.visemes
  }
  done(name: string, kind: SourceKind): Track {
    return { fps: FPS, frames: Float32Array.from(this.frames), sources: Uint8Array.from(this.sources), name, kind }
  }
}

/** Seconds a line takes when said at a talking pace. */
export const lineSeconds = (text: string): number =>
  text.split(/\s+/).filter((w) => /[a-z]/i.test(w)).reduce((s, w) => s + (syllables(w) + 0.5) * SYLLABLE, 0)

/** A track from text alone: words spread over the line by syllables. */
export function fromText(text: string, lead = 0.04, name = 'line'): Track {
  const say = lineSeconds(text)
  const w = new TrackWriter(lead)
  w.lip.push(estimateWords(text, PAD, PAD + say))
  const n = Math.ceil((say + 2 * PAD) * FPS)
  for (let i = 0; i < n; i++) w.step()
  return w.done(name, 'text')
}

// ------------------------------------------------------------- audio

/** In place radix 2 FFT magnitude in dB, as AnalyserNode.getFloatFrequencyData reads. */
function spectrumDb(win: Float32Array, out: Float32Array): void {
  const n = win.length
  const re = Float64Array.from(win, (v, i) => v * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))))
  const im = new Float64Array(n)
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const t = re[i]!; re[i] = re[j]!; re[j] = t }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (-2 * Math.PI) / len
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(a * k)
        const s = Math.sin(a * k)
        const xr = re[i + k + len / 2]! * c - im[i + k + len / 2]! * s
        const xi = re[i + k + len / 2]! * s + im[i + k + len / 2]! * c
        re[i + k + len / 2] = re[i + k]! - xr
        im[i + k + len / 2] = im[i + k]! - xi
        re[i + k] = re[i + k]! + xr
        im[i + k] = im[i + k]! + xi
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = 20 * Math.log10(Math.hypot(re[i]!, im[i]!) / (n / 2) + 1e-12)
}

const FFT = 512
/** Frame level the loud part of a file is scaled to (proposed: the mouth fully open at the library's default gain). */
const LOUD = 0.16

/**
 * A track from mono samples: per frame the level and three bands move the
 * mouth; timed words from a speech engine, when given, take over where they
 * cover.
 */
export function fromSamples(samples: Float32Array, rate: number, opts: { name: string; kind: SourceKind; words?: readonly TimedWord[]; lead?: number }): Track {
  const w = new TrackWriter(opts.lead ?? 0.04)
  if (opts.words?.length) {
    const ev: SpeechEvent[] = opts.words.map((x) => ({ type: 'word', time: x.t0, end: x.t1, text: x.text }))
    w.lip.push(ev)
  }
  const hop = rate / FPS
  const n = Math.ceil(samples.length / hop)
  const levels = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const at = Math.floor(i * hop)
    levels[i] = rms(samples.subarray(at, Math.min(samples.length, at + Math.ceil(hop))))
  }
  // a quiet recording opens the mouth as far as a loud one: the 95th
  // percentile frame level is brought to LOUD, never more than 4 times up
  const p95 = Float32Array.from(levels).sort()[Math.floor(n * 0.95)] ?? 0
  const scale = p95 > 0.03 ? Math.min(4, LOUD / p95) : 1
  const win = new Float32Array(FFT)
  const spec = new Float32Array(FFT / 2)
  for (let i = 0; i < n; i++) {
    const at = Math.floor(i * hop)
    const level = levels[i]! * scale
    win.fill(0)
    win.set(samples.subarray(Math.max(0, at + Math.floor(hop / 2) - FFT / 2), Math.max(0, at + Math.floor(hop / 2) - FFT / 2) + FFT))
    spectrumDb(win, spec)
    w.step(level, bandsFromSpectrum(spec, rate, FFT))
  }
  return w.done(opts.name, opts.kind)
}

/** Share of frames whose strongest viseme is not sil. */
export function voiced(t: Track): number {
  let v = 0
  const n = t.sources.length
  for (let i = 0; i < n; i++) {
    let m = 0
    for (let k = 1; k < VISEMES.length; k++) m = Math.max(m, t.frames[i * VISEMES.length + k]!)
    if (m >= 0.05) v++
  }
  return n ? v / n : 0
}

/** Mono samples from a wav or other audio file: the wav reader first, then the browser's decoder. */
export async function readAudio(file: Blob & { name?: string }): Promise<{ samples: Float32Array; rate: number }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const riff = bytes.length > 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
  if (riff) {
    try {
      const { decodeWav } = await import('@hackbuild/audio-dsp')
      const d = decodeWav(bytes)
      const mono = d.channels[0]
      if (mono) return { samples: mono, rate: d.sampleRate }
    } catch { /* the browser's decoder tries next */ }
  }
  const Ctx = globalThis.OfflineAudioContext
  if (!Ctx) throw new Error('no audio decoder here')
  const ctx = new Ctx(1, 1, 44100)
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(0) as ArrayBuffer)
  return { samples: buf.getChannelData(0), rate: buf.sampleRate }
}
