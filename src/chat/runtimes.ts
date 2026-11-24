// The chat runtimes on the one hub (design 2.2, 3.1): webllm and wllama in
// this tab, the browser's built in model, and your endpoint, each added with
// provideRuntime; the checks for custom mlc, gguf and endpoint rows; the
// webllm cache adapter, so the manager lists what webllm keeps. Nothing
// here fetches at import: a runtime module and its weights load from the
// load button that names the size.
import { shallowRef } from 'vue'
import { importEsm } from '@hackbuild/ai-env'
import { maskKey, type ChatEngine } from '@hackbuild/chat'
import { loadWebLLM, webllmCache, webllmPhase, WEBLLM_VERSION, type WebLLMModelEntry, type WebLLMModule } from '@hackbuild/chat/webllm'
import { loadWllama, wllamaUrls, type WllamaModule } from '@hackbuild/chat/wllama'
import { openaiCompatible } from '@hackbuild/chat/remote'
import { getLanguageModel, promptApi } from '@hackbuild/chat/prompt-api'
import { hfResolve } from '@hackbuild/weights'
import type { FactoryContext, ModelRecord } from '@hackbuild/models'
import type { CustomCheck, CustomValues } from '@virgilvox/hackbuild-ui/vanilla'
import { allRecords, customOf, keepWebllm, provideCustomCheck, provideRuntime, STUB, weights } from '../models/hub.ts'
import { stubChat } from './stub.ts'

const MB = 1024 * 1024
const HF = 'https://huggingface.co'

/** The endpoint key: typed into the page, kept in memory for this visit, never stored. */
export const endpointKey = shallowRef('')
export const keyShown = () => (endpointKey.value ? maskKey(endpointKey.value) : '')

/** The engine in a loaded value: a runtime's chat engine, or the scripted one for a stub load. */
export function engineOf(value: unknown, r: ModelRecord): ChatEngine {
  const v = value as Partial<ChatEngine> | null
  if (v && typeof v.stream === 'function') return v as ChatEngine
  return stubChat({ id: `stub ${r.label ?? r.id}` })
}

const webllmUrls = [`https://esm.run/@mlc-ai/web-llm@${WEBLLM_VERSION}`, `https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@${WEBLLM_VERSION}/+esm`]
let webllmMod: Promise<WebLLMModule> | null = null
const webllmModule = () => (webllmMod ??= importEsm<WebLLMModule>(webllmUrls).catch((e) => { webllmMod = null; throw e }))

/** The model_list the cache adapter reads: webllm's own list once loaded, else the catalogue's webllm rows. */
function modelList(prebuilt: unknown[] = []): WebLLMModelEntry[] {
  const out: WebLLMModelEntry[] = []
  for (const r of allRecords.value) {
    if (r.provider !== 'webllm') continue
    const id = r.source.modelId ?? r.id
    const known = (prebuilt as WebLLMModelEntry[]).find((m) => m.model_id === id)
    out.push(known ?? { model: r.source.url || `${HF}/mlc-ai/${id}`, model_id: id })
  }
  return [...out, ...(prebuilt as WebLLMModelEntry[]).filter((m) => !out.some((o) => o.model_id === m.model_id))]
}

/** A custom mlc row as a webllm model_list entry, with the wasm of its base or its own url. */
function customEntry(r: ModelRecord, prebuilt: unknown[]): WebLLMModelEntry | null {
  const c = customOf(r.id)
  if (!c || c.mode !== 'mlc') return null
  const base = (prebuilt as WebLLMModelEntry[]).find((m) => m.model_id === String(c.values.base ?? ''))
  const lib = c.values.lib === 'url' ? String(c.values.wasm ?? '') : base?.model_lib
  if (!lib) throw new Error(`no .wasm for ${r.id}: pick a base model, or give the .wasm url.`)
  return { model: String(c.values.url ?? ''), model_id: r.id, model_lib: lib }
}

async function webllmFactory(ctx: FactoryContext): Promise<ChatEngine> {
  const mod = await webllmModule()
  const prebuilt = mod.prebuiltAppConfig?.model_list ?? []
  const custom = customEntry(ctx.record, prebuilt)
  const id = ctx.record.source.modelId ?? ctx.record.id
  const engine = await loadWebLLM({
    module: mod,
    modelId: id,
    contextWindow: ctx.record.ctx ?? 4096,
    customModels: custom ? [custom] : [],
    nativeTools: /hermes/i.test(id),
    onProgress: (p) => {
      const ph = webllmPhase(p)
      if (ph.phase !== 'ready') ctx.report(ph.phase, ph.fraction, ph.file)
    },
  })
  void keepWebllm(webllmCache({ modelList: modelList(custom ? [custom, ...prebuilt] : prebuilt) }))
  return engine
}

async function wllamaFactory(ctx: FactoryContext): Promise<ChatEngine> {
  const { repo, file } = ctx.record.source
  if (!repo || !file) throw new Error(`${ctx.record.id} names no gguf repo and file.`)
  const url = hfResolve(repo, ctx.record.source.revision ?? 'main') + file
  const blob = await weights().get(
    { url, key: `gguf:${repo}/${file}`, licence: ctx.record.licence, ...(ctx.record.source.sha256 ? { sha256: ctx.record.source.sha256 } : {}) },
    { signal: ctx.signal, onProgress: (p) => ctx.report('fetch', p.fraction) },
  )
  ctx.report('compile', null)
  const urls = wllamaUrls()
  const module = await importEsm<WllamaModule>(urls.esm)
  return loadWllama({ module, wasmUrl: urls.wasm, blobs: [blob], id: ctx.record.id, ...(ctx.record.ctx ? { nCtx: ctx.record.ctx } : {}) })
}

async function remoteFactory(ctx: FactoryContext): Promise<ChatEngine> {
  const base = ctx.record.source.url
  if (!base) throw new Error(`${ctx.record.id} names no endpoint url.`)
  return openaiCompatible({ base, model: ctx.record.source.modelId ?? ctx.record.id, ...(endpointKey.value ? { apiKey: endpointKey.value } : {}), licence: ctx.record.licence })
}

async function promptFactory(): Promise<ChatEngine> {
  if (!getLanguageModel()) throw new Error('this browser has no built in model. use chrome with the prompt api on.')
  return promptApi()
}

// The checks: one listing request each, nothing downloaded.
const repoOf = (url: string) => {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).slice(0, 2).join('/')
  } catch {
    return ''
  }
}
async function tree(repo: string): Promise<{ path: string; size?: number; type?: string }[]> {
  const res = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=true`)
  if (!res.ok) throw new Error(res.status === 404 ? `no repo ${repo} on the hub, or it is private.` : `the hub answered ${res.status}.`)
  return (await res.json()) as { path: string; size?: number }[]
}

export async function checkMlc(v: CustomValues): Promise<CustomCheck> {
  const repo = repoOf(String(v.url ?? ''))
  if (!repo.includes('/')) throw new Error('the weights url names no hub repo.')
  const files = await tree(repo)
  if (!files.some((f) => f.path === 'mlc-chat-config.json')) throw new Error(`no mlc-chat-config.json in ${repo}. it is not mlc weights.`)
  const shards = files.filter((f) => /^params_shard_\d+\.bin$/.test(f.path))
  if (!shards.length) throw new Error(`no params_shard files in ${repo}.`)
  const bytes = shards.reduce((a, f) => a + (f.size ?? 0), 0)
  return {
    state: 'ok',
    sizeMB: bytes / MB,
    lines: [`${shards.length} weight shards, mlc-chat-config.json found`, v.lib === 'url' ? 'the .wasm url is not fetched until load.' : `wasm from the base model ${String(v.base ?? 'not picked')}.`],
  }
}

export async function checkGguf(v: CustomValues): Promise<CustomCheck> {
  const repo = String(v.repo ?? '').trim()
  const file = String(v.file ?? '').trim()
  const files = await tree(repo)
  const f = files.find((x) => x.path === file)
  if (!f) {
    const ggufs = files.filter((x) => x.path.endsWith('.gguf')).map((x) => x.path)
    throw new Error(ggufs.length ? `no ${file} in ${repo}. it has: ${ggufs.slice(0, 4).join(', ')}${ggufs.length > 4 ? ', and more' : ''}.` : `no .gguf file in ${repo}.`)
  }
  const split = /-0*1-of-0*(\d+)\.gguf$/i.exec(file)
  if (split) throw new Error(`${file} is part 1 of ${split[1]}. this build loads a single gguf file; pick an unsplit quant.`)
  return { state: 'ok', sizeMB: (f.size ?? 0) / MB, lines: [file] }
}

export async function checkEndpoint(v: CustomValues, f: typeof fetch = fetch): Promise<CustomCheck> {
  const base = String(v.url ?? '').trim().replace(/\/+$/, '')
  const model = String(v.model ?? '').trim()
  let res: Response
  try {
    res = await f(`${base}/models`, { headers: endpointKey.value ? { authorization: `Bearer ${endpointKey.value}` } : {} })
  } catch {
    throw new Error('no answer from your endpoint. check the url, and that it allows this page.')
  }
  if (res.status === 401 || res.status === 403) throw new Error(`your endpoint refused the key (${res.status}). type the key above the chat, then check again.`)
  if (!res.ok) throw new Error(`your endpoint answered ${res.status} for ${base}/models.`)
  const body = (await res.json().catch(() => ({}))) as { data?: { id: string }[]; models?: { name: string }[] }
  const ids = (body.data?.map((m) => m.id) ?? body.models?.map((m) => m.name) ?? []).filter(Boolean)
  const has = ids.includes(model)
  return {
    state: 'ok',
    sizeMB: 0,
    lines: [ids.length ? `${ids.length} models listed${has ? `, ${model} among them` : `; ${model} is not among them`}.` : 'the endpoint lists no models. it may still answer.'],
  }
}

let added = false
/** Add the chat runtimes, the custom row checks and the webllm cache adapter. Safe to call more than once. */
export function addChatRuntimes(): void {
  if (added) return
  added = true
  provideCustomCheck('mlc', checkMlc)
  provideCustomCheck('gguf', checkGguf)
  provideCustomCheck('endpoint', (v) => checkEndpoint(v))
  // under ?stub the hub's stub providers stay: they load nothing
  if (!STUB) {
    provideRuntime('remote', remoteFactory)
    provideRuntime('webllm', webllmFactory)
    provideRuntime('wllama', wllamaFactory)
    provideRuntime('prompt-api', promptFactory)
  }
  void keepWebllm(webllmCache({ modelList: modelList() }))
}
