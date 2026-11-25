// The room document (design 3.10, save and export): the layout, the cast,
// the seed, the tunables and the agent's memory by reference, saved as
// `.hbroom.json`. A dropped body is kept by name only, flagged local: the
// file itself stays in the tab, and an mmd body is never stored outside the
// person's own workspace. The log exports as csv (P-SAVE-10) and the run as
// a trace; every export name carries the seed (P-ROOM-16). Framework free.
import type { DocKind } from '../workspace/kinds.ts'
import { BRAINS, DECIDES, PARAMS, type Brain, type Decide, type Params } from './brain.ts'

export const ROOM_KIND = 'room.session'

export interface CastMember {
  name: string
  persona: string
  /** Free text added to the end of the prompt (P-PERSONA-6). */
  extra: string
  brain: Brain
  decide: Decide
  params: Params
  /** The body by name; the file is never in the document. */
  body: { name: string; local: boolean } | null
  voice: { engine: string; preset: string; rate: number }
}

export interface RoomBody {
  seed: number
  /** Where each thing stood when the document was saved, meters. */
  layout: { label: string; x: number; z: number; on: string | null }[]
  cast: CastMember[]
  /** Tunable key to value, as the tune drawer shows them. */
  tunables: Record<string, number>
  run: 'prompted' | 'free run'
  /** The agent's memory store by name and its size when saved; the lines stay in the store. */
  memory: { store: string; items: number }
}

export const newCast = (name = 'ada', persona = ''): CastMember => ({
  name, persona, extra: '', brain: 'reflex only', decide: 'the model', params: { ...PARAMS }, body: null,
  voice: { engine: 'web-speech', preset: 'narrator-female', rate: 1 },
})

export const newRoomBody = (): RoomBody => ({ seed: 7, layout: [], cast: [newCast()], tunables: {}, run: 'prompted', memory: { store: 'room', items: 0 } })

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)

export function checkRoom(raw: unknown): string | null {
  const b = raw as Partial<RoomBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (!num(b.seed)) return 'seed is not a number.'
  if (!Array.isArray(b.layout)) return 'layout is missing.'
  for (const t of b.layout) if (!t || typeof t.label !== 'string' || !num(t.x) || !num(t.z)) return 'a thing in the layout has no label or position.'
  if (!Array.isArray(b.cast) || !b.cast.length) return 'the cast is empty.'
  for (const c of b.cast) {
    if (!c || typeof c.name !== 'string') return 'a cast member has no name.'
    if (!BRAINS.includes(c.brain)) return `brain ${String(c.brain)} is not reflex only, in tab or your endpoint.`
    if (!DECIDES.includes(c.decide)) return `who decides ${String(c.decide)} is not the model, with hints or reflexes first.`
  }
  if (!b.tunables || typeof b.tunables !== 'object') return 'tunables is missing.'
  for (const [k, v] of Object.entries(b.tunables)) if (!num(v)) return `tunable ${k} is not a number.`
  if (b.run !== 'prompted' && b.run !== 'free run') return `run ${String(b.run)} is not prompted or free run.`
  if (!b.memory || typeof b.memory.store !== 'string') return 'memory has no store.'
  return null
}

export const roomKind: DocKind<RoomBody> = {
  kind: ROOM_KIND,
  tool: 'room',
  label: 'room',
  ext: '.hbroom.json',
  version: 1,
  create: newRoomBody,
  check: checkRoom,
}

/** The export name: the agent, then the seed, so a take says how to repeat it. */
export const exportName = (agent: string, seed: number): string => `room-${agent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'}-seed-${seed}`

const cell = (v: string | number): string => {
  const s = String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The tagged log as csv: one row a line, time in seconds. */
export function logCsv(rows: readonly { t: number; agent?: string; kind: string; text: string }[]): string {
  return ['t,agent,kind,text', ...rows.map((r) => [r.t.toFixed(2), r.agent ?? '', r.kind, r.text].map(cell).join(','))].join('\n') + '\n'
}
