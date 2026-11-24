// The image generation document kind (design 3.7): one session holds the
// form (model, prompt, negative prompt, seed and its lock, steps, guidance,
// size) and the runs, newest first, each with its settings, its timing and
// its image. Saved as `.hbimagegen.json`; a settings sidecar
// (`.imagegen.json`) dropped on the window restores that run's settings;
// a png export carries the same settings in a tEXt chunk. Framework free,
// so the tests run it in node.

import type { DocKind } from '../workspace/kinds.ts'

export const GEN_KIND = 'generate.images'
/** Runs kept per session, newest first (GROMMET kept 8). */
export const RUNS_CAP = 8
/** The tEXt keyword the png export writes its settings under. */
export const PNG_KEY = 'hackbuild.imagegen'
export const SIDECAR_EXT = '.imagegen.json'

/** What makes a run again: the form at the moment generate was pressed. */
export interface Settings {
  model: string
  prompt: string
  negative: string
  seed: number
  steps: number
  /** Null when the model takes no guidance. */
  guidance: number | null
  size: number
}

export interface Run extends Settings {
  id: string
  at: number
  /** Measured, per stage and in all. */
  ms: { text: number; unet: number; vae: number; total: number }
  /** A png data url. */
  image: string
}

export interface GenBody extends Settings {
  /** Keep the seed between runs; off rolls a new one after each run. */
  locked: boolean
  runs: Run[]
  current: string | null
  /** The run shown against the current one in the compare wipe. */
  compare: string | null
}

export const DEFAULT_PROMPT = 'a brass ferrule on a workbench, soft window light'

export const newSession = (): GenBody => ({
  model: 'sd-turbo', prompt: DEFAULT_PROMPT, negative: '', seed: 12345, steps: 2, guidance: null, size: 512,
  locked: true, runs: [], current: null, compare: null,
})

/** Push a run, newest first, capped; it becomes the current one and the old current becomes the compare. */
export function withRun(b: GenBody, r: Run): GenBody {
  const runs = [r, ...b.runs.filter((x) => x.id !== r.id)].slice(0, RUNS_CAP)
  const keep = (id: string | null) => (id && runs.some((x) => x.id === id) ? id : null)
  return { ...b, runs, current: r.id, compare: keep(b.current) ?? keep(b.compare) }
}

export const settingsOf = (r: Settings): Settings => ({
  model: r.model, prompt: r.prompt, negative: r.negative, seed: r.seed, steps: r.steps, guidance: r.guidance, size: r.size,
})

/** Put a run's settings back on the form: history reuse. */
export const reuse = (b: GenBody, r: Settings): GenBody => ({ ...b, ...settingsOf(r) })

/** The meta line of a run for the history strip and the log. */
export function runLine(r: Run): string {
  const g = r.guidance === null ? '' : `, guidance ${r.guidance}`
  return `${r.model}, seed ${r.seed}, ${r.steps} ${r.steps === 1 ? 'step' : 'steps'}${g}, ${(r.ms.total / 1000).toFixed(1)} s`
}

/** The sidecar: the settings and timing, no pixels. */
export function sidecar(r: Run): string {
  return JSON.stringify({ tool: 'hackbuild generate', version: 1, ...settingsOf(r), ms: r.ms, at: new Date(r.at).toISOString() }, null, 2)
}

/** Settings read back from a sidecar or a png's text chunk; throws with the copy to show. */
export function readSettings(text: string): Settings {
  let o: Partial<Settings>
  try {
    o = JSON.parse(text) as Partial<Settings>
  } catch {
    throw new Error('the settings file is not json.')
  }
  if (!o || typeof o.prompt !== 'string' || typeof o.model !== 'string') throw new Error('the file holds no prompt or model.')
  if (!Number.isInteger(o.seed) || !Number.isInteger(o.steps)) throw new Error('the file has no whole seed and steps.')
  return {
    model: o.model, prompt: o.prompt, negative: typeof o.negative === 'string' ? o.negative : '', seed: o.seed!, steps: o.steps!,
    guidance: typeof o.guidance === 'number' ? o.guidance : null, size: typeof o.size === 'number' ? o.size : 512,
  }
}

// png text chunks: a tEXt chunk after IHDR carries the settings json.
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array): number {
  let c = 0xffffffff
  for (const x of b) c = CRC[(c ^ x) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const isPng = (b: Uint8Array) => b.length > 33 && SIG.every((v, i) => b[i] === v)
const latin1 = (s: string) => Uint8Array.from(s, (ch) => { const c = ch.charCodeAt(0); return c < 256 ? c : 0x3f })

/** The png with a tEXt chunk `key` holding `text` (latin-1; json escapes the rest) right after IHDR. */
export function pngWithText(png: Uint8Array, key: string, text: string): Uint8Array {
  if (!isPng(png)) throw new Error('not a png.')
  const body = latin1(`${key}\0${text}`)
  const typed = new Uint8Array(4 + body.length)
  typed.set(latin1('tEXt'))
  typed.set(body, 4)
  const chunk = new Uint8Array(12 + body.length)
  const v = new DataView(chunk.buffer)
  v.setUint32(0, body.length)
  chunk.set(typed, 4)
  v.setUint32(8 + body.length, crc32(typed))
  const at = 8 + 12 + new DataView(png.buffer, png.byteOffset).getUint32(8) // signature, IHDR length, type, data, crc
  const out = new Uint8Array(png.length + chunk.length)
  out.set(png.subarray(0, at))
  out.set(chunk, at)
  out.set(png.subarray(at), at + chunk.length)
  return out
}

/** Every tEXt chunk of a png by keyword; empty when it is not a png. */
export function pngText(png: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isPng(png)) return out
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  for (let at = 8; at + 12 <= png.length;) {
    const len = v.getUint32(at)
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8))
    if (type === 'tEXt') {
      const s = String.fromCharCode(...png.subarray(at + 8, at + 8 + len))
      const z = s.indexOf('\0')
      if (z > 0) out[s.slice(0, z)] = s.slice(z + 1)
    }
    if (type === 'IEND') break
    at += 12 + len
  }
  return out
}

function check(b: unknown): string | null {
  const s = b as Partial<GenBody> | null
  if (!s || typeof s !== 'object') return 'a session is an object.'
  if (!Array.isArray(s.runs)) return 'a session has no run list.'
  if (typeof s.prompt !== 'string') return 'a session has no prompt.'
  if (s.runs.some((r) => typeof r?.image !== 'string' || !r.image.startsWith('data:image/png'))) return 'a run has no image.'
  return null
}

export function genKind(): DocKind<GenBody> {
  return {
    kind: GEN_KIND,
    tool: 'generate',
    label: 'image runs',
    ext: '.hbimagegen.json',
    version: 1,
    create: newSession,
    check,
    models: (b) => [...new Set(b.runs.map((r) => r.model))],
    imports: [
      {
        accept: SIDECAR_EXT,
        label: 'restore the run settings',
        async read(file) {
          const s = readSettings(await file.text())
          return { name: file.name.replace(/\.imagegen\.json$/i, ''), body: reuse(newSession(), s) }
        },
      },
    ],
    exports: [
      {
        key: 'settings', label: 'settings', ext: SIDECAR_EXT, note: 'the current run settings and timing, no pixels.', type: 'application/json',
        write: (b) => {
          const r = b.runs.find((x) => x.id === b.current) ?? b.runs[0]
          return r ? sidecar(r) : JSON.stringify({ tool: 'hackbuild generate', version: 1, ...settingsOf(b) }, null, 2)
        },
      },
    ],
  }
}
