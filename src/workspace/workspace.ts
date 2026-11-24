// Projects, documents, blobs and autosave over a Backend (design 2.5).
// Framework free; the Vue glue is state.ts.
import type { Backend } from './db.ts'
import type { Kinds } from './kinds.ts'

export const SCHEMA = 1
export const SCRATCH = 'scratch'

export interface Project {
  id: string
  name: string
  created: number
  updated: number
  schema: number
}

export interface Doc<B = unknown> {
  id: string
  project: string
  tool: string
  kind: string
  name: string
  version: number
  created: number
  updated: number
  body: B
}

/** A user file or derived result, keyed by its SHA-256. `local` files never
 * leave the machine unless the person ticks "include local only files". */
export interface BlobRecord {
  hash: string
  name: string
  type: string
  size: number
  local: boolean
  data: Uint8Array
}

/** How a document body points at a blob: `{ $blob: '<sha256 hex>' }`. */
export const blobRef = (hash: string) => ({ $blob: hash })

/** Every blob hash a body points at, found by walking it. */
export function blobsIn(body: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(body)) for (const x of body) blobsIn(x, out)
  else if (body && typeof body === 'object') {
    const h = (body as { $blob?: unknown }).$blob
    if (typeof h === 'string') out.add(h)
    else for (const x of Object.values(body)) blobsIn(x, out)
  }
  return out
}

export async function sha256(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export interface WorkspaceOptions {
  kinds: Kinds
  now?: () => number
  newId?: () => string
  /** Autosave delay after the last change, ms. Default 800. */
  delay?: number
}

export type Workspace = ReturnType<typeof createWorkspace>

export function createWorkspace(db: Backend, opts: WorkspaceOptions) {
  const now = opts.now ?? Date.now
  const newId = opts.newId ?? (() => crypto.randomUUID().slice(0, 13))
  const delay = opts.delay ?? 800
  const subs = new Set<(what: 'projects' | 'docs') => void>()
  const changed = (what: 'projects' | 'docs') => subs.forEach((f) => f(what))
  let current = SCRATCH

  const pending = new Map<string, Doc>()
  let timer: ReturnType<typeof setTimeout> | null = null

  async function touch(id: string) {
    const p = await db.get<Project>('projects', id)
    if (p) await db.put('projects', id, { ...p, updated: now() })
  }

  async function uniqueName(project: string, name: string, skip?: string): Promise<string> {
    const taken = new Set((await ws.docs(project)).filter((d) => d.id !== skip).map((d) => d.name))
    if (!taken.has(name)) return name
    let i = 2
    while (taken.has(`${name} ${i}`)) i++
    return `${name} ${i}`
  }

  const ws = {
    onChange(fn: (what: 'projects' | 'docs') => void): () => void {
      subs.add(fn)
      return () => subs.delete(fn)
    },

    /** Makes "scratch" on a first visit and reopens the last project. */
    async ready(): Promise<string> {
      if (!(await db.get('projects', SCRATCH))) {
        await db.put('projects', SCRATCH, { id: SCRATCH, name: 'scratch', created: now(), updated: now(), schema: SCHEMA } satisfies Project)
      }
      const last = await db.get<string>('kv', 'project')
      current = last && (await db.get('projects', last)) ? last : SCRATCH
      return current
    },
    current: () => current,

    async projects(): Promise<Project[]> {
      return (await db.all<Project>('projects')).sort((a, b) => b.updated - a.updated)
    },
    async openProject(id: string): Promise<void> {
      if (!(await db.get('projects', id))) throw new Error('that project is gone. it may have been deleted in another tab.')
      await ws.flush()
      current = id
      await db.put('kv', 'project', id)
      changed('projects')
    },
    async newProject(name = 'untitled'): Promise<Project> {
      const names = new Set((await ws.projects()).map((p) => p.name))
      let n = name
      for (let i = 2; names.has(n); i++) n = `${name} ${i}`
      const p: Project = { id: newId(), name: n, created: now(), updated: now(), schema: SCHEMA }
      await db.put('projects', p.id, p)
      await ws.openProject(p.id)
      return p
    },
    async renameProject(id: string, name: string): Promise<void> {
      const p = await db.get<Project>('projects', id)
      const n = name.trim()
      if (!p || !n) return
      await db.put('projects', id, { ...p, name: n, updated: now() })
      changed('projects')
    },
    async duplicateProject(id: string): Promise<Project> {
      const p = await db.get<Project>('projects', id)
      if (!p) throw new Error('that project is gone.')
      await ws.flush()
      const copy = await ws.newProject(`${p.name} copy`)
      for (const d of await ws.docs(id)) {
        const nid = newId()
        await db.put('docs', nid, { ...d, id: nid, project: copy.id })
      }
      changed('docs')
      return copy
    },
    /** Deletes a project and its documents. Blobs stay until a sweep finds them unused. */
    async deleteProject(id: string): Promise<void> {
      for (const d of await ws.docs(id)) {
        pending.delete(d.id)
        await db.del('docs', d.id)
      }
      await db.del('projects', id)
      if (current === id) {
        const rest = await ws.projects()
        if (!rest.length) await ws.ready()
        current = rest[0]?.id ?? SCRATCH
        await db.put('kv', 'project', current)
      }
      changed('projects')
      changed('docs')
    },

    /** Documents of a project, newest first; `tool` narrows to one tool. */
    async docs(project = current, tool?: string): Promise<Doc[]> {
      const all = await db.all<Doc>('docs')
      const mine = all.filter((d) => d.project === project && (!tool || d.tool === tool)).map((d) => pending.get(d.id) ?? d)
      return mine.sort((a, b) => b.updated - a.updated)
    },
    async getDoc<B = unknown>(id: string): Promise<Doc<B> | undefined> {
      return (pending.get(id) as Doc<B> | undefined) ?? db.get<Doc<B>>('docs', id)
    },
    /** A new document of a registered kind, saved at once. */
    async createDoc<B = unknown>(kind: string, init: { name?: string; body?: B; project?: string } = {}): Promise<Doc<B>> {
      const k = opts.kinds.get(kind)
      if (!k) throw new Error(`no tool in this build saves "${kind}" documents`)
      const project = init.project ?? current
      const d: Doc<B> = {
        id: newId(), project, tool: k.tool, kind, version: k.version, created: now(), updated: now(),
        name: await uniqueName(project, init.name?.trim() || `${k.label}`),
        body: init.body ?? (k.create() as B),
      }
      await db.put('docs', d.id, d)
      await touch(project)
      changed('docs')
      return d
    },
    /** Write a document that came from a file or another project as a new one. Nothing is replaced. */
    async addDoc(d: Omit<Doc, 'id' | 'project' | 'created' | 'updated'> & { project?: string }): Promise<Doc> {
      const project = d.project ?? current
      const doc: Doc = { ...d, id: newId(), project, created: now(), updated: now(), name: await uniqueName(project, d.name) }
      await db.put('docs', doc.id, doc)
      await touch(project)
      changed('docs')
      return doc
    },
    /** Queue a changed document; it saves `delay` ms after the last change, or on flush. */
    change(d: Doc): void {
      pending.set(d.id, { ...d, updated: now() })
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void ws.flush(), delay)
    },
    /** Waiting saves. */
    pendingCount: () => pending.size,
    /** Save every waiting document now. Resolves to how many were saved. */
    async flush(): Promise<number> {
      if (timer) clearTimeout(timer)
      timer = null
      const list = [...pending.values()]
      pending.clear()
      const projects = new Set<string>()
      for (const d of list) {
        if (!(await db.get('docs', d.id))) continue
        await db.put('docs', d.id, d)
        projects.add(d.project)
      }
      for (const p of projects) await touch(p)
      if (list.length) changed('docs')
      return list.length
    },
    async renameDoc(id: string, name: string): Promise<void> {
      const d = await ws.getDoc(id)
      const n = name.trim()
      if (!d || !n || n === d.name) return
      ws.change({ ...d, name: await uniqueName(d.project, n, d.id) })
      await ws.flush()
    },
    async duplicateDoc(id: string): Promise<Doc> {
      const d = await ws.getDoc(id)
      if (!d) throw new Error('that document is gone.')
      return ws.addDoc({ ...d, name: `${d.name} copy`, body: structuredClone(d.body) })
    },
    async deleteDoc(id: string): Promise<void> {
      pending.delete(id)
      const d = await db.get<Doc>('docs', id)
      await db.del('docs', id)
      if (d) await touch(d.project)
      changed('docs')
    },

    /** Store bytes by their SHA-256; the same bytes are kept once. */
    async putBlob(data: Uint8Array, meta: { name: string; type: string; local?: boolean }): Promise<string> {
      const hash = await sha256(data)
      const had = await db.get<BlobRecord>('blobs', hash)
      // A file once flagged local stays local, whoever stores it again.
      const local = !!meta.local || !!had?.local
      await db.put('blobs', hash, { hash, name: meta.name, type: meta.type, size: data.length, local, data } satisfies BlobRecord)
      return hash
    },
    getBlob: (hash: string) => db.get<BlobRecord>('blobs', hash),
  }

  return ws
}
