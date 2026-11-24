// The workspace database. Item 2.5 grows this into documents, autosave,
// export and import; for now it holds one key value store so the single
// file build can prove an IndexedDB write from file://.

const DB = 'hackbuild-suite'
const STORE = 'kv'

let opening: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('indexeddb did not open'))
  })
  return opening
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error ?? new Error('indexeddb request failed'))
      }),
  )
}

export const kvGet = <T>(key: string) => run<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>)
export const kvPut = (key: string, value: unknown) => run('readwrite', (s) => s.put(value, key)).then(() => undefined)
