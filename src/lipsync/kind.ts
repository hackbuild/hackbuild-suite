// The lipsync document kind (design 3.11) and the pieces the tool and its
// tests share: the viseme to morph map with its defaults from a body's
// morph names, and the viseme track with its json export. Saved as
// `.hblipsync.json`: the line, the map edits, strength and lead. Audio is
// never saved: it stays in the tab it was dropped on. Framework free.
import { OCULUS_VISEMES, PRESET_ALIASES, VISEME_TO_VOWELS, VRM_VOWELS, type OculusViseme, type VrmVowel } from '@hackbuild/rig/expressions'
import type { DocKind } from '../workspace/kinds.ts'

export const LIPSYNC_KIND = 'lipsync.session'
export const VISEMES = OCULUS_VISEMES
export type Viseme = OculusViseme

/** One row of the map: the morph a viseme drives and how hard, 0 to 1.5. */
export interface MapRow {
  morph: string
  gain: number
}
export type VisemeMap = Record<Viseme, MapRow>

export type SourceKind = 'text' | 'audio' | 'speech' | 'mic'

export interface LipsyncBody {
  /** The line the text source says. */
  text: string
  /** What the track was made from last; the audio itself is never kept. */
  source: { name: string; kind: SourceKind } | null
  /** Hand edits to the map by viseme, over the defaults for the body. */
  edits: Partial<Record<Viseme, MapRow>>
  /** Output scale, 0 to 1.5. */
  strength: number
  /** Mouth ahead of the sound, seconds. */
  lead: number
}

export const newLipsyncBody = (): LipsyncBody => ({
  text: 'the quick brown fox jumps over the lazy dog.',
  source: null,
  edits: {},
  strength: 1,
  lead: 0.04,
})

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** The morph standing for a vowel, by the rig's aliases, also after a mth or mouth prefix (Fcl_MTH_A). */
export function vowelMorph(names: readonly string[], vowel: VrmVowel): string | null {
  const aliases = PRESET_ALIASES[vowel].map(norm)
  for (const n of names) if (aliases.includes(norm(n))) return n
  for (const n of names) {
    const k = norm(n)
    if (aliases.some((a) => k.endsWith(`mth${a}`) || k.endsWith(`mouth${a}`))) return n
  }
  return null
}

/** The map a body starts with, from its morph names: Oculus visemes, else the vowels, else the ARKit jaw. */
export function defaultMap(names: readonly string[]): VisemeMap {
  const by = new Map(names.map((n) => [norm(n), n]))
  const vowels = Object.fromEntries(VRM_VOWELS.map((v) => [v, vowelMorph(names, v)])) as Record<VrmVowel, string | null>
  const jaw = by.get('jawopen') ?? null
  const close = by.get('mouthclose') ?? null
  const out = {} as VisemeMap
  for (const v of VISEMES) {
    const own = by.get(norm(`viseme_${v}`))
    if (own) { out[v] = { morph: own, gain: 1 }; continue }
    const mix = Object.entries(VISEME_TO_VOWELS[v]) as [VrmVowel, number][]
    const top = mix.filter(([k]) => vowels[k]).sort((a, b) => b[1] - a[1])[0]
    if (top) { out[v] = { morph: vowels[top[0]]!, gain: top[1] }; continue }
    if (v === 'PP' && close) { out[v] = { morph: close, gain: 1 }; continue }
    const open = Math.min(1, mix.reduce((s, [, w]) => s + w, 0))
    out[v] = jaw && open > 0 ? { morph: jaw, gain: +open.toFixed(2) } : { morph: '', gain: 1 }
  }
  return out
}

/** The defaults with the hand edits over them. */
export const mapWith = (names: readonly string[], edits: LipsyncBody['edits']): VisemeMap => ({ ...defaultMap(names), ...edits })

/** Morph weights for one frame of 15 viseme weights: summed per morph, scaled, held to 0..1. */
export function morphWeights(map: VisemeMap, visemes: ArrayLike<number>, strength = 1): Map<string, number> {
  const out = new Map<string, number>()
  VISEMES.forEach((v, i) => {
    const r = map[v]
    if (!r?.morph) return
    out.set(r.morph, (out.get(r.morph) ?? 0) + (visemes[i] ?? 0) * r.gain * strength)
  })
  for (const [k, w] of out) out.set(k, Math.min(1, Math.max(0, w)))
  return out
}

/** A viseme track: 15 weights a frame at a fixed rate. */
export interface Track {
  fps: number
  frames: Float32Array
  /** Per frame: 0 silent, 1 timeline, 2 energy. */
  sources: Uint8Array
  name: string
  kind: SourceKind
}

export const frameCount = (t: Track) => t.sources.length
export const trackSeconds = (t: Track) => frameCount(t) / t.fps

/** The frame of a track at a time, clamped. */
export function frameAt(t: Track, time: number): Float32Array {
  const n = frameCount(t)
  const i = Math.max(0, Math.min(n - 1, Math.floor(time * t.fps)))
  return t.frames.subarray(i * VISEMES.length, (i + 1) * VISEMES.length)
}

/** The strongest viseme of a frame, sil under 0.05. */
export function topViseme(f: ArrayLike<number>): Viseme {
  let best = 0
  for (let i = 1; i < VISEMES.length; i++) if ((f[i] ?? 0) > (f[best] ?? 0)) best = i
  return (f[best] ?? 0) < 0.05 ? 'sil' : VISEMES[best]!
}

/** Runs of the strongest viseme, sil left out: the keys a game engine reads. */
export function keysOf(t: Track): { viseme: Viseme; start: number; end: number }[] {
  const out: { viseme: Viseme; start: number; end: number }[] = []
  for (let i = 0; i < frameCount(t); i++) {
    const v = topViseme(frameAt(t, i / t.fps))
    const last = out[out.length - 1]
    if (last && last.viseme === v && Math.abs(last.end - i / t.fps) < 1e-6) last.end = (i + 1) / t.fps
    else if (v !== 'sil') out.push({ viseme: v, start: i / t.fps, end: (i + 1) / t.fps })
  }
  return out.map((k) => ({ ...k, start: +k.start.toFixed(3), end: +k.end.toFixed(3) }))
}

/** The viseme track as json: every frame's 15 weights, and the runs of the strongest. */
export function trackJson(t: Track, map?: VisemeMap) {
  const n = frameCount(t)
  const frames: number[][] = []
  for (let i = 0; i < n; i++) frames.push([...t.frames.subarray(i * 15, i * 15 + 15)].map((w) => +w.toFixed(3)))
  return {
    format: 'hackbuild.visemes',
    version: 1,
    source: { name: t.name, kind: t.kind },
    fps: t.fps,
    seconds: +(n / t.fps).toFixed(3),
    visemes: [...VISEMES],
    frames,
    keys: keysOf(t),
    ...(map ? { map } : {}),
  }
}

export function checkLipsync(raw: unknown): string | null {
  const b = raw as Partial<LipsyncBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (typeof b.text !== 'string') return 'text is missing.'
  if (!b.edits || typeof b.edits !== 'object') return 'edits is missing.'
  for (const [k, r] of Object.entries(b.edits)) {
    if (!(VISEMES as readonly string[]).includes(k)) return `${k} is not a viseme.`
    if (!r || typeof r.morph !== 'string' || typeof r.gain !== 'number') return `the row for ${k} needs a morph and a gain.`
  }
  if (typeof b.strength !== 'number' || b.strength < 0 || b.strength > 1.5) return 'strength is not between 0 and 1.5.'
  if (typeof b.lead !== 'number') return 'lead is not a number.'
  return null
}

export const lipsyncKind: DocKind<LipsyncBody> = {
  kind: LIPSYNC_KIND,
  tool: 'lipsync',
  label: 'lipsync',
  ext: '.hblipsync.json',
  version: 1,
  create: newLipsyncBody,
  check: checkLipsync,
}
