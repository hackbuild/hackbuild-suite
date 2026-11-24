// The transcript document kind (design 3.2): one recording and its
// transcript per document, saved as `.hbtranscript.json`, with the
// settings and model of its run and the lines the filter dropped. A
// dropped recording becomes a queued document through the window drop
// router; an srt, vtt or transcript json opens as a document to edit.
// Framework free, so the tests run it in node.
import { toLrc } from '@hackbuild/audio-dsp'
import { acceptsFile, asJson, asSrt, asTxt, asVtt, importTranscript, type Dropped, type Seg, type Transcript } from '@hackbuild/transcribe'
import type { DocKind } from '../workspace/kinds.ts'

export const TRANSCRIPT_KIND = 'transcribe.transcript'

/** The capture settings of a run (P-STT-6), the earlier tool's defaults. */
export interface Capture {
  targetDb: number
  maxGainDb: number
  denoise: 0 | 1 | 2 | 3
  vadMargin: number
  skipSilence: boolean
  /** The phantom text filter. */
  halluc: boolean
}
export const CAPTURE: Capture = { targetDb: -20, maxGainDb: 45, denoise: 2, vadMargin: 6, skipSilence: true, halluc: true }

/** The level rail folded to bins, small enough to keep in the document. */
export interface RailSketch {
  /** Loudest frame per bin, dBFS (computed). */
  db: number[]
  /** 1 where the gate kept most of the bin. */
  kept: number[]
  duration: number
  noiseDb: number
  thrDb: number
  loudDb: number
}

export type TranscriptState = 'queued' | 'done' | 'empty' | 'failed'

export interface TranscriptBody {
  /** The file the audio came from. */
  source: string
  /** The recording, stored local only, or null for an imported transcript. */
  audio: { $blob: string } | null
  type: string
  size: number
  state: TranscriptState
  error: string | null
  /** Record id and language of the run that made the segments. */
  model: string
  language: string
  segments: Seg[]
  dropped: Dropped[]
  stats: Transcript['stats'] | null
  rail: RailSketch | null
  capture: Capture
}

export function emptyBody(o: Partial<TranscriptBody> = {}): TranscriptBody {
  return {
    source: '', audio: null, type: '', size: 0, state: 'queued', error: null, model: '', language: 'auto',
    segments: [], dropped: [], stats: null, rail: null, capture: { ...CAPTURE }, ...o,
  }
}

/** Fold a run's level rail to `bins` bins for the document. */
export function sketch(rail: Transcript['rail'], bins = 480): RailSketch {
  const n = Math.max(1, Math.min(bins, rail.db.length))
  const db = new Array<number>(n).fill(-90)
  const kept = new Array<number>(n).fill(0)
  const count = new Array<number>(n).fill(0)
  for (let i = 0; i < rail.db.length; i++) {
    const b = Math.min(n - 1, Math.floor((i * n) / rail.db.length))
    db[b] = Math.max(db[b]!, rail.db[i]!)
    kept[b]! += rail.open[i]!
    count[b]!++
  }
  return {
    db: db.map((x) => Math.round(x * 10) / 10),
    kept: kept.map((k, b) => (count[b] && k / count[b]! >= 0.5 ? 1 : 0)),
    duration: rail.duration, noiseDb: rail.noiseDb, thrDb: rail.thrDb, loudDb: rail.loudDb,
  }
}

/** A finished run as the document body; the audio and capture stay. */
export function withRun(b: TranscriptBody, t: Transcript): TranscriptBody {
  return {
    ...b, state: t.segments.length ? 'done' : 'empty', error: null, model: t.model, language: t.language,
    segments: t.segments, dropped: t.dropped, stats: t.stats, rail: sketch(t.rail),
  }
}

/** The fields the library exporters read. */
export const docOf = (b: TranscriptBody) => ({
  source: b.source, segments: b.segments, dropped: b.dropped, stats: b.stats, model: b.model || 'unknown', language: b.language,
  ...(b.stats ? { duration: b.stats.dur } : b.rail ? { duration: b.rail.duration } : {}),
})

const AV = '.mp4,.m4v,.mov,.webm,.mkv,.avi,.mpg,.mpeg,.ogv,.m4a,.mp3,.wav,.flac,.ogg,.opus,.aac,.wma,.3gp'
const stem = (n: string) => n.replace(/\.[^.]+$/, '') || n

/** Stores a dropped recording and returns its hash; the suite passes the workspace's putBlob. */
export type PutBlob = (data: Uint8Array, meta: { name: string; type: string; local?: boolean }) => Promise<string>

export function transcriptKind(putBlob: PutBlob): DocKind<TranscriptBody> {
  return {
    kind: TRANSCRIPT_KIND,
    tool: 'transcribe',
    label: 'transcript',
    ext: '.hbtranscript.json',
    version: 1,
    create: () => emptyBody(),
    check(body) {
      const b = body as Partial<TranscriptBody> | null
      if (!b || typeof b !== 'object') return 'the body is not an object.'
      if (!Array.isArray(b.segments)) return 'it has no segments list.'
      if (b.segments.some((s) => typeof s?.start !== 'number' || typeof s?.end !== 'number' || typeof s?.text !== 'string')) return 'a segment has no start, end or text.'
      return null
    },
    models: (b) => (b.model ? [b.model] : []),
    imports: [
      {
        accept: `audio/*,video/*,${AV}`,
        label: 'transcribe this recording',
        async read(file) {
          if (!acceptsFile(file)) throw new Error(`${file.name} is not audio or video.`)
          const data = new Uint8Array(await file.arrayBuffer())
          // a recording is the person's own: it leaves an export only when they tick the box
          const hash = await putBlob(data, { name: file.name, type: file.type, local: true })
          return { name: stem(file.name), body: emptyBody({ source: file.name, audio: { $blob: hash }, type: file.type, size: file.size }) }
        },
      },
      {
        accept: '.srt,.vtt,.json',
        label: 'open as a transcript',
        async read(file) {
          const t = importTranscript(file.name, await file.text(), { speakers: true })
          return {
            name: stem(file.name),
            body: emptyBody({
              source: t.source || file.name, state: t.segments.length ? 'done' : 'empty', model: t.model || `imported ${t.format}`,
              language: t.language || 'auto', segments: [...t.segments], dropped: [...(t.dropped ?? [])],
            }),
          }
        },
      },
    ],
    exports: [
      { key: 'txt', label: 'txt', ext: '.txt', copy: true, note: 'one line per segment with its time.', write: (b) => asTxt(b.segments) },
      { key: 'srt', label: 'srt', ext: '.srt', copy: true, note: 'subtitles for a video player.', write: (b) => asSrt(b.segments) },
      { key: 'vtt', label: 'vtt', ext: '.vtt', copy: true, note: 'web subtitles; speakers as voice tags.', write: (b) => asVtt(b.segments) },
      { key: 'json', label: 'json', ext: '.json', copy: true, type: 'application/json', note: 'segments, dropped lines with the reason, model, language and levels.', write: (b) => asJson(docOf(b)) },
      { key: 'lrc', label: 'lrc', ext: '.lrc', copy: true, note: 'timed lyrics.', write: (b, name) => toLrc(b.segments, name) },
    ],
  }
}
