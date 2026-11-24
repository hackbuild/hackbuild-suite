// The character sheet (design 3.9 steps 7, 8, 10, 11): the persona file
// the editor reads and writes, the register and length dials, the brain
// tiers, the plan a reply is read as, and the transcript kept in the
// character file. Framework free.
import { migrateSession, type ChatSession, type ChatSink } from '@hackbuild/converse'
import type { CardV2 } from '@hackbuild/character'
import type { PersonaFile, PersonaPreset } from '@virgilvox/hackbuild-ui/vanilla'
import type { TwinExt } from './twin.ts'

/** The suite's own part of the card, beside the hackbuild profile. */
export const EXT = 'hackbuild_suite'
export type Register = 'person' | 'machine'
export type Length = 'short' | 'normal' | 'paragraph'
export type TierKey = 'none' | 'tab' | 'light' | 'remote'
export interface SuiteExt {
  register?: Register
  length?: Length
  tier?: TierKey
  /** The conversation, saved with the character; left out by "card only". */
  transcript?: ChatSession
  /** Twin files kept on this device, as pointers to local blobs. */
  twin?: TwinExt
}

export const extOf = (card: CardV2): SuiteExt => (card.data.extensions?.[EXT] as SuiteExt | undefined) ?? {}
export function setExt(card: CardV2, patch: Partial<SuiteExt>): CardV2 {
  card.data.extensions = { ...card.data.extensions, [EXT]: { ...extOf(card), ...patch } }
  return card
}

/** The register and length dials as prompt lines (P-PERSONA-4). */
export const REGISTERS: { label: string; value: Register }[] = [{ label: 'a person', value: 'person' }, { label: 'a machine', value: 'machine' }]
export const LENGTHS: { label: string; value: Length }[] = [{ label: 'short', value: 'short' }, { label: 'normal', value: 'normal' }, { label: 'paragraph', value: 'paragraph' }]
export function styleLines(card: CardV2): string {
  const x = extOf(card)
  const reg = x.register === 'machine' ? 'you are talking to a program, not a person: answer plainly, no small talk.' : ''
  const len = x.length === 'short' ? 'keep each reply to one short line.' : x.length === 'paragraph' ? 'reply in one full paragraph when it helps.' : ''
  return [reg, len].filter(Boolean).join('\n')
}

/** The persona file the editor edits: name, prompt and first line of the card. */
export const personaOf = (card: CardV2): PersonaFile => ({ v: 1, name: card.data.name, prompt: card.data.system_prompt, first: card.data.first_mes })
export function withPersona(card: CardV2, f: PersonaFile): CardV2 {
  card.data.name = f.name
  card.data.system_prompt = f.prompt
  if (typeof f.first === 'string') card.data.first_mes = f.first
  return card
}

/** Built in presets; the person's own are kept in this browser. */
export const BUILT_IN: PersonaPreset[] = [
  { label: 'dry and sardonic', file: { v: 1, name: 'mannequin', prompt: 'you are {{char}}, a jointed mannequin with a dry wit. answer {{user}} in short lowercase lines. never gush.' } },
  { label: 'warm friend', file: { v: 1, name: 'mannequin', prompt: 'you are {{char}}, a patient friend who lives in a browser tab. ask {{user}} one question back. short lowercase lines.' } },
]
const PRESETS_KEY = 'hb.character.presets'
export function loadPresets(): PersonaPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PRESETS_KEY) ?? '[]') as PersonaPreset[]
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}
export function savePresets(list: PersonaPreset[]): void {
  try {
    localStorage.setItem(PRESETS_KEY, JSON.stringify(list))
  } catch {
    /* storage is off: the presets last for this visit */
  }
}

/** The plan a reply is read as: what it says, box by box, and the acts it tags. */
export interface Plan { say: string[]; do: string[] }
export function planOf(reply: string): Plan {
  const acts = [...reply.matchAll(/\*([^*\n]{1,40})\*|\[([a-z][a-z ]{0,30})\]/g)].map((m) => (m[1] ?? m[2] ?? '').trim())
  const say = reply.replace(/<think>[\s\S]*?<\/think>/g, '').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
  return { say, do: acts }
}

/** The conversation saved inside the character file. */
export function cardSink(o: { read(): { id: string; card: CardV2 } | null; write(session: ChatSession): void }): ChatSink {
  return {
    async load(id) {
      const d = o.read()
      const t = d && d.id === id ? extOf(d.card).transcript : undefined
      return t ? { ...migrateSession(t, { id, now: Date.now() }), id } : null
    },
    async save(session) {
      const d = o.read()
      if (d && d.id === session.id) o.write(structuredClone(session))
    },
  }
}
