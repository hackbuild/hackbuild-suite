// The drives document kind (design 3.12). A session keeps the body clock
// hour the run starts at, the sim speed, the chooser's temperature and
// commitment, and the events injected with the step each landed on, so a
// saved session with its seed replays the same run. Saved as
// `.hbdrives.json`. Framework free.
import type { DocKind } from '../workspace/kinds.ts'
import { EVENT_KINDS, type EventKind } from './sim.ts'

export const DRIVES_KIND = 'drives.session'

export interface DrivesBody {
  startHour: number
  /** Sim seconds a wall second. */
  speed: number
  temperature: number
  commitment: number
  events: { step: number; kind: EventKind; text: string }[]
}

export const newDrivesBody = (): DrivesBody => ({ startHour: 8, speed: 60, temperature: 0.06, commitment: 0.12, events: [] })

export function checkDrives(raw: unknown): string | null {
  const b = raw as Partial<DrivesBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (typeof b.startHour !== 'number' || !(b.startHour >= 0 && b.startHour < 24)) return 'start hour is between 0 and 24.'
  if (typeof b.speed !== 'number' || !(b.speed >= 1 && b.speed <= 3600)) return 'speed is sim seconds a second, 1 to 3600.'
  if (typeof b.temperature !== 'number' || !(b.temperature > 0 && b.temperature <= 1)) return 'temperature is between 0 and 1.'
  if (typeof b.commitment !== 'number' || !(b.commitment >= 0 && b.commitment <= 1)) return 'commitment is between 0 and 1.'
  if (!Array.isArray(b.events)) return 'events is not a list.'
  for (const e of b.events) {
    if (!e || !Number.isInteger(e.step) || e.step < 1) return 'an event has no step.'
    if (!(EVENT_KINDS as readonly string[]).includes(String(e.kind)) || typeof e.text !== 'string') return `event ${String(e.kind)} is not one of ${EVENT_KINDS.join(', ')}.`
  }
  return null
}

export const drivesKind: DocKind<DrivesBody> = {
  kind: DRIVES_KIND,
  tool: 'drives',
  label: 'drives',
  ext: '.hbdrives.json',
  version: 1,
  create: newDrivesBody,
  check: checkDrives,
}
