// Memory items as the rows HbMemoryPanel and HbRecallTrace draw, and the
// chat phrase that saves a line. Framework free, so the rules are tested.
import type { RecallTrace, StoredItem } from '@hackbuild/memory'
import type { HbMemoryEntry, HbRecallHit } from '@virgilvox/hackbuild-ui'

/** Pinned lines go into every prompt; they list as this kind. */
export const PINNED = 'pin'
/** The pinned block's cap in characters, from @hackbuild/memory CoreMemory. */
export const PIN_CAP = 700
/** Kinds the add select offers, pinned first. */
export const ADD_KINDS = [PINNED, 'fact', 'note', 'rule']

const MON = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const day = (ms: number) => {
  const d = new Date(ms)
  return `${MON[d.getMonth()]} ${d.getDate()}`
}

/** 'nov 3 from chat', 'nov 3 edited', 'nov 3 added'. */
export function whenText(it: Pick<StoredItem, 'created' | 'edited' | 'meta'>): string {
  if (it.edited) return `${day(it.edited)} edited`
  const from = typeof it.meta?.from === 'string' ? it.meta.from : ''
  return `${day(it.created)} ${from ? `from ${from}` : 'added'}`
}

export const pinId = (i: number) => `p:${i}`
/** The pinned line index of a row id, or -1 for a stored memory. */
export const pinIndex = (id: string) => (id.startsWith('p:') ? Number(id.slice(2)) : -1)

/** Pinned lines first, then every stored memory, newest first. */
export function toEntries(items: readonly StoredItem[], core: readonly string[] = []): HbMemoryEntry[] {
  const pinned = core.map((text, i) => ({ id: pinId(i), text, kind: PINNED, score: null, when: 'in every prompt' }))
  const rest = [...items]
    .sort((a, b) => b.created - a.created || b.id - a.id)
    .map((it) => ({ id: String(it.id), text: it.text, kind: it.kind, score: null, when: whenText(it), ...(it.entities?.length ? { entity: it.entities } : {}) }))
  return [...pinned, ...rest]
}

/** The ranked rows of a recall trace, as list entries with their score. */
export function traceEntries(t: RecallTrace, items: readonly StoredItem[]): HbMemoryEntry[] {
  const by = new Map(items.map((it) => [it.id, it]))
  return t.rows.map((r) => {
    const it = by.get(r.id)
    return { id: String(r.id), text: r.text, kind: r.kind, score: r.score, when: it ? whenText(it) : '' }
  })
}

/** The trace rows as HbRecallTrace hits: relevance, recency and importance bars, used as the recall marked them. */
export function traceHits(t: RecallTrace): HbRecallHit[] {
  return t.rows.map((r) => ({
    text: r.text,
    kind: r.kind,
    score: r.score,
    used: r.used,
    parts: [
      { key: 'rel', value: r.rel },
      { key: 'rec', value: r.rec },
      { key: 'imp', value: r.imp },
    ],
  }))
}

/** 'remember that the mug goes on the shelf' gives 'the mug goes on the shelf'; anything else gives null. */
export function rememberLine(text: string): string | null {
  const m = /^\s*(?:please\s+)?remember(?:\s+that)?\s*[:,]?\s+(.+)$/is.exec(text)
  const line = m?.[1]?.replace(/\s+/g, ' ').trim().replace(/[.]+$/, '')
  return line && line.length >= 3 ? line : null
}

/** '120 of 700 characters'. */
export const pinCount = (core: readonly string[]) => `${core.join('\n').length} of ${PIN_CAP} characters`
