// Document files and the workspace zip (design 2.5). Loaded on the first
// export or import, so the zip code stays out of the first load.
import { unzipStore, zipStore } from '@hackbuild/audio-dsp'
import { FALLBACK_EXT, WORKSPACE_EXT, type Kinds } from './kinds.ts'
import { blobsIn, sha256, SCHEMA, type BlobRecord, type Doc, type Workspace } from './workspace.ts'

export const DOC_FORMAT = 'hackbuild-suite.doc'
export const WORKSPACE_FORMAT = 'hackbuild-suite.workspace'

/** One document as a file: the envelope and the body, with the blobs it
 * points at inlined as base64 so the file reopens with nothing else. */
export interface DocFile {
  format: typeof DOC_FORMAT
  schema: number
  kind: string
  tool: string
  version: number
  name: string
  exported: string
  body: unknown
  blobs?: Record<string, { name: string; type: string; local?: boolean; base64: string }>
}

export interface Manifest {
  format: typeof WORKSPACE_FORMAT
  schema: number
  exported: string
  project: string
  /** Kind ids with the body version each document was written at. */
  tools: Record<string, number>
  models: string[]
  files: { path: string; sha256: string; size: number }[]
  /** Local only blobs left out, by name. */
  left: string[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (u: Uint8Array) => {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'

export const docExt = (kinds: Kinds, kind: string) => kinds.get(kind)?.ext ?? FALLBACK_EXT

/** The file for one document. Local only blobs are left out unless `includeLocal`. */
export async function writeDoc(ws: Workspace, kinds: Kinds, d: Doc, o: { includeLocal?: boolean; at?: Date } = {}): Promise<{ name: string; text: string; left: string[] }> {
  const blobs: NonNullable<DocFile['blobs']> = {}
  const left: string[] = []
  for (const h of blobsIn(d.body)) {
    const b = await ws.getBlob(h)
    if (!b) continue
    if (b.local && !o.includeLocal) left.push(b.name)
    else blobs[h] = { name: b.name, type: b.type, ...(b.local ? { local: true } : {}), base64: b64(b.data) }
  }
  const file: DocFile = {
    format: DOC_FORMAT, schema: SCHEMA, kind: d.kind, tool: d.tool, version: d.version, name: d.name,
    exported: (o.at ?? new Date()).toISOString(), body: d.body, ...(Object.keys(blobs).length ? { blobs } : {}),
  }
  return { name: slug(d.name) + docExt(kinds, d.kind), text: JSON.stringify(file, null, 1), left }
}

/** Read a document file. Throws with words that name what is wrong. */
export function readDoc(kinds: Kinds, text: string): DocFile {
  let f: DocFile
  try {
    f = JSON.parse(text)
  } catch {
    throw new Error('this file is not json. it may be cut short.')
  }
  if (!f || f.format !== DOC_FORMAT) throw new Error('this json is not a suite document.')
  if (f.schema > SCHEMA) throw new Error(`this document is from a newer suite (schema ${f.schema}).`)
  if (typeof f.kind !== 'string' || typeof f.name !== 'string' || typeof f.version !== 'number') throw new Error('this document has no kind, name or version.')
  const body = kinds.upgrade(f.kind, f.body, f.version)
  const k = kinds.get(f.kind)
  return { ...f, body, version: k ? k.version : f.version, tool: k ? k.tool : String(f.tool ?? '') }
}

/** Store a read document file in a project as a new document. */
export async function addDocFile(ws: Workspace, f: DocFile, project?: string): Promise<Doc> {
  for (const [h, b] of Object.entries(f.blobs ?? {})) {
    const data = unb64(b.base64)
    if ((await sha256(data)) !== h) throw new Error(`the file ${b.name} inside does not match its hash.`)
    await ws.putBlob(data, { name: b.name, type: b.type, local: b.local })
  }
  return ws.addDoc({ kind: f.kind, tool: f.tool, version: f.version, name: f.name, body: f.body, ...(project ? { project } : {}) })
}

/** The whole project as one `.hbsuite.zip`: manifest.json, one json per
 * document under docs/, blobs under blobs/. Weights are never in it. */
export async function writeWorkspace(ws: Workspace, kinds: Kinds, o: { project?: string; includeLocal?: boolean; at?: Date } = {}): Promise<{ name: string; bytes: Uint8Array; manifest: Manifest }> {
  await ws.flush()
  const at = o.at ?? new Date()
  const id = o.project ?? ws.current()
  const project = (await ws.projects()).find((p) => p.id === id)
  const docs = await ws.docs(id)
  const entries: { name: string; data: Uint8Array }[] = []
  const tools: Record<string, number> = {}
  const models = new Set<string>()
  const left: string[] = []
  const hashes = new Set<string>()
  const used = new Set<string>()
  for (const d of docs) {
    let path = `docs/${slug(d.name)}${docExt(kinds, d.kind)}`
    for (let i = 2; used.has(path); i++) path = `docs/${slug(d.name)}-${i}${docExt(kinds, d.kind)}`
    used.add(path)
    const file: DocFile = { format: DOC_FORMAT, schema: SCHEMA, kind: d.kind, tool: d.tool, version: d.version, name: d.name, exported: at.toISOString(), body: d.body }
    entries.push({ name: path, data: enc.encode(JSON.stringify(file, null, 1)) })
    tools[d.kind] = d.version
    for (const m of kinds.get(d.kind)?.models?.(d.body as never) ?? []) models.add(m)
    blobsIn(d.body, hashes)
  }
  const blobMeta: Record<string, Omit<BlobRecord, 'data'>> = {}
  for (const h of hashes) {
    const b = await ws.getBlob(h)
    if (!b) continue
    if (b.local && !o.includeLocal) {
      left.push(b.name)
      continue
    }
    entries.push({ name: `blobs/${h}`, data: b.data })
    blobMeta[h] = { hash: h, name: b.name, type: b.type, size: b.size, local: b.local }
  }
  if (Object.keys(blobMeta).length) entries.push({ name: 'blobs.json', data: enc.encode(JSON.stringify(blobMeta, null, 1)) })
  const files = []
  for (const e of entries) files.push({ path: e.name, sha256: await sha256(e.data), size: e.data.length })
  const manifest: Manifest = {
    format: WORKSPACE_FORMAT, schema: SCHEMA, exported: at.toISOString(), project: project?.name ?? id,
    tools, models: [...models].sort(), files, left,
  }
  const bytes = zipStore([{ name: 'manifest.json', data: JSON.stringify(manifest, null, 1) }, ...entries], at)
  return { name: slug(project?.name ?? id) + WORKSPACE_EXT, bytes, manifest }
}

export interface ReadWorkspace {
  manifest: Manifest
  docs: DocFile[]
  blobs: { hash: string; name: string; type: string; local: boolean; data: Uint8Array }[]
}

/** Read and check a workspace zip. Throws with words that name what is wrong. */
export async function readWorkspace(kinds: Kinds, bytes: Uint8Array): Promise<ReadWorkspace> {
  const entries = new Map(unzipStore(bytes).map((e) => [e.name, e.data]))
  const m = entries.get('manifest.json')
  if (!m) throw new Error('this zip has no manifest.json. it is not a suite workspace.')
  const manifest = JSON.parse(dec.decode(m)) as Manifest
  if (manifest.format !== WORKSPACE_FORMAT) throw new Error('this zip is not a suite workspace.')
  if (manifest.schema > SCHEMA) throw new Error(`this workspace is from a newer suite (schema ${manifest.schema}).`)
  for (const f of manifest.files) {
    const data = entries.get(f.path)
    if (!data) throw new Error(`the workspace lists ${f.path} and it is missing.`)
    if ((await sha256(data)) !== f.sha256) throw new Error(`${f.path} does not match its sha-256 in the manifest.`)
  }
  const docs = manifest.files.filter((f) => f.path.startsWith('docs/')).map((f) => {
    try {
      return readDoc(kinds, dec.decode(entries.get(f.path)!))
    } catch (e) {
      throw new Error(`${f.path}: ${(e as Error).message}`)
    }
  })
  const meta = entries.has('blobs.json') ? (JSON.parse(dec.decode(entries.get('blobs.json')!)) as Record<string, Omit<BlobRecord, 'data'>>) : {}
  const blobs = Object.values(meta).map((b) => ({ hash: b.hash, name: b.name, type: b.type, local: b.local, data: entries.get(`blobs/${b.hash}`)! })).filter((b) => b.data)
  return { manifest, docs, blobs }
}

/** Add a read workspace to a project. Every document is new; nothing is replaced. */
export async function addWorkspace(ws: Workspace, w: ReadWorkspace, project?: string): Promise<Doc[]> {
  for (const b of w.blobs) await ws.putBlob(b.data, { name: b.name, type: b.type, local: b.local })
  const out: Doc[] = []
  for (const f of w.docs) out.push(await addDocFile(ws, { ...f, blobs: {} }, project))
  return out
}
