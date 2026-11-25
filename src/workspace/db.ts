// The workspace database (design 2.5): IndexedDB `hackbuild-suite`,
// versioned. Framework free. Everything above this file talks to a Backend,
// so the same workspace code runs on IndexedDB in the page and on the
// memory backend in tests.

export const DB_NAME = 'hackbuild-suite'
export const DB_VERSION = 2

/** projects, docs, blobs and history as in design 2.5. `kv` holds the
 * settings values and UI state (last route, open project); the design
 * calls it `settings`, and 2.4 shipped it as `kv`. */
export const STORES = ['kv', 'projects', 'docs', 'blobs', 'history'] as const
export type StoreName = (typeof STORES)[number]

export interface Backend {
  get<T>(store: StoreName, key: string): Promise<T | undefined>
  put(store: StoreName, key: string, value: unknown): Promise<void>
  del(store: StoreName, key: string): Promise<void>
  all<T>(store: StoreName): Promise<T[]>
}

/** A backend held in memory, for tests and for a page where storage is blocked. */
export function memoryBackend(): Backend {
  const maps = new Map<StoreName, Map<string, unknown>>(STORES.map((s) => [s, new Map()]))
  const m = (s: StoreName) => maps.get(s)!
  const copy = <T>(v: T): T => (v === undefined ? v : structuredClone(v))
  return {
    get: async (s, k) => copy(m(s).get(k)) as never,
    put: async (s, k, v) => void m(s).set(k, copy(v)),
    del: async (s, k) => void m(s).delete(k),
    all: async (s) => [...m(s).values()].map(copy) as never,
  }
}

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb did not open and gave no reason. a private window may block it.'))
    req.onblocked = () => reject(new Error('the workspace database is open in an older tab. close it and reload.'))
  })
  return opening
}

function run<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(store, mode).objectStore(store))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error ?? new Error(`indexeddb refused the ${mode} on ${store} and gave no reason.`))
      }),
  )
}

/** The page backend over IndexedDB. */
export const idbBackend: Backend = {
  get: (s, k) => run(s, 'readonly', (o) => o.get(k)),
  put: (s, k, v) => run<unknown>(s, 'readwrite', (o) => o.put(v, k)).then(() => undefined),
  del: (s, k) => run<unknown>(s, 'readwrite', (o) => o.delete(k)).then(() => undefined),
  all: (s) => run(s, 'readonly', (o) => o.getAll()),
}

export const kvGet = <T>(key: string) => idbBackend.get<T>('kv', key)
export const kvPut = (key: string, value: unknown) => idbBackend.put('kv', key, value)
