<script setup lang="ts">
// The memory tool (design 3.8): inspect, search with the live ranker and
// its trace, add, edit, forget, pin, compact, import and export. The
// memory lives in its own store; the open document carries a copy of its
// export, so every change is an undo step and undo puts the store back.
import { computed, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import { useRoute } from 'vue-router'
import {
  HbButton, HbCallout, HbEngineBar, HbHow, HbMemoryPanel, HbPanel, HbRecallTrace, HbSelect, HbToolbar, useHotkeys,
  type HbEngineState, type HbMemoryEntry, type HbRecallHit,
} from '@virgilvox/hackbuild-ui'
import { saveFile } from '@virgilvox/hackbuild-ui/vanilla'
import type { Memory, RecallTrace } from '@hackbuild/memory'
import * as hub from '../models/hub.ts'
import { loadModels } from '../models/lazy'
import { logEvent, overlay, useComposer } from '../shell/shell.ts'
import { docs, kinds, registerKind, useDocument, ws } from '../workspace/state'
import { emptyData, MEMORY_KIND, memoryKind, newStore, readExport, type MemoryBody } from './kind.ts'
import { ADD_KINDS, PINNED, pinCount, pinIndex, toEntries, traceEntries, traceHits } from './lines.ts'
import { bump, EMBED_ID, lastUsed, memory, rev } from './store.ts'

if (!kinds.get(MEMORY_KIND)) registerKind(memoryKind)

const route = useRoute()
const doc = useDocument<MemoryBody>(MEMORY_KIND)
const mem = shallowRef<Memory | null>(null)
const failed = ref('')
const query = ref(typeof route.query.q === 'string' ? route.query.q : '')
const kind = ref('')
const all = shallowRef<HbMemoryEntry[]>([])
const found = shallowRef<HbMemoryEntry[] | null>(null)
const trace = shallowRef<RecallTrace | null>(null)
const weights = ref<Record<string, number> | null>(null)
const storage = shallowRef<{ used: number | null; quota: number | null; persisted: boolean | null } | null>(null)

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function refresh(): Promise<void> {
  const m = mem.value
  if (!m) return
  all.value = toEntries(m.all(), m.core.lines)
  const u = await m.usage()
  storage.value = u.browser ? { used: u.browser.usage, quota: u.browser.quota, persisted: u.browser.persisted } : null
  await search(query.value)
}

/** Every change ends here: the store's export becomes the document body, one undo step. */
async function commit(line: string): Promise<void> {
  const m = mem.value
  if (!m || !doc.doc.value) return
  const store = doc.doc.value.body.store
  doc.edit(() => ({ store, data: m.export() }))
  bump()
  logEvent('note', line)
  await refresh()
}

/** Open the document's store. An empty store takes the document's copy; else the store is the truth and the document is brought up to it with no undo step. */
async function attach(): Promise<void> {
  const d = doc.doc.value
  if (!d) return
  try {
    const m = await memory(d.body.store)
    mem.value = m
    failed.value = ''
    const data = m.export()
    const held = d.body.data
    if (!data.items.length && !data.core.length && (held.items.length || held.core.length)) await m.import(held)
    else if (!same(data, held)) {
      ws.change({ ...d, body: { store: d.body.store, data } })
      await ws.flush()
      await doc.open(d.id)
    }
  } catch (err) {
    failed.value = `the memory core did not load: ${err instanceof Error ? err.message : String(err)}. the list still shows. search and add are off until you reload.`
    all.value = toEntries(d.body.data.items, d.body.data.core)
    return
  }
  await refresh()
}

// undo and redo change the body: put the store back to it
watch(
  () => doc.doc.value?.body,
  async (b) => {
    const m = mem.value
    if (!b || !m || doc.doc.value?.body.store !== b.store || same(m.export(), b.data)) return
    await m.import(b.data)
    bump()
    await refresh()
  },
)
// chat or transcription saved a line, or the embedder changed
watch(rev, () => void refresh())
watch(() => hub.states.value[EMBED_ID]?.state, async (s, was) => {
  if (s === was || (s !== 'loaded' && was !== 'loaded') || !doc.doc.value) return
  mem.value = await memory(doc.doc.value.body.store)
  await refresh()
})

async function search(q: string): Promise<void> {
  const m = mem.value
  if (!m || !q.trim()) {
    found.value = null
    trace.value = null
    return
  }
  const t = await m.explain(q, { k: 6 })
  if (q !== query.value.trim() && q !== query.value) return
  trace.value = t
  if (!weights.value) weights.value = { ...t.params.weights }
  found.value = traceEntries(t, m.all())
}

const items = computed(() => found.value ?? all.value)
const kindList = computed(() => [...new Set([...ADD_KINDS, ...all.value.map((e) => e.kind)])])
const used = computed(() => {
  const ids = new Set((lastUsed.value?.ids ?? []).map(String))
  return all.value.filter((e) => ids.has(e.id))
})
const hits = computed<HbRecallHit[]>(() => (trace.value ? traceHits(trace.value) : []))
const pins = computed(() => (void all.value, mem.value?.core.lines ?? []))
const mode = computed(() => (mem.value?.status.mode === 'hybrid' ? 'hybrid keyword and vector' : 'keyword only'))
const modeLine = computed(() => {
  if (failed.value) return failed.value
  if (!mem.value) return 'opening this memory.'
  if (mem.value.status.mode === 'keyword') return 'no embedder loaded. search matches words only. load the 23 mb embedder for meaning.'
  return hub.STUB ? 'stub embedder: hash vectors, nothing downloaded. it matches shared words, not meaning.' : 'embedder loaded: search matches meaning and words.'
})

async function add(e: { text: string; kind: string }): Promise<void> {
  const m = mem.value
  if (!m) return
  if (e.kind === PINNED) {
    if (!(await m.remember(e.text))) return void logEvent('note', 'that line is pinned already.')
    return commit(`pinned: ${e.text}`)
  }
  const r = await m.add(e.text, { kind: e.kind as 'fact', meta: { from: 'note' } })
  await commit(r.merged ? `strengthened a memory like: ${e.text}` : `remembered: ${e.text}`)
}
async function edit(id: string, text: string): Promise<void> {
  const m = mem.value
  if (!m) return
  const p = pinIndex(id)
  if (p >= 0) {
    const old = m.core.lines[p]
    if (old === undefined) return
    m.core.lines = m.core.lines.map((l, i) => (i === p ? text : l))
    await m.sink.putKv('core', m.core.lines)
    return commit(`pinned line changed: ${text}`)
  }
  if (await m.edit(Number(id), { text })) await commit(`memory changed: ${text}`)
}
async function forget(id: string): Promise<void> {
  const m = mem.value
  if (!m) return
  const p = pinIndex(id)
  if (p >= 0) {
    const old = m.core.lines[p]
    m.core.lines = m.core.lines.filter((_, i) => i !== p)
    await m.sink.putKv('core', m.core.lines)
    return commit(`unpinned: ${old}`)
  }
  const it = m.get(Number(id))
  await m.remove([Number(id)])
  await commit(`forgot: ${it?.text ?? id}`)
}
async function wipe(): Promise<void> {
  const m = mem.value
  if (!m) return
  const n = m.size
  await m.remove(m.all().map((it) => it.id))
  m.core.lines = []
  await m.sink.putKv('core', [])
  await commit(`forgot all ${n} memories. undo brings them back.`)
}
async function compact(): Promise<void> {
  const m = mem.value
  if (!m) return
  const r = await m.compact()
  const gist = r.gist ? `, ${r.gist.folded} episodes folded into a gist` : ''
  await commit(`compacted: ${r.before} to ${r.after} memories. ${r.decayed.length} faded, ${r.merged.length} merged${gist}.`)
}
function exportMem(): void {
  const m = mem.value
  if (!m) return
  saveFile(`${doc.doc.value?.name ?? 'memory'}.memory.json`, JSON.stringify(m.export(), null, 2), 'application/json')
  logEvent('note', `exported ${m.size} memories and ${m.core.lines.length} pinned lines.`)
}
async function importMem(file: File): Promise<void> {
  const m = mem.value
  if (!m) return
  try {
    const n = await m.import(readExport(await file.text(), file.name))
    await commit(`imported ${n} memories from ${file.name}. it replaced what was here; undo puts it back.`)
  } catch (err) {
    logEvent('fail', err instanceof Error ? err.message : String(err))
  }
}
async function persist(): Promise<void> {
  const ok = await mem.value?.persist()
  logEvent(ok ? 'note' : 'warn', ok ? 'the browser will keep this memory.' : 'the browser said no to keeping this. export the memory to be safe.')
  await refresh()
}

// Which memory: each document names one store.
const memDocs = computed(() => docs.value.filter((d) => d.kind === MEMORY_KIND).map((d) => ({ value: d.id, label: d.name })))
const pickDoc = computed({
  get: () => doc.doc.value?.id ?? '',
  set: (id: string) => void doc.open(id).then(attach),
})
async function newMemory(): Promise<void> {
  const d = await doc.create('new memory')
  const store = newStore()
  ws.change({ ...d, body: { store, data: emptyData(store) } })
  await ws.flush()
  await doc.open(d.id)
  await attach()
}

// The embedder row on the hub.
const embedRec = computed(() => hub.allRecords.value.find((r) => r.id === EMBED_ID))
const embedState = computed<HbEngineState>(() => {
  const s = hub.states.value[EMBED_ID]?.state ?? 'none'
  return s === 'loaded' || s === 'stored' || s === 'downloading' || s === 'fault' ? s : 'none'
})
const embedFacts = computed(() => {
  const st = hub.states.value[EMBED_ID]
  return { pct: st?.state === 'downloading' && st.total ? (st.loaded ?? 0) / st.total : null, error: st?.state === 'fault' ? st.error : '' }
})

// Keys: "/" search, "n" new note.
const root = ref<HTMLElement | null>(null)
useComposer({ get value() { return root.value?.querySelector<HTMLElement>('.hb-mempanel input[type=search]') ?? null } } as Ref<HTMLElement | null>)
useHotkeys([{ keys: 'n', label: 'new note', group: 'tool', run: () => root.value?.querySelector<HTMLElement>('.hb-mempanel textarea')?.focus() }])

const HOW = `import { loadCore, open, hashedEmbedder } from "@hackbuild/memory";
import { MEMORY_WASM_BASE64 } from "@hackbuild/memory/inline";

const core = await loadCore({ base64: MEMORY_WASM_BASE64 });
const mem = await open("chat", { core, embed: hashedEmbedder() });
const { id } = await mem.add("the mug goes on the shelf", { kind: "fact" });
const t = await mem.explain("where does the mug go"); // t.rows: rank, score, parts
await mem.edit(id, { text: "the mug goes on the top shelf" });
await mem.remove([id]);
const json = mem.export(); await mem.import(json);`

watch(() => route.query.q, (q) => { if (typeof q === 'string') query.value = q })
onMounted(async () => {
  const id = route.query.doc
  await doc.open(typeof id === 'string' ? id : undefined)
  await attach()
  await loadModels()
})
</script>

<template>
  <div ref="root" class="hb-toolpage">
    <HbEngineBar
      label="embedder"
      :model="embedRec ? embedRec.label ?? embedRec.id : ''"
      :state="embedState"
      :device="embedRec?.ladder[0]?.device ?? ''"
      :size-m-b="embedRec?.sizeMB ?? null"
      :pct="embedFacts.pct"
      :error="embedFacts.error"
      @change="overlay = 'models'"
      @load="hub.load(EMBED_ID)"
      @cancel="hub.cancel(EMBED_ID)"
      @unload="hub.unload(EMBED_ID)"
    />
    <HbPanel :heading="doc.doc.value?.name ?? 'memory'">
      <HbToolbar>
        <HbSelect v-model="pickDoc" aria-label="which memory" :options="memDocs" />
        <HbButton variant="secondary" size="sm" @click="newMemory">new memory</HbButton>
        <HbButton v-if="embedState === 'none' || embedState === 'fault'" variant="secondary" size="sm" @click="hub.load(EMBED_ID)">load embedder{{ embedRec?.sizeMB ? `, ${Math.round(embedRec.sizeMB)} mb` : '' }}</HbButton>
        <HbButton variant="secondary" size="sm" :disabled="!mem" @click="compact">compact</HbButton>
        <HbButton variant="ghost" size="sm" :disabled="!doc.canUndo.value" @click="doc.undo()">undo</HbButton>
        <HbButton variant="ghost" size="sm" :disabled="!doc.canRedo.value" @click="doc.redo()">redo</HbButton>
      </HbToolbar>
      <HbCallout variant="info">{{ modeLine }} pinned: {{ pinCount(pins) }}, kept in every prompt.</HbCallout>
    </HbPanel>

    <HbMemoryPanel
      v-model:query="query"
      v-model:kind="kind"
      :items="items"
      :all="all"
      :kinds="kindList"
      :storage="storage"
      :last-used="used"
      :search-mode="mode"
      :readonly="!mem"
      @search="search"
      @add="add"
      @edit="edit"
      @forget="forget"
      @export="exportMem"
      @import="importMem"
      @wipe="wipe"
      @persist="persist"
    />

    <HbPanel heading="recall trace">
      <HbRecallTrace v-model:weights="weights" :hits="hits" :query="trace?.query ?? lastUsed?.query ?? ''" :how="trace?.how ?? ''" who="chat" tunable :names="{ rel: 'relevance', rec: 'recency', imp: 'importance' }" />
    </HbPanel>
    <HbHow
        :packages="['@hackbuild/memory', '@hackbuild/models']"
        install="npm i @hackbuild/memory @hackbuild/models"
        :code="HOW"
      persist-key="memory-how"
    />
  </div>
</template>
