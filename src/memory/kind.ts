// The memory document kind (design 3.8). The memory itself lives in the
// store @hackbuild/memory opens in IndexedDB; the document names that store
// and carries a copy of its export (no vectors), so undo, workspace export
// and a move to another browser carry the memory too. Framework free.
import type { ExportData } from '@hackbuild/memory'
import type { SealLock } from '@hackbuild/memory/seal'
import type { DocKind } from '../workspace/kinds.ts'

export const MEMORY_KIND = 'memory.store'
/** The store chat recalls from and saves to. */
export const CHAT_STORE = 'chat'

export interface MemoryBody {
  /** The memory store id: `hackbuild-memory:<store>` in IndexedDB. */
  store: string
  data: ExportData
  /** A sealed store's lock record. Its export is then in `sealed`, and `data` is empty. */
  lock?: SealLock
  /** The export sealed with the store's key, base64, bound to the store id. */
  sealed?: string
}

export const emptyData = (id: string): ExportData => ({ format: 'hackbuild-memory', version: 1, id, items: [], core: [] })

export function isExport(v: unknown): v is ExportData {
  const d = v as Partial<ExportData> | null
  return !!d && d.format === 'hackbuild-memory' && d.version === 1 && Array.isArray(d.items) && Array.isArray(d.core)
}

/** The export inside a file: a memory export, or a memory document. Throws with the file name. */
export function readExport(text: string, name: string): ExportData {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error(`${name} is not json.`)
  }
  const inner = (j as { body?: { data?: unknown } } | null)?.body?.data
  if (isExport(j)) return j
  if (isExport(inner)) return inner
  throw new Error(`${name} is not a memory export.`)
}

/** A store id for a new memory document. */
export const newStore = (now = Date.now()) => `m-${now.toString(36)}`

export const memoryKind: DocKind<MemoryBody> = {
  kind: MEMORY_KIND,
  tool: 'memory',
  label: 'memory',
  ext: '.hbmem.json',
  version: 1,
  create: () => ({ store: CHAT_STORE, data: emptyData(CHAT_STORE) }),
  check(body) {
    const b = body as Partial<MemoryBody> | null
    if (!b || typeof b.store !== 'string' || !b.store) return 'the memory document names no store.'
    return isExport(b.data) ? null : 'the memory document holds no memory export.'
  },
  imports: [
    {
      accept: '.json,application/json',
      label: 'open as a memory',
      async read(file) {
        const data = readExport(await file.text(), file.name)
        return { name: file.name.replace(/(\.memory)?\.json$/i, ''), body: { store: newStore(), data } }
      },
    },
  ],
  exports: [{ key: 'json', label: 'memory json', ext: '.memory.json', type: 'application/json', write: (b) => JSON.stringify(b.data, null, 2) }],
}
