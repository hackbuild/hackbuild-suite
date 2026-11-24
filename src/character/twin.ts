// Twin mode (design 3.9 and section 5 item 5): the character tool with the
// body, voice and persona slots filled from files the person drops. The
// body and voice slots have no url field and no default. Dropped files are
// held in memory; only "keep on this device" stores them, in this browser's
// indexeddb, flagged local, so workspace export leaves them out unless the
// person ticks "include local only files". Framework free.
import type { PersonaFile } from '@virgilvox/hackbuild-ui/vanilla'
import type { CardV2 } from '@hackbuild/character'
import { cardFrom } from './kind.ts'
import { personaOf } from './sheet.ts'

export type SlotKey = 'body' | 'voice' | 'persona'
export interface BlobPointer { $blob: string }
/** What the card keeps of the twin: pointers to local blobs, only when kept. */
export interface TwinExt { keep: true; body?: BlobPointer; voice?: BlobPointer }

export const TWIN_EMPTY = 'drop your own model and a clip of your voice. they stay in this browser and are left out of exports.'
export const BODY_ACCEPT = '.glb,.vrm'
export const VOICE_ACCEPT = '.wav,audio/wav,audio/x-wav'
export const PERSONA_ACCEPT = '.json,application/json'

const ext = (name: string) => name.toLowerCase().replace(/^.*\./, '')
/** The slot a dropped file fills, by its name, or null. */
export function slotOf(f: { name: string; type: string }): SlotKey | null {
  const e = ext(f.name)
  if (e === 'glb' || e === 'vrm') return 'body'
  if (e === 'wav' || f.type === 'audio/wav' || f.type === 'audio/x-wav') return 'voice'
  if (e === 'json' || f.type === 'application/json') return 'persona'
  return null
}

/** Where the dropped files live now, in words. */
export function whereLine(keep: boolean): string {
  return keep
    ? 'kept in this browser (indexeddb), flagged local only. exports leave them out unless you tick include local only files.'
    : 'held in this tab only, in memory. closing the tab drops them. nothing is stored or sent.'
}

/** A persona from a dropped file: a persona file or a character card. */
export function personaFrom(raw: unknown): PersonaFile {
  const o = raw as { spec?: string; prompt?: unknown; name?: unknown; first?: unknown } | null
  if (o && (o.spec === 'chara_card_v2' || o.spec === 'chara_card_v3')) return personaOf(cardFrom(o) as CardV2)
  if (o && typeof o.prompt === 'string') return { v: 1, name: typeof o.name === 'string' && o.name ? o.name : 'twin', prompt: o.prompt, ...(typeof o.first === 'string' ? { first: o.first } : {}) }
  throw new Error('this json is not a persona file or a character card: it has no prompt.')
}

export const sizeOf = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} mb` : `${Math.max(1, Math.round(n / 1024))} kb`)
