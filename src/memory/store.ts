// The open memories, shared by the memory tool, chat and transcription
// (design 3.8). One wasm core for the page through core('memory'); one
// Memory per store id. The embedder is the hub's embed row when it is
// loaded: a transformers.js feature extraction pipeline, or under ?stub a
// hash embedder that downloads nothing. Without it recall is keyword only.
import { shallowRef } from 'vue'
import type { Core, Embedder, Memory, Recall, RecallTrace } from '@hackbuild/memory'
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
  const mem = core<Core>('memory').then((c) => l.open(store, { core: c, embed: e }))
  open_.set(store, { embed: key, mem })
  mem.catch(() => open_.delete(store))
  return mem
}

/** What the last chat reply was fed: its query and memory ids. */
export const lastUsed = shallowRef<{ query: string; ids: number[] } | null>(null)
const recalls = new Map<string, Recall>()

/** Recall for a chat turn; the recall is kept so its trace can be shown later. */
export async function recallFor(text: string, skipSaid: string[] = []): Promise<{ id: string; text: string }[]> {
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
