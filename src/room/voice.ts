// The room's voice (design 3.10 step 9, P-VOUT-1, P-VOUT-9, P-VOUT-13): the
// engine select with the trade of each, ported from the room original's
// voice tab (Pocket TTS, the bellows vocal tract, the browser voice), the
// clone slot for Pocket, the bellows presets and rate, and the mouth canvas
// with the phoneme sounding now. Engines load through the model hub, so
// under ?stub they are the tone voice and nothing is fetched. A failed
// engine steps down to the browser voice. Framework free.
import type { Engine, Speaker, TimedEvent } from '@hackbuild/speak'
import * as hub from '../models/hub.ts'
import { SYSTEM_ID, TRADES } from '../speak/runtimes.ts'

export const POCKET_ID = 'pocket-tts'
export const BELLOWS_ID = 'bellows-voice'
/** The engines of the voice tab, best first, each with its trade in the label. */
export const VOICE_ENGINES = [POCKET_ID, BELLOWS_ID, SYSTEM_ID] as const
export const ENGINE_LABELS: Record<string, string> = {
  [POCKET_ID]: 'pocket tts: a neural voice with clones, a download',
  [BELLOWS_ID]: 'bellows: a modelled vocal tract, no weights',
  [SYSTEM_ID]: 'browser voice: at once, no download',
}
export const engineTrade = (id: string): string => TRADES[id]?.trade ?? ''

type Cloner = Engine & { cloneVoice?: (s: Float32Array, rate: number) => Promise<void> }

export interface VoiceHooks {
  status(text: string, fail?: boolean): void
  speaking(on: boolean): void
  timed?(e: TimedEvent): void
}

/** One engine chain and its speaker; a new pick or preset makes a new speaker. */
export class RoomVoice {
  phoneme = ''
  cloned = ''
  private ctx: AudioContext | null = null
  private speaker: Speaker | null = null
  private engines: Engine[] = []
  private pocket: Cloner | null = null
  private key = ''
  private handles: { release?: () => void }[] = []

  constructor(private hooks: VoiceHooks) {}

  get level(): number {
    return this.speaker?.level() ?? 0
  }

  /** Loads the engine and the browser voice behind it; returns the engine id that will speak. */
  async use(id: string, cfg: { preset: string; rate: number }): Promise<string> {
    const key = JSON.stringify([id, cfg, this.cloned])
    if (key === this.key && this.speaker) return this.speaker.engine ?? id
    const { addSpeakRuntimes } = await import('../speak/runtimes.ts')
    await addSpeakRuntimes({ kokoro: () => false })
    const engines: Engine[] = []
    let err = ''
    for (const e of id === SYSTEM_ID ? [SYSTEM_ID] : [id, SYSTEM_ID]) {
      try {
        await hub.load(e)
        const st = hub.states.value[e]
        if (st?.state === 'fault') throw new Error(st.error || 'the load failed')
        const l = await hub.hub().use({ id: e })
        this.handles.push(l as { release?: () => void })
        engines.push(l.value as Engine)
        if (e === POCKET_ID) this.pocket = l.value as Cloner
      } catch (x) {
        if (e === id) err = x instanceof Error ? x.message : String(x)
      }
    }
    if (!engines.length) {
      this.hooks.status(`voice is off: ${err || 'no engine started'}. replies show in the bubble and the log.`, true)
      return ''
    }
    this.engines = engines
    this.ctx ??= new AudioContext()
    void this.ctx.resume().catch(() => undefined)
    const { createSpeaker } = await import('@hackbuild/speak')
    this.speaker?.dispose()
    this.speaker = createSpeaker({
      ctx: this.ctx,
      engines,
      voice: { rate: cfg.rate },
      voices: { [BELLOWS_ID]: { voice: cfg.preset, rate: cfg.rate }, ...(this.cloned ? { [POCKET_ID]: { voice: 'custom' } } : {}) },
      onSpeaking: (s) => {
        if (!s) this.phoneme = ''
        this.hooks.speaking(s)
      },
      onTimed: (t) => {
        if (t.kind === 'phoneme' && t.phoneme) this.phoneme = t.phoneme
        this.hooks.timed?.(t)
      },
      onStatus: (s) => { if (s.kind === 'failed' || s.kind === 'watchdog') this.hooks.status(`${s.text} the browser voice takes over.`, true) },
    })
    this.key = key
    const on = (engines[0] as { id?: string }).id ?? id
    this.hooks.status(err ? `${id} failed: ${err}. the browser voice speaks.` : `ready, ${on}.`, !!err)
    return on
  }

  say(text: string): Promise<void> {
    return this.speaker ? this.speaker.say(text) : Promise.resolve()
  }

  /** Clones a dropped clip into Pocket. Throws with the copy the slot shows. */
  async clone(file: File): Promise<string> {
    if (!this.pocket?.cloneVoice) throw new Error('pick pocket tts first: only it clones.')
    this.hooks.status('encoding the voice.')
    const [{ decodeAudio }, { toMono }] = await Promise.all([import('@hackbuild/media'), import('@hackbuild/speak')])
    const a = await decodeAudio(file)
    await this.pocket.cloneVoice(toMono(a.channels), a.sampleRate)
    this.cloned = file.name
    this.key = ''
    const short = a.duration < 8 ? ` the clip is ${a.duration.toFixed(0)} s; 8 s or more copies a voice better.` : ''
    return `cloned from ${file.name}. up to 15 s of it is used.${short}`
  }

  stop(): void {
    this.speaker?.stop()
  }

  dispose(): void {
    this.speaker?.dispose()
    this.speaker = null
    for (const h of this.handles) hub.hub().release(h as never)
    this.handles = []
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
    this.engines = []
  }
}

// ------------------------------------------------------------- mouth

const OPEN: Record<string, number> = { a: 1, 'ɑ': 1, 'æ': 0.9, 'ɔ': 0.85, o: 0.7, 'ʌ': 0.75, e: 0.6, 'ɛ': 0.7, 'ə': 0.5, i: 0.35, 'ɪ': 0.4, u: 0.3, 'ʊ': 0.35 }
const CLOSED = new Set(['m', 'b', 'p'])
const ROUND = new Set(['u', 'ʊ', 'o', 'w', 'ɔ'])

/** How open and how round the mouth is for a phoneme, 0 to 1 (inferred from the vowel chart). */
export function mouthOf(phoneme: string, level: number): { open: number; round: number } {
  const p = phoneme.toLowerCase()
  const head = p[0] ?? ''
  if (CLOSED.has(head)) return { open: 0.02, round: 0 }
  const v = [...p].map((c) => OPEN[c]).find((x) => x !== undefined)
  const open = v ?? Math.min(1, level * 4)
  return { open, round: [...p].some((c) => ROUND.has(c)) ? 0.8 : 0 }
}

/** The tract outline: lips and jaw from the phoneme, the symbol at the side. */
export function drawMouth(cv: HTMLCanvasElement, phoneme: string, level: number, tones: { ink: string; accent: string; paper: string }): void {
  const w = cv.clientWidth || cv.width
  const h = cv.clientHeight || cv.height
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1)
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr) }
  const x = cv.getContext('2d')
  if (!x) return
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  x.fillStyle = tones.paper
  x.fillRect(0, 0, w, h)
  const m = mouthOf(phoneme, level)
  const cx = w * 0.42
  const cy = h * 0.5
  const half = w * 0.22 * (1 - m.round * 0.45)
  const gap = Math.max(1.5, h * 0.36 * m.open)
  x.lineWidth = 2
  x.strokeStyle = tones.accent
  x.beginPath()
  x.moveTo(cx - half, cy)
  x.bezierCurveTo(cx - half * 0.5, cy - gap * 0.9, cx + half * 0.5, cy - gap * 0.9, cx + half, cy)
  x.bezierCurveTo(cx + half * 0.5, cy + gap * 1.1, cx - half * 0.5, cy + gap * 1.1, cx - half, cy)
  x.closePath()
  x.stroke()
  x.fillStyle = tones.ink
  x.font = `${Math.round(h * 0.34)}px ui-monospace, monospace`
  x.textBaseline = 'middle'
  x.fillText(phoneme || (level > 0.02 ? '~' : '-'), w * 0.78, cy)
}
