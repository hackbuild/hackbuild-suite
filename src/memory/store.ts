// The open memories, shared by the memory tool, chat and transcription
// (design 3.8). One wasm core for the page through core('memory'); one
// Memory per store id. The embedder is the hub's embed row when it is
// loaded: a transformers.js feature extraction pipeline, or under ?stub a
// hash embedder that downloads nothing. Without it recall is keyword only.
import { shallowRef } from 'vue'
import type { Core, Embedder, Memory, MemorySink, Recall, RecallTrace } from '@hackbuild/memory'
import type { SealKey, SealLock } from '@hackbuild/memory/seal'
import { core, coreState, provide } from '../cores.ts'
import * as hub from '../models/hub.ts'
import { CHAT_STORE } from './kind.ts'

/** The catalogue's embed row: all-MiniLM-L6-v2, 23 MB (inferred in the catalogue). */
export const EMBED_ID = 'all-minilm-l6-v2'
/** Memories a chat turn feeds the model. */
export const CHAT_K = 3

type Lib = typeof import('@hackbuild/memory')
let lib: Promise<Lib> | null = null
const memLib = () => (lib ??= import('@hackbuild/memory'))

function provideCore(): void {
  if (coreState('memory') !== 'idle') return
  provide('memory', async () => {
    const [{ loadCore }, { MEMORY_WASM_BASE64 }] = await Promise.all([memLib(), import('@hackbuild/memory/inline')])
    return loadCore({ base64: MEMORY_WASM_BASE64 })
  })
}

type Pipe = (texts: string[], o: Record<string, unknown>) => Promise<{ tolist(): number[][] }>

/** The loaded embed value as an Embedder: a feature extraction pipeline, else the stub's hash vectors. */
export function embedderOf(value: unknown, l: Lib): Embedder {
  if (typeof value === 'function') {
    const fx = value as Pipe
    return {
      id: EMBED_ID,
      dim: 384,
      async embed(texts) {
        const out = await fx(texts, { pooling: 'mean', normalize: true })
        return out.tolist().map((a) => Float32Array.from(a))
      },
    }
  }
  const h = l.hashedEmbedder()
  return { id: `stub-${h.id}`, dim: h.dim, embed: (t) => h.embed(t) }
}

async function currentEmbedder(l: Lib): Promise<Embedder | null> {
  if (hub.states.value[EMBED_ID]?.state !== 'loaded') return null
  try {
    const h = await hub.hub().use({ id: EMBED_ID })
    // the value stays usable after release; if the hub drops it, recall falls back to keywords
    hub.hub().release(h)
    return embedderOf(h.value, l)
  } catch {
    return null
  }
}

// Sealed stores (design 2.5b): item text, metadata, vectors and kv are
// sealed with a key from the password. The lock record sits plain in the
// store's own kv under LOCK_KV, so any tool that opens the store knows it
// is sealed, and in the character file (Profile.lock) and the memory
// document, so it travels with them. The key is derived once and cached
// for the page's life. There is no recovery.
export const LOCK_KV = 'suite:lock'
const sealLib = () => import('@hackbuild/memory/seal')
const locks = new Map<string, SealLock>()
/** Stores read as plain on this visit, so a chat turn does not reopen the database. */
const plain = new Set<string>()
/** Thrown by memory() for a sealed store whose password was not given on this visit. */
export class SealedStore extends Error {
  constructor(readonly store: string, readonly lock: SealLock) {
    super('this memory is sealed. give its password to open it.')
  }
}
/** Bumps when a store is sealed or opened with its password. */
export const sealRev = shallowRef(0)

async function innerSink(l: Lib, store: string): Promise<MemorySink | null> {
  try {
    return await l.indexedDbSink(store)
  } catch {
    return null
  }
}

/** The lock of a store: given on this visit, else read from its kv. */
export async function lockOf(store: string): Promise<SealLock | null> {
  if (locks.has(store)) return locks.get(store)!
  if (plain.has(store)) return null
  const inner = await innerSink(await memLib(), store)
  if (!inner) return null
  try {
    const lock = await inner.getKv<SealLock>(LOCK_KV)
    if (lock) locks.set(store, lock)
    else plain.add(store)
    return lock ?? null
  } finally {
    inner.close()
  }
}

/** 'plain', 'sealed' (no key on this visit) or 'open' (sealed, key held). */
export async function sealState(store: string): Promise<'plain' | 'sealed' | 'open'> {
  const lock = await lockOf(store)
  if (!lock) return 'plain'
  return (await sealLib()).cachedKey(lock) ? 'open' : 'sealed'
}

/** Know a store's lock from a file that carries it (a character, a memory document). */
export function knowLock(store: string, lock: SealLock): void {
  if (!locks.has(store)) locks.set(store, lock)
}

/** Open a sealed store with its password. Throws "wrong password." and names no more. */
export async function unlockStore(store: string, password: string): Promise<SealKey> {
  const lock = await lockOf(store)
  if (!lock) throw new Error('this memory is not sealed.')
  const s = await sealLib()
  try {
    const key = await s.deriveKey(password, lock)
    drop(store)
    sealRev.value += 1
    return key
  } catch (e) {
    if (e instanceof s.SealError && e.code === 'wrong-password') throw new Error('wrong password. there is no recovery.')
    throw e
  }
}

/** Seal a plain store in place: its export moves under a new lock. Returns the lock to keep in the character file. */
export async function sealStore(store: string, password: string): Promise<SealLock> {
  if (!password) throw new Error('type a password to seal with.')
  if (await lockOf(store)) throw new Error('this memory is sealed already.')
  const l = await memLib()
  const s = await sealLib()
  const was = await memory(store)
  const data = was.export()
  const { lock } = await s.makeLock(password)
  await was.sink.clear()
  drop(store)
  const inner = await innerSink(l, store)
  if (inner) {
    await inner.putKv(LOCK_KV, lock)
    inner.close()
  }
  locks.set(store, lock)
  plain.delete(store)
  const m = await memory(store)
  await m.import(data)
  sealRev.value += 1
  bump()
  return lock
}

/** A store's export sealed for a document body, bound to the store id. */
export async function sealExport(store: string, data: unknown): Promise<string> {
  const lock = await lockOf(store)
  const s = await sealLib()
  const key = lock && s.cachedKey(lock)
  if (!key) throw new SealedStore(store, lock!)
  return s.toBase64(await s.seal(key, data, `store:${store}`))
}

/** Open a sealed export from a document body. */
export async function openExport<T>(store: string, sealed: string): Promise<T> {
  const lock = await lockOf(store)
  const s = await sealLib()
  const key = lock && s.cachedKey(lock)
  if (!key) throw new SealedStore(store, lock!)
  return s.open<T>(key, s.fromBase64(sealed), `store:${store}`)
}

function drop(store: string): void {
  const had = open_.get(store)
  if (had) void had.mem.then((m) => m.close(), () => {})
  open_.delete(store)
}

const open_ = new Map<string, { embed: string; mem: Promise<Memory> }>()
/** Bumps on every change through this module, so views read again. */
export const rev = shallowRef(0)
export const bump = () => (rev.value += 1)

/** The memory named store, opened with the embedder the hub holds now. */
export async function memory(store: string): Promise<Memory> {
  provideCore()
  const l = await memLib()
  const e = await currentEmbedder(l)
  const key = e?.id ?? ''
  const had = open_.get(store)
  if (had && had.embed === key) return had.mem
  if (had) void had.mem.then((m) => m.close(), () => {})
  const lock = await lockOf(store)
  let sink: MemorySink | undefined
  if (lock) {
    const key = (await sealLib()).cachedKey(lock)
    if (!key) throw new SealedStore(store, lock)
    const inner = (await innerSink(l, store)) ?? l.memorySink()
    sink = (await sealLib()).sealedSink(inner, key)
  }
  const mem = core<Core>('memory').then((c) => l.open(store, { core: c, embed: e, ...(sink ? { sink } : {}) }))
  open_.set(store, { embed: key, mem })
  mem.catch(() => open_.delete(store))
  return mem
}

/** What the last chat reply was fed: its query and memory ids. */
export const lastUsed = shallowRef<{ query: string; ids: number[] } | null>(null)
const recalls = new Map<string, Recall>()

/** Recall for a chat turn; the recall is kept so its trace can be shown later. */
export async function recallFor(text: string, skipSaid: string[] = []): Promise<{ id: string; text: string }[]> {
  // a sealed memory with no password on this visit recalls nothing
  if ((await sealState(CHAT_STORE)) === 'sealed') return []
  const m = await memory(CHAT_STORE)
  if (!m.size) return []
  const r = await m.recall(text, { k: CHAT_K, skipSaid })
  recalls.set(text, r)
  if (recalls.size > 40) recalls.delete(recalls.keys().next().value!)
  lastUsed.value = { query: text, ids: r.hits.map((h) => h.item.id) }
  return r.hits.map((h) => ({ id: String(h.item.id), text: h.item.text }))
}

/** The trace of a past chat recall, or the same query explained now when this visit did not run it. */
export async function traceFor(query: string): Promise<RecallTrace> {
  const m = await memory(CHAT_STORE)
  const r = recalls.get(query)
  return r ? m.trace(r) : m.explain(query, { k: CHAT_K })
}

/** Save one line; merged when a near duplicate is already there. */
export async function saveLine(text: string, o: { store?: string; kind?: 'fact' | 'note' | 'doc'; from: string; section?: string }): Promise<{ id: number; merged: boolean }> {
  const m = await memory(o.store ?? CHAT_STORE)
  const r = await m.add(text, { kind: o.kind ?? 'fact', meta: { from: o.from }, ...(o.section ? { section: o.section } : {}) })
  bump()
  return r
}
