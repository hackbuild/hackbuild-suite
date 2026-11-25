// One weight store and one models hub for the whole suite (design 2.2, 2.4).
// Every tool takes the hub from here and never builds its own. This module
// is a lazy chunk: the shell imports it after the first paint. Nothing here
// fetches a weight: downloads start from a button that names the size.
//
// ?stub in the url swaps every provider for a stub that loads nothing and
// keeps the store in memory, for shots and smokes.
import { computed, shallowRef } from 'vue'
import { probe, type Env } from '@hackbuild/ai-env'
import { memoryBackend, openWeightStore, transformersCache, type DownloadRow, type Estimate, type WeightStore } from '@hackbuild/weights'
import {
  CATALOG, HubError, PRESETS, SLOTS, budgetFor, createHub, createRegistry, fitOf, presetTotal, suggestDefaults,
  type Capability, type Factory, type FitResult, type HubStatus, type ModelRecord, type Slot,
} from '@hackbuild/models'
import { humanError, loadTransformers, tjsProvider, wasmThreads } from '@hackbuild/devices'
import type {
  HbCap, HbCustomEntry, HbModelStatus, HbRackPreset, HbRackSlot, HbRackSlotState, HbReasonRow, HbResident,
  HbStorage, HbStoredWeight,
} from '@virgilvox/hackbuild-ui'
import { customId, type CustomCheck, type CustomMode, type CustomValues } from '@virgilvox/hackbuild-ui/vanilla'
import { createEngine } from '@hackbuild/chat'
import { transformersDriver, type TextGenerationLike, type TransformersModule } from '@hackbuild/chat/transformers'
import { jobs, logEvent } from '../shell/shell.ts'
import { threadsOffWhy } from '../shell/isolation.ts'

const MB = 1024 * 1024
export const STUB = typeof location !== 'undefined' && new URLSearchParams(location.search).has('stub')
const mbText = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} gb` : `${Math.round(mb)} mb`)

export const registry = createRegistry(CATALOG)
let store!: WeightStore
/** The one weight store, open once start() resolves. */
export const weights = (): WeightStore => store

/** Filled by start(): the probe, then the hub on it. */
export const env = shallowRef<Env | null>(null)
let hubRef: ReturnType<typeof createHub> | null = null
export function hub(): ReturnType<typeof createHub> {
  if (!hubRef) throw new Error('the models hub starts with the shell; call start() first')
  return hubRef
}

// Live state the panels read.
const records = shallowRef<ModelRecord[]>(registry.list())
const status = shallowRef<HubStatus[]>([])
const progress = shallowRef<Record<string, number | null>>({})
const faults = shallowRef<Record<string, string>>({})
const keys = shallowRef<{ key: string; bytes: number; updated: number }[]>([])
const downloads = shallowRef<DownloadRow[]>([])
const estimate = shallowRef<Estimate | null>(null)
const persisted = shallowRef<boolean | null>(null)
const aborts = new Map<string, AbortController>()
/** Providers with a factory on the hub; the chat item adds webllm and wllama. */
const runnable = shallowRef(new Set<string>())
const unloading = new Set<string>()

export const allRecords = computed(() => records.value)

/** Which record a store key or url belongs to, by its repo or model id. */
function owner(text: string): ModelRecord | undefined {
  return records.value.find((r) => {
    const s = r.source
    return [s.modelId, s.repo, s.url].some((x) => x && text.includes(x))
  })
}
const label = (id: string) => registry.get(id)?.label ?? id

export const fits = computed<Record<string, FitResult>>(() => {
  const e = env.value
  if (!e) return {}
  const budget = budgetFor(e)
  return Object.fromEntries(records.value.map((r) => [r.id, fitOf(r, e, estimate.value, budget)]))
})

/** WebLLM keeps its own IndexedDB cache; the chat tool hands its adapter in with keepWebllm. */
export interface KeptCache {
  list(): Promise<{ modelId: string; bytes: number }[]>
  evict(modelId: string): Promise<void>
}
let webllmKeeper: KeptCache | null = null
const kept = shallowRef<{ modelId: string; bytes: number }[]>([])
async function refreshKept(): Promise<void> {
  kept.value = webllmKeeper ? await webllmKeeper.list().catch(() => []) : []
}
/** Show webllm's own cache as the "kept by webllm" group, and remove from it. */
export async function keepWebllm(cache: KeptCache): Promise<void> {
  webllmKeeper = cache
  await refreshKept()
}

const storedIds = computed(() => new Set([...keys.value.map((k) => owner(k.key)?.id), ...kept.value.map((k) => owner(k.modelId)?.id)].filter((x): x is string => !!x)))
const loadedIds = computed(() => new Set(status.value.map((s) => s.id)))

export const states = computed<Record<string, HbModelStatus>>(() => {
  const out: Record<string, HbModelStatus> = {}
  for (const r of records.value) {
    const rows = downloads.value.filter((d) => owner(d.url)?.id === r.id)
    if (r.id in progress.value || rows.length) {
      const known = rows.length && rows.every((d) => d.total !== null)
      const f = progress.value[r.id] ?? null
      out[r.id] = rows.length
        ? { state: 'downloading', loaded: rows.reduce((a, d) => a + d.loaded, 0), total: known ? rows.reduce((a, d) => a + (d.total ?? 0), 0) : null }
        : { state: 'downloading', loaded: f !== null && r.sizeMB ? f * r.sizeMB * MB : 0, total: r.sizeMB ? r.sizeMB * MB : null }
    } else if (faults.value[r.id]) out[r.id] = { state: 'fault', error: faults.value[r.id] }
    else if (loadedIds.value.has(r.id)) out[r.id] = { state: 'loaded' }
    else if (storedIds.value.has(r.id)) out[r.id] = { state: 'stored' }
    else out[r.id] = { state: 'none' }
  }
  return out
})

const ago = (t: number) => {
  const d = Math.floor((Date.now() - t) / 86400000)
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`
}

/** Stored weights, one row per record, and loose keys by themselves. */
export const stored = computed<HbStoredWeight[]>(() => {
  const by = new Map<string, HbStoredWeight & { updated: number }>()
  for (const k of keys.value) {
    const id = owner(k.key)?.id ?? k.key
    const row = by.get(id) ?? { key: id, label: label(id), bytes: 0, updated: 0, keeper: 'store' as const }
    row.bytes = (row.bytes ?? 0) + k.bytes
    row.updated = Math.max(row.updated, k.updated)
    by.set(id, row)
  }
  const mine = [...by.values()].map(({ updated, ...r }) => ({ ...r, lastUsed: ago(updated) }))
  const theirs = kept.value.map((k): HbStoredWeight => {
    const id = owner(k.modelId)?.id ?? k.modelId
    return { key: id, label: label(id), bytes: k.bytes, keeper: 'webllm' }
  })
  return [...mine, ...theirs]
})

export const resident = computed<HbResident[]>(() => status.value.map((s) => ({ id: s.id, label: label(s.id), mb: s.sizeMB })))

export const storage = computed<HbStorage | null>(() =>
  estimate.value ? { used: estimate.value.used, quota: estimate.value.quota, persisted: persisted.value } : null,
)

export const budget = computed(() => budgetFor(env.value ?? undefined))
export const policy = computed(() => `unloads the least recently used model past ${mbText(budget.value.mb)} (proposed). ${budget.value.why}.`)

export const defaults = computed(() =>
  suggestDefaults(env.value ?? undefined, { catalogue: records.value, stored: [...storedIds.value], estimate: estimate.value }),
)
export const reasons = computed<HbReasonRow[]>(() => defaults.value.reasons.map((r) => ({ key: r.label, label: r.label, value: r.value, why: r.why, edit: false })))
export const defaultId = computed(() => defaults.value.patch.model ?? defaults.value.download?.id ?? null)

/** The probe in one line. */
export const machine = computed(() => {
  const e = env.value
  if (!e) return 'checking this machine.'
  const parts = [e.webgpu ? 'webgpu' : 'no webgpu adapter']
  if (e.adapter) parts.push(`${e.adapter.vendor} ${e.adapter.architecture}`.trim())
  if (e.f16) parts.push('shader-f16')
  const n = wasmThreads(e)
  const off = threadsOffWhy()
  parts.push(n > 1 ? `${n} wasm threads, cross origin isolated` : `threads: off here, ${off ?? 'this machine has one core'}`)
  parts.push(e.deviceMemoryGB ? `${e.deviceMemoryGB} gb memory or more` : 'memory unknown')
  return parts.join(', ')
})

/** Header pills: what is loaded per organ. */
const ORGANS: Record<string, Capability[]> = {
  brain: ['chat'],
  voice: ['speak'],
  ears: ['transcribe', 'vad'],
  eyes: ['vision.caption', 'vision.ask', 'depth', 'detect', 'segment'],
  memory: ['embed'],
}
export function organ(name: string): { state: 'off' | 'load' | 'ok' | 'err'; title: string } {
  const caps = ORGANS[name] ?? []
  const of = records.value.filter((r) => r.provides.some((c) => caps.includes(c)))
  const by = (s: string) => of.filter((r) => states.value[r.id]?.state === s)
  const loaded = by('loaded')
  if (loaded.length) return { state: 'ok', title: `loaded: ${loaded.map((r) => r.label ?? r.id).join(', ')}` }
  const busy = by('downloading')
  if (busy.length) return { state: 'load', title: `loading ${busy[0]!.label ?? busy[0]!.id}` }
  const bad = by('fault')
  if (bad.length) return { state: 'err', title: faults.value[bad[0]!.id] ?? 'failed' }
  return { state: 'off', title: 'no model loaded' }
}

async function refreshStore(): Promise<void> {
  const ks = await store.keys()
  const metas = await Promise.all(ks.map((k) => store.meta(k)))
  keys.value = metas.filter((m) => !!m).map((m) => ({ key: m!.key, bytes: m!.parts.reduce((a, b) => a + b, 0), updated: m!.updated }))
  estimate.value = await store.estimate()
  persisted.value = await store.persisted()
  await refreshKept()
}

function refreshHub(): void {
  const before = new Set(status.value.map((s) => s.id))
  status.value = hub().status()
  for (const id of before) {
    if (loadedIds.value.has(id) || unloading.has(id)) continue
    logEvent('load', `unloaded ${label(id)} to make room. the weights stay stored.`)
  }
  unloading.clear()
}

let started: Promise<void> | null = null
/** Probe, then build the one hub. Safe to call more than once. */
export function start(): Promise<void> {
  if (!started) started = boot()
  return started
}

async function boot(): Promise<void> {
  const [e, w] = await Promise.all([probe(), openWeightStore(STUB ? { backends: [memoryBackend()], locks: false } : {})])
  store = w
  const b = budgetFor(e)
  hubRef = createHub({
    registry,
    env: e,
    budgetMB: b.mb,
    onLicence: (_line, r) => {
      const from = r.source.url ? new URL(r.source.url).host : r.source.modelId || r.source.repo ? 'huggingface.co' : 'nowhere, it has no weights'
      logEvent('load', `weights: ${r.label ?? r.id}, licence as recorded: ${r.licence}. from ${from}.`)
    },
  })
  if (STUB) {
    for (const p of new Set(records.value.map((r) => r.provider))) {
      hubRef.provide(p, fake)
      runnable.value.add(p)
    }
  } else {
    // transformers.js records load here; the chat item adds webllm and wllama.
    const tjs = tjsProvider({
      runtime: loadTransformers(),
      cache: transformersCache(store, { licenceFor: (url) => owner(url)?.licence ?? null }),
    })
    tjs.loader('chat', (ctx) => {
      const pipeline = ctx.tjs.pipeline
      if (!pipeline) throw new Error('the transformers.js module has no pipeline export')
      // the chat tool streams through a chat engine: think split, stats and stop
      return Promise.resolve(pipeline('text-generation', ctx.record.source.modelId ?? ctx.record.id, ctx.options)).then((generator) =>
        createEngine(transformersDriver({ module: ctx.tjs as unknown as TransformersModule, generator: generator as TextGenerationLike, id: ctx.record.id }), {
          ...(ctx.record.quirks?.systemRole === false ? { quirks: { systemRole: false } } : {}),
        }),
      )
    })
    hubRef.provide('tjs', tjs.factory)
    runnable.value.add('tjs')
    tjsRef = tjs
  }
  hubRef.onLoad((ev) => {
    const p = { ...progress.value }
    if (ev.phase === 'ready' || ev.phase === 'failed') delete p[ev.id]
    else p[ev.id] = ev.fraction
    progress.value = p
    const id = `model-${ev.id}`
    if (ev.phase === 'fetch' || ev.phase === 'compile' || ev.phase === 'warm') {
      jobs.set(id, `loading ${label(ev.id)}`)
      logEvent('load', `${label(ev.id)}: ${ev.phase}${ev.fraction === null ? '' : ` ${Math.round(ev.fraction * 100)} percent`}`, { id, live: true, fraction: ev.fraction ?? undefined })
    } else if (ev.phase === 'ready') {
      jobs.end(id)
      logEvent('load', `${label(ev.id)}: loaded`, { id })
    }
  })
  store.onDownloads((rows) => {
    const ended = downloads.value.length > rows.length
    downloads.value = rows
    if (ended) void refreshStore()
  })
  env.value = e
  runnable.value = new Set(runnable.value)
  await refreshStore()
}

// Under ?stub every provider loads nothing; a tool adds stub models by
// capability (a transcriber, a detector) and the stub returns that one.
const stubs = new Map<string, (r: ModelRecord) => unknown>()
async function fake(ctx: { record: ModelRecord; signal?: AbortSignal; report?: (p: 'fetch', f: number | null) => void }): Promise<unknown> {
  for (let i = 1; i <= 4; i++) {
    if (ctx.signal?.aborted) throw new DOMException('stopped', 'AbortError')
    await new Promise((r) => setTimeout(r, 150))
    ctx.report?.('fetch', i / 4)
  }
  const make = ctx.record.provides.map((c) => stubs.get(c)).find((f) => f)
  return make ? make(ctx.record) : { stub: true, id: ctx.record.id }
}
/** Stub models by capability, and the stub runtime for each provider named; ?stub only. */
export function addStubs(map: Record<string, (r: ModelRecord) => unknown>, providers: string[] = []): void {
  for (const [cap, make] of Object.entries(map)) stubs.set(cap, make)
  for (const p of providers) if (!runnable.value.has(p)) provideRuntime(p, fake)
}

let tjsRef: ReturnType<typeof tjsProvider> | null = null
/** The transformers.js provider of the one hub, for a tool to add loaders; null under ?stub. */
export const transformers = () => tjsRef

/** A tool adds the runtime for a provider (webllm, wllama) to the one hub. */
export function provideRuntime(provider: string, factory: Factory): void {
  hub().provide(provider, factory)
  runnable.value = new Set([...runnable.value, provider])
}

/** Load a record into memory; the download, when it needs one, goes through the store. */
export async function load(id: string): Promise<void> {
  await start()
  const f = { ...faults.value }
  delete f[id]
  faults.value = f
  const ac = new AbortController()
  aborts.set(id, ac)
  try {
    const l = await hub().use({ id }, { signal: ac.signal })
    // nothing holds it yet: it stays resident until the budget needs room
    hub().release(l)
  } catch (err) {
    const stopped = ac.signal.aborted
    const provider = registry.get(id)?.provider
    const line = stopped
      ? `stopped ${label(id)}. finished files are kept.`
      : err instanceof HubError && err.code === 'no-provider'
        ? `the ${provider} runtime is not in this build yet. it comes with the tool that uses it.`
        : humanError('model', err)
    if (!stopped) faults.value = { ...faults.value, [id]: line }
    jobs.fail(`model-${id}`, line)
    logEvent(stopped ? 'note' : 'fail', `${label(id)}: ${line}`, { id: `model-${id}` })
    const p = { ...progress.value }
    delete p[id]
    progress.value = p
  } finally {
    aborts.delete(id)
    refreshHub()
    void refreshStore()
  }
}

/** Stop one download for every caller; its parts stay for resume. */
export function cancel(id: string): void {
  aborts.get(id)?.abort()
  if (store) for (const d of downloads.value) if (owner(d.url)?.id === id) store.cancel(d.key)
}

export async function unload(id: string): Promise<void> {
  await start()
  unloading.add(id)
  await hub().unload(id)
  refreshHub()
  logEvent('note', `unloaded ${label(id)}. the weights stay stored.`)
}

/** Remove a record's stored files, or one loose key. */
export async function evict(id: string): Promise<void> {
  await start()
  const doomed = keys.value.filter((k) => (owner(k.key)?.id ?? k.key) === id)
  for (const k of doomed) await store.evict(k.key)
  for (const k of kept.value) if ((owner(k.modelId)?.id ?? k.modelId) === id) await webllmKeeper?.evict(k.modelId)
  logEvent('note', `removed ${label(id)} from this browser.`)
  await refreshStore()
}

export async function persist(): Promise<void> {
  await start()
  const ok = await store.persist()
  logEvent(ok ? 'note' : 'warn', ok ? 'storage kept: the browser will not clear it without asking.' : 'the browser refused to keep storage. it may clear the weights when space runs low.')
  await refreshStore()
}

// The slot rack (design 2.2 section 2): one row per organ that has records.
const SLOT_CAPS: Record<Slot, Capability[]> = {
  brain: ['chat'], smallBrain: ['chat'], embedder: ['embed'], ears: ['transcribe'], vad: ['vad'], voice: ['speak'],
  eyes: ['vision.caption', 'vision.ask'], depth: ['depth'], mask: ['segment'], detector: ['detect'], image: ['imagegen'],
}
export const rackSlots = computed<HbRackSlot[]>(() =>
  SLOTS.map(({ slot, label: l }) => ({
    slot,
    label: l,
    required: slot === 'brain',
    options: records.value
      .filter((r) => r.provides.some((c) => SLOT_CAPS[slot].includes(c)))
      .map((r) => {
        const fit = fits.value[r.id]
        return { value: r.id, label: r.label ?? r.id, sizeMB: r.sizeMB, sizeSource: r.sizeSource, disabled: fit && !fit.ok ? fit.reason : undefined }
      }),
  })),
)
/** Remove pressed on a rack slot whose pick the catalogue no longer has: the rack clears the pick. */
export function removeSlot(slot: string): void {
  const l = SLOTS.find((s) => s.slot === slot)?.label ?? slot
  logEvent('note', `${l}: the pick is not in the catalogue, so it was cleared. pick another or leave it empty.`)
}
export const rackPresets = computed<HbRackPreset[]>(() =>
  PRESETS.map((p) => {
    const t = presetTotal(p, records.value)
    return { id: p.id, label: p.label, picks: p.picks as Record<string, string>, totalMB: t.mb, totalSource: t.source, unknown: t.unknown }
  }),
)
export function rackStates(picks: Record<string, string>): Record<string, HbRackSlotState> {
  const out: Record<string, HbRackSlotState> = {}
  for (const s of rackSlots.value) {
    const id = picks[s.slot] ?? s.options?.[0]?.value
    const st = id ? states.value[id] : undefined
    if (!st) continue
    if (st.state === 'loaded') out[s.slot] = { state: 'ready' }
    else if (st.state === 'downloading') out[s.slot] = { state: 'loading', pct: st.total ? (st.loaded ?? 0) / st.total : null }
    else if (st.state === 'fault') out[s.slot] = { state: 'fault', fault: st.error }
  }
  return out
}

// The capability panel (design 2.4): one row per thing that can be turned on.
const perms = shallowRef<Record<'mic' | 'camera', { state: 'off' | 'loading' | 'on' | 'failed'; reason?: string }>>({ mic: { state: 'off' }, camera: { state: 'off' } })

/** Best record for a job: stored first, then fits, then the start group, then smallest. */
function pick(cap: Capability, want: (r: ModelRecord) => boolean = () => true): ModelRecord | undefined {
  const rank = (r: ModelRecord) =>
    (runnable.value.has(r.provider) ? 0 : 8) + (storedIds.value.has(r.id) ? 0 : 4) + (fits.value[r.id]?.ok ? 0 : 2) + (r.group === 'start here' ? 0 : 1)
  return records.value
    .filter((r) => r.provides.includes(cap) && r.provider !== 'remote' && want(r))
    .sort((a, b) => rank(a) - rank(b) || (a.sizeMB ?? Infinity) - (b.sizeMB ?? Infinity))[0]
}

function modelCap(id: string, name: string, rec: ModelRecord | undefined, without: string, extra: Partial<HbCap> = {}): HbCap {
  if (!rec) return { id, name, state: 'unavailable', reason: 'no model for this in the catalogue yet.', without, speed: 'none', ...extra }
  const st = states.value[rec.id] ?? { state: 'none' as const }
  const fit = fits.value[rec.id]
  const state: HbCap['state'] =
    st.state === 'loaded' ? 'on' : st.state === 'downloading' ? 'loading' : st.state === 'fault' ? 'failed' : fit && !fit.ok ? 'unavailable' : 'off'
  const gpu = rec.ladder[0]?.device === 'webgpu' && fit?.fit === 'fits'
  return {
    id,
    name: `${name}: ${rec.label ?? rec.id}`,
    state,
    needs: ['model', ...(rec.ladder.every((r) => r.device === 'webgpu') ? [{ kind: 'webgpu' as const, missing: !env.value?.webgpu }] : [])],
    size: rec.sizeMB === null ? 'size unknown' : mbText(rec.sizeMB),
    sizeSource: rec.sizeSource,
    licence: rec.licence,
    commercial: rec.commercial === 'unknown' ? null : rec.commercial,
    licenceWhat: 'weights',
    reason: st.state === 'fault' ? st.error : fit && !fit.ok ? fit.reason : undefined,
    action: storedIds.value.has(rec.id) ? 'load' : `download ${rec.sizeMB === null ? 'size unknown' : mbText(rec.sizeMB)} and load`,
    offAction: 'unload',
    loaded: st.state === 'downloading' ? st.loaded : undefined,
    total: st.state === 'downloading' ? st.total : undefined,
    speed: !fit ? undefined : !fit.ok ? 'none' : gpu ? 'fast' : fit.fit === 'fits' ? 'ok' : 'slow',
    current: st.state === 'loaded',
    stored: storedIds.value.has(rec.id),
    without,
    ...extra,
  }
}

export const caps = computed<HbCap[]>(() => {
  const e = env.value
  const media = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
  const perm = (id: 'mic' | 'camera', name: string, without: string, ask: string): HbCap => {
    const p = perms.value[id]
    return {
      id, name, state: media ? p.state : 'unavailable', needs: [id === 'mic' ? 'microphone' : 'camera'],
      reason: media ? p.reason : 'this page cannot ask for media here. open it over https or localhost.',
      ask, action: id === 'mic' ? 'allow the microphone' : 'allow the camera', offAction: '', without, speed: media ? 'fast' : 'none',
    }
  }
  const speech = typeof speechSynthesis !== 'undefined'
  return [
    modelCap('gpu-chat', 'chat on the gpu', pick('chat', (r) => r.ladder.every((x) => x.device === 'webgpu')), 'chat runs on cpu with the small models.', {
      needs: ['model', { kind: 'webgpu', missing: !e?.webgpu }],
    }),
    modelCap('cpu-chat', 'chat on cpu', pick('chat', (r) => r.ladder.some((x) => x.device === 'wasm') && r.provider !== 'prompt-api'), 'tools that need no model still work.'),
    perm('mic', 'microphone', 'type instead of talking.', 'the browser asks once. nothing records until you press a record button.'),
    perm('camera', 'camera', 'drop an image instead.', 'the browser asks once. frames stay in this tab.'),
    {
      id: 'voice-out', name: 'voice out: the system voice', state: speech ? 'on' : 'unavailable', needs: ['other'],
      reason: speech ? undefined : 'no speech synthesis in this browser.', offAction: '', without: 'replies stay as text.', speed: speech ? 'fast' : 'none',
    },
    modelCap('kokoro', 'voice out', pick('speak'), 'the system voice reads replies.'),
    modelCap('memory', 'memory index', pick('embed'), 'memory recalls by keyword, without meaning.'),
    modelCap('depth', 'depth', pick('depth'), 'relief works from a depth map you drop in.'),
    modelCap('masks', 'masks', pick('segment'), 'paint a mask by hand.'),
    modelCap('imagegen', 'image generation', pick('imagegen'), 'drop an image instead.'),
  ]
})

const capRecord = (capId: string): string | undefined => {
  const c = caps.value.find((x) => x.id === capId)
  const label = c?.name.split(': ').slice(1).join(': ')
  return records.value.find((r) => (r.label ?? r.id) === label)?.id
}

async function askMedia(kind: 'mic' | 'camera'): Promise<void> {
  perms.value = { ...perms.value, [kind]: { state: 'loading' } }
  try {
    const s = await navigator.mediaDevices.getUserMedia(kind === 'mic' ? { audio: true } : { video: true })
    for (const t of s.getTracks()) t.stop()
    perms.value = { ...perms.value, [kind]: { state: 'on' } }
    logEvent('note', `${kind === 'mic' ? 'microphone' : 'camera'} allowed.`)
  } catch (err) {
    const line = humanError(kind, err)
    perms.value = { ...perms.value, [kind]: { state: 'failed', reason: line } }
    logEvent('fail', line)
  }
}

/** A verb from a capability row. */
export function act(capId: string, verb: string): void {
  if (capId === 'mic' || capId === 'camera') {
    if (verb === 'enable' || verb === 'retry') void askMedia(capId)
    return
  }
  const id = capRecord(capId)
  if (!id) return
  if (verb === 'enable' || verb === 'retry') void load(id)
  else if (verb === 'cancel') cancel(id)
  else if (verb === 'disable' || verb === 'unload') void unload(id)
}

// Custom rows (design 2.2 section 3): an onnx repo, mlc weights, a gguf file
// or an endpoint, each checked with one request before anything downloads.
// The onnx check is here; the chat tool provides the other three with
// provideCustomCheck, with the runtimes that load them.
const CUSTOM_KEY = 'hb-suite.custom-models'
/** One saved custom row: its way in, the form values, the size the check found. */
export interface SavedCustom { mode: CustomMode; id: string; values: CustomValues; sizeMB: number | null }
type CustomRunner = (values: CustomValues) => Promise<CustomCheck>
const readSaved = (): SavedCustom[] => {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? '[]') as (SavedCustom | { repo: string; dtype: string; sizeMB: number | null })[]
    // rows saved before the mode field were all onnx repos
    return raw.map((s) => ('mode' in s ? s : { mode: 'onnx' as const, id: s.repo, values: { repo: s.repo, dtype: s.dtype }, sizeMB: s.sizeMB }))
  } catch { return [] }
}
const saved = shallowRef<SavedCustom[]>(readSaved())
const checks = shallowRef<Partial<Record<CustomMode, CustomRunner>>>({})
/** The ways in that have a check, onnx first. */
export const customModes = computed<CustomMode[]>(() => (['onnx', 'mlc', 'gguf', 'endpoint'] as const).filter((m) => m === 'onnx' || checks.value[m]))
export const customSaved = computed<HbCustomEntry[]>(() => saved.value.map((s) => ({ id: s.id, mode: s.mode, source: String(s.values.url ?? s.values.repo ?? s.id) })))
export const customCheck = shallowRef<CustomCheck | null>(null)
/** The saved row behind a record id, for the runtime that loads it. */
export const customOf = (id: string): SavedCustom | undefined => saved.value.find((s) => s.id === id)

/** A tool adds the check for a way in (mlc, gguf, endpoint) with the runtime that loads it. */
export function provideCustomCheck(mode: CustomMode, run: CustomRunner): void {
  checks.value = { ...checks.value, [mode]: run }
}

const str = (v: CustomValues, k: string) => String(v[k] ?? '').trim()

/** The catalogue record for a saved custom row. */
export function customRecord(s: SavedCustom): ModelRecord {
  const base = {
    id: s.id, group: 'custom', provides: ['chat'] as Capability[], sizeMB: s.sizeMB, sizeSource: (s.sizeMB === null ? 'unknown' : 'vendor') as ModelRecord['sizeSource'],
    censorship: 'unknown' as const, licence: 'unknown, not checked', commercial: 'unknown' as const,
  }
  const ctx = Number(str(s.values, 'ctx')) || undefined
  if (s.mode === 'mlc') {
    const dtype = s.values.f16 === false ? 'q4f32_1' : 'q4f16_1'
    return {
      ...base, label: s.id, note: 'added by you. mlc weights, checked by a repo listing.', provider: 'webllm',
      source: { modelId: s.id, url: str(s.values, 'url') }, ...(ctx ? { ctx } : {}),
      ladder: [{ device: 'webgpu', dtype, ...(s.values.f16 === false ? {} : { needs: ['f16'] }) }],
    } as ModelRecord
  }
  if (s.mode === 'gguf') {
    const file = str(s.values, 'file')
    return {
      ...base, label: file.replace(/\.gguf$/i, ''), note: 'added by you. a gguf file, checked by a repo listing.', provider: 'wllama',
      source: { repo: str(s.values, 'repo'), file }, ...(ctx ? { ctx } : {}),
      ladder: [{ device: 'webgpu', dtype: 'gguf' }, { device: 'wasm', dtype: 'gguf' }],
    } as ModelRecord
  }
  if (s.mode === 'endpoint') {
    return {
      ...base, label: s.id, note: 'your endpoint. replies leave this tab.', provider: 'remote', sizeMB: 0, sizeSource: 'inferred',
      source: { url: str(s.values, 'url'), modelId: s.id }, ladder: [{ device: 'remote' }],
    } as ModelRecord
  }
  const dtype = str(s.values, 'dtype') || 'q4'
  return {
    ...base, label: s.id.split('/').pop(), note: 'added by you. checked by a repo listing.', provider: 'tjs', source: { modelId: s.id },
    ladder: [{ device: 'webgpu', dtype }, { device: 'wasm', dtype }],
  } as ModelRecord
}
function addRecords(list: SavedCustom[]): void {
  const fresh = list.filter((s) => !registry.get(s.id))
  if (fresh.length) registry.add(...fresh.map(customRecord))
  const keep = new Set(saved.value.map((s) => s.id))
  records.value = registry.list().filter((r) => r.group !== 'custom' || keep.has(r.id))
}
addRecords(saved.value)

/** A tool adds its catalogue rows (the transcribe records) to the one registry. */
export function addRows(rows: ModelRecord[]): void {
  const fresh = rows.filter((r) => !registry.get(r.id))
  if (fresh.length) registry.add(...fresh)
  addRecords(saved.value)
}

async function checkOnnx(values: CustomValues): Promise<CustomCheck> {
  const repo = str(values, 'repo')
  const dtype = str(values, 'dtype') || 'q4'
  const res = await fetch(`https://huggingface.co/api/models/${repo}/tree/main/onnx`)
  if (!res.ok) throw new Error(res.status === 404 ? `no onnx folder in ${repo}, or the repo is private.` : `the hub answered ${res.status}.`)
  const files = (await res.json()) as { path: string; size?: number }[]
  const mine = files.filter((f) => f.path.includes(`_${dtype}.onnx`))
  if (!mine.length) throw new Error(`no ${dtype} file in ${repo}/onnx. pick another quant.`)
  return { state: 'ok', sizeMB: mine.reduce((a, f) => a + (f.size ?? 0), 0) / MB, lines: mine.map((f) => f.path) }
}

export async function checkCustom(mode: CustomMode, values: CustomValues): Promise<void> {
  const run = mode === 'onnx' ? checkOnnx : checks.value[mode]
  customCheck.value = { state: 'checking' }
  try {
    if (!run) throw new Error(`no check for ${mode} rows in this build.`)
    customCheck.value = await run(values)
  } catch (err) {
    customCheck.value = { state: 'fail', lines: [err instanceof Error ? err.message : String(err)] }
  }
}

export function addCustom(mode: CustomMode, values: CustomValues): string {
  const id = customId(mode, values)
  const v = { ...values }
  // a key never enters storage; the chat tool keeps it in memory
  delete v.key
  const s: SavedCustom = { mode, id, values: v, sizeMB: mode === 'endpoint' ? 0 : customCheck.value?.sizeMB ?? null }
  saved.value = [s, ...saved.value.filter((x) => x.id !== id)]
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(saved.value)) } catch { /* private window: kept for this visit */ }
  addRecords(saved.value)
  customCheck.value = null
  logEvent('note', `added ${id}. its licence is not checked.`)
  return id
}

export function removeCustom(id: string): void {
  saved.value = saved.value.filter((x) => x.id !== id)
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(saved.value)) } catch { /* nothing kept */ }
  addRecords(saved.value)
}

/** Status strip: the loaded models in a few words. */
export const modelLine = computed(() => {
  const r = resident.value
  if (!r.length) return 'none'
  return r.length === 1 ? r[0]!.label ?? r[0]!.id : `${r[0]!.label ?? r[0]!.id} and ${r.length - 1} more`
})

