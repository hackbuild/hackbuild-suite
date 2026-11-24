// The speech document kind (design 3.3): a script is the text, the engine
// and voice it was said with, the word times of the last saved render and
// the runs of this script. Saved as `.hbspeech.json`; a txt or srt dropped
// on the window opens as a script; word timing exports as json for the
// lipsync tool. Framework free, so the tests run it in node.
import type { DocKind } from '../workspace/kinds.ts'

export const SPEECH_KIND = 'speak.script'
/** The engine a new script starts on: the system voice needs no download. */
export const FIRST_ENGINE = 'web-speech'
/** Runs kept per script, newest first. */
export const RUNS_CAP = 8

export interface WordTime {
  /** Offsets in `text`, end exclusive. */
  start: number
  end: number
  /** Seconds from the start of the render. */
  t0: number
  t1: number
  /** Guessed from text length; the engine reported no word times. */
  estimated: boolean
}

export interface SpeechRun {
  id: string
  text: string
  engine: string
  voice: string
  rate: number
  pitch: number
  at: number
  /** Seconds, measured from the render; null when said live with no render. */
  duration: number | null
  /** Loudest sample per bin, 0 to 1, for the run thumb. */
  peaks: number[]
}

export interface SpeechBody {
  text: string
  engine: string
  voice: string
  rate: number
  pitch: number
  /** Word times of the last saved render, with the engine that made them. */
  timing: { engine: string; sampleRate: number; duration: number; words: WordTime[] } | null
  runs: SpeechRun[]
}

export const newScript = (): SpeechBody => ({ text: '', engine: FIRST_ENGINE, voice: '', rate: 1, pitch: 1, timing: null, runs: [] })

/** Lines from a txt or an srt: cue numbers and time lines dropped, one line per cue. */
export function linesFrom(text: string): string {
  const srt = /-->/.test(text)
  return text
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !(srt && (/^\d+$/.test(l) || /-->/.test(l) || /^WEBVTT/.test(l))))
    .join('\n')
}

/** Peaks of a render folded to `bins`, 0 to 1. */
export function peaksOf(samples: Float32Array, bins = 24): number[] {
  const out: number[] = []
  const step = Math.max(1, Math.floor(samples.length / bins))
  for (let b = 0; b < bins; b++) {
    let m = 0
    for (let i = b * step; i < Math.min(samples.length, (b + 1) * step); i++) m = Math.max(m, Math.abs(samples[i]!))
    out.push(+Math.min(1, m).toFixed(3))
  }
  return out
}

/** A run thumb for the history strip: the peaks as bars in an svg data url. */
export function runThumb(peaks: readonly number[]): string {
  const top = Math.max(0.0001, ...peaks)
  const bars = peaks.map((p, i) => {
    const h = Math.max(2, Math.round((p / top) * 40))
    return `<rect x="${i * 4 + 1}" y="${24 - h / 2}" width="2" height="${h}"/>`
  })
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(1, peaks.length) * 4} 48">${bars.join('')}</svg>`)}`
}

/** Push a run, newest first, capped. */
export const withRun = (runs: readonly SpeechRun[], r: SpeechRun): SpeechRun[] => [r, ...runs.filter((x) => x.id !== r.id)].slice(0, RUNS_CAP)

function check(b: unknown): string | null {
  const s = b as Partial<SpeechBody> | null
  if (!s || typeof s !== 'object') return 'a script is an object.'
  if (typeof s.text !== 'string') return 'a script has no text.'
  if (typeof s.engine !== 'string') return 'a script names no engine.'
  if (!Array.isArray(s.runs)) return 'a script has no run list.'
  return null
}

export const speechKind: DocKind<SpeechBody> = {
  kind: SPEECH_KIND,
  tool: 'speak',
  label: 'script',
  ext: '.hbspeech.json',
  version: 1,
  create: newScript,
  check,
  models: (b) => [b.engine],
  imports: [
    {
      accept: '.txt,.srt,text/plain',
      label: 'open as a script to speak',
      async read(file) {
        const text = linesFrom(await file.text())
        if (!text) throw new Error(`${file.name} has no lines to speak.`)
        return { name: file.name.replace(/\.(txt|srt)$/i, ''), body: { ...newScript(), text } }
      },
    },
  ],
  exports: [
    {
      key: 'timing',
      label: 'word timing',
      ext: '.timing.json',
      note: 'word times of the last saved wav, for the lipsync tool.',
      type: 'application/json',
      write: (b) => JSON.stringify({ text: b.text, ...(b.timing ?? { engine: b.engine, sampleRate: 0, duration: 0, words: [] }), words: (b.timing?.words ?? []).map((w) => ({ ...w, text: b.text.slice(w.start, w.end) })) }, null, 2),
    },
    { key: 'txt', label: 'text', ext: '.txt', copy: true, write: (b) => b.text },
  ],
}
