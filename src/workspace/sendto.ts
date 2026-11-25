// "send to" (design 1.2): a result moves through the workspace to every
// tool that takes its type, and the target opens on the sent item. One
// table names who takes what; each target loads its kind only when used.
import type { MaskRle } from '@hackbuild/vision'
import { router } from '../router'
import { logEvent } from '../shell/shell'
import { kinds, ws } from './state'

export type SendType = 'image' | 'mask' | 'depth' | 'text' | 'audio'

/** A stored frame: a data url with its pixel size. */
export interface Frame { image: string; width: number; height: number }

export type Sendable =
  | { type: 'image'; name: string; frame: Frame }
  /** A mask over its frame, at the frame's size; 255 is in. */
  | { type: 'mask'; name: string; frame: Frame; mask: MaskRle }
  /** A depth map as a grey png data url over its frame, nearer is lighter. */
  | { type: 'depth'; name: string; frame: Frame; depth: string; model: string | null }
  | { type: 'text'; name: string; text: string }
  /** Word times in seconds when a speech engine made the audio. */
  | { type: 'audio'; name: string; audio: Blob; words?: { text: string; t0: number; t1: number }[] }

/** One result a tool offers to the menu. */
export interface SendOffer {
  type: SendType
  /** The result in a word: image, mask, depth, caption, text, audio. */
  what: string
  ready: boolean
  get(): Sendable | null | Promise<Sendable | null>
}

export interface Target {
  tool: string
  takes: SendType[]
  send(s: Sendable, from: string): Promise<void>
}

/** The picture a tool that reads images sees: the depth map for depth, else the frame. */
const pictureOf = (s: Sendable): Frame | null =>
  s.type === 'depth' ? { image: s.depth, width: s.frame.width, height: s.frame.height } : 'frame' in s ? s.frame : null

const openDoc = (tool: string, id: string) => router.push({ name: tool, query: { doc: id } })

/** Lines of a text worth keeping as memories: one per line or sentence, 12 characters and up. */
export function linesOf(text: string): string[] {
  return text.split(/\n+|(?<=[.?!])\s+/).map((t) => t.trim()).filter((t) => t.length >= 12)
}

export const TARGETS: Target[] = [
  {
    tool: 'vision', takes: ['image', 'mask', 'depth'],
    async send(s, from) {
      const f = pictureOf(s)
      if (!f) return
      const [{ registerVision }, v] = await Promise.all([import('../vision/frame.ts'), import('../vision/kind.ts')])
      registerVision()
      const cap = { id: Date.now().toString(36), name: s.name, at: Date.now(), from, ...f, found: [], points: [], caption: null, answers: [], ms: {}, models: [] }
      const d = await ws.createDoc(v.VISION_KIND, { name: s.name, body: v.withCapture(v.newSession(), cap) })
      await openDoc('vision', d.id)
    },
  },
  {
    tool: 'masks', takes: ['image', 'depth'],
    async send(s) {
      const f = pictureOf(s)
      if (!f) return
      const [{ registerMasks }, m] = await Promise.all([import('../masks/register.ts'), import('../masks/kind.ts')])
      registerMasks()
      const d = await ws.createDoc(m.MASKS_KIND, { name: s.name, body: m.withImage(s.name, f) })
      await openDoc('masks', d.id)
    },
  },
  {
    tool: 'relief', takes: ['image', 'mask', 'depth'],
    async send(s) {
      if (!('frame' in s)) return
      const [{ registerRelief }, r] = await Promise.all([import('../relief/register.ts'), import('../relief/kind.ts')])
      registerRelief()
      const body = r.withImage(r.newBody(), s.name, s.frame)
      // A mask limits the relief to its cells, as the erase brush does.
      if (s.type === 'mask') body.keep = s.mask
      if (s.type === 'depth') Object.assign(body, { depth: s.depth, depthModel: s.model, source: 'depth' })
      const d = await ws.createDoc(r.RELIEF_KIND, { name: s.name, body })
      await openDoc('relief', d.id)
    },
  },
  {
    tool: 'chat', takes: ['text'],
    async send(s) {
      if (s.type === 'text') await router.push({ name: 'chat', query: { draft: s.text } })
    },
  },
  {
    tool: 'memory', takes: ['text'],
    async send(s, from) {
      if (s.type !== 'text') return
      const { saveLine } = await import('../memory/store.ts')
      const lines = linesOf(s.text)
      let n = 0
      for (const t of lines) if (!(await saveLine(t, { kind: 'doc', from, section: s.name })).merged) n++
      logEvent('note', `sent ${n} line${n === 1 ? '' : 's'} of ${s.name} to memory. chat recalls them now.`)
      await router.push({ name: 'memory', query: { q: lines[0]?.split(/\s+/).slice(0, 6).join(' ') ?? '' } })
    },
  },
  {
    tool: 'speak', takes: ['text'],
    async send(s) {
      if (s.type === 'text') await router.push({ name: 'speak', query: { text: s.text } })
    },
  },
  {
    tool: 'transcribe', takes: ['audio'],
    async send(s) {
      if (s.type !== 'audio') return
      const [{ registerTranscript }, t] = await Promise.all([import('../transcribe/register.ts'), import('../transcribe/kind.ts')])
      registerTranscript()
      const via = kinds.get(t.TRANSCRIPT_KIND)?.imports?.[0]
      if (!via) return
      const file = new File([s.audio], `${s.name}.wav`, { type: s.audio.type || 'audio/wav' })
      const d = await ws.createDoc(t.TRANSCRIPT_KIND, await via.read(file))
      await openDoc('transcribe', d.id)
    },
  },
  {
    tool: 'lipsync', takes: ['audio', 'text'],
    async send(s) {
      const { post } = await import('../lipsync/inbox.ts')
      if (s.type === 'audio') post({ name: s.name, audio: s.audio, ...(s.words ? { words: s.words } : {}) })
      else if (s.type === 'text') post({ name: s.name, text: s.text })
      else return
      await router.push({ name: 'lipsync' })
    },
  },
]

/** The tools that take a type, the sender left out. */
export const targetsFor = (type: SendType, from: string): Target[] => TARGETS.filter((t) => t.tool !== from && t.takes.includes(type))

/** Send one result to one tool; the target opens on it. */
export async function sendTo(tool: string, s: Sendable, from: string): Promise<void> {
  const t = TARGETS.find((x) => x.tool === tool && x.takes.includes(s.type))
  if (!t) throw new Error(`${tool} does not take ${s.type}.`)
  await t.send(s, from)
  if (tool !== 'memory') logEvent('note', `sent ${s.type} ${s.name} from ${from} to ${tool}.`)
}
