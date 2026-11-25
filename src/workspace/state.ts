// The workspace in the page: one Workspace on IndexedDB, reactive lists for
// the menu and the documents drawer, save, export, import, the drop routes
// and the document composable tools use (design 2.5, 2.6).
import { computed, getCurrentInstance, onBeforeUnmount, ref, shallowRef, type Ref, type ShallowRef } from 'vue'
import { useToast } from '@virgilvox/hackbuild-ui'
import { confirmDialog, saveFile, undoStack, type DropRoute, type UndoStack } from '@virgilvox/hackbuild-ui/vanilla'
import { idbBackend, memoryBackend, type Backend } from './db.ts'
import { kinds, WORKSPACE_EXT, type DocKind, type NativeImport } from './kinds.ts'
import { createWorkspace, type Doc, type Project } from './workspace.ts'
import { jobs, logEvent } from '../shell/shell'

export { registerKind, kinds } from './kinds.ts'
export type { DocKind } from './kinds.ts'

const files = () => import('./files.ts')
const sealing = () => import('./seal.ts')

// Short answers go to the toaster; failures stay longer.
const { toast: say } = useToast()
function toast(message: string, o: { kind: 'ok' | 'warn' | 'err' }): void {
  say(message, { kind: o.kind, duration: o.kind === 'ok' ? 2500 : 6000 })
}

let backend: Backend = idbBackend
export const ws = createWorkspace({
  get: (s, k) => backend.get(s, k),
  put: (s, k, v) => backend.put(s, k, v),
  del: (s, k) => backend.del(s, k),
  all: (s) => backend.all(s),
}, { kinds })

export const projects = shallowRef<Project[]>([])
export const projectId = ref(ws.current())
export const docs = shallowRef<Doc[]>([])
export const project = computed(() => projects.value.find((p) => p.id === projectId.value))
/** Bumps when a kind registers, so lists that read kinds update. */
export const kindsTick = ref(0)
kinds.onChange(() => kindsTick.value++)

/** Why the workspace actions wait now: a save, import or export in hand,
 * or a job that import and new must not cut into (design 2.5). */
const working = ref('')
const jobLine = ref('')
jobs.subscribe((t) => (jobLine.value = t.find((x) => !x.key.startsWith('ws-'))?.label ?? ''))
export const busy = computed(() => working.value || (jobLine.value ? `${jobLine.value} runs. stop it or wait, then import.` : ''))

async function refresh(): Promise<void> {
  projectId.value = ws.current()
  projects.value = await ws.projects()
  docs.value = await ws.docs()
}
ws.onChange(() => void refresh())

let started: Promise<void> | null = null
/** Open the database, make scratch on a first visit, and keep the lists. */
export function startWorkspace(): Promise<void> {
  started ??= ws
    .ready()
    .catch((e) => {
      backend = memoryBackend()
      logEvent('fail', `workspace: storage is blocked (${(e as Error).message}). documents live in this tab only.`)
      return ws.ready()
    })
    .then(refresh)
  // Save waiting changes when the tab hides or closes.
  addEventListener('pagehide', () => void ws.flush())
  document.addEventListener('visibilitychange', () => { if (document.hidden) void ws.flush() })
  return started
}

async function task<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (working.value) {
    toast(`${working.value} wait for it, then try again.`, { kind: 'warn' })
    return undefined
  }
  working.value = `${label}.`
  jobs.set('ws-task', label)
  try {
    const out = await fn()
    jobs.end('ws-task')
    return out
  } catch (e) {
    const msg = (e as Error).message
    jobs.fail('ws-task', msg)
    logEvent('fail', `workspace: ${msg}`)
    toast(msg, { kind: 'err' })
    return undefined
  } finally {
    working.value = ''
  }
}

/** ctrl+s: write every waiting change now. */
export async function saveNow(): Promise<void> {
  // A flush is safe beside any other task, so ctrl+s never waits its turn.
  let n: number
  try {
    n = await ws.flush()
  } catch (e) {
    const msg = `save failed: ${(e as Error).message}`
    logEvent('fail', `workspace: ${msg}`)
    return void toast(msg, { kind: 'err' })
  }
  const words = n ? `saved ${n} document${n === 1 ? '' : 's'}.` : 'nothing waiting. every change is saved.'
  logEvent('note', `workspace: ${words}`)
  toast(words, { kind: 'ok' })
}

// Projects, from the workspace menu.
export const openProject = (id: string) => task('opening the project', () => ws.openProject(id))
export const newProject = () => {
  if (busy.value) return void toast(busy.value, { kind: 'warn' })
  return task('making a project', () => ws.newProject())
}
export const renameProject = (name: string) => task('renaming', () => ws.renameProject(projectId.value, name))
export const duplicateProject = () => task('duplicating the project', () => ws.duplicateProject(projectId.value))

/** The promise dialog for large destructive actions and the import confirm, rendered once in the shell. */
export const dialog = confirmDialog()

export async function deleteProject(): Promise<void> {
  const p = project.value
  if (!p) return
  const n = docs.value.length
  const ok = await dialog.ask({
    title: `delete ${p.name}`,
    message: `this deletes the project and its ${n} document${n === 1 ? '' : 's'}. export it first to keep a copy. it cannot be undone.`,
    confirmLabel: 'delete', cancelLabel: 'keep', danger: true,
  })
  if (ok) await task('deleting the project', () => ws.deleteProject(p.id))
}

// Documents, from the documents drawer.
export const renameDoc = (id: string, name: string) => task('renaming', () => ws.renameDoc(id, name))
export const duplicateDoc = (id: string) => task('duplicating', () => ws.duplicateDoc(id))
export const deleteDoc = (id: string) => task('deleting', () => ws.deleteDoc(id))

export const kindOf = (d: Doc): DocKind | undefined => (kindsTick.value, kinds.get(d.kind))

/** Download one document in its own extension, or in a native format of its kind. */
export async function exportDoc(id: string, opts: { format?: string; filename?: string; includeLocal?: boolean; seal?: string } = {}): Promise<void> {
  await task('exporting', async () => {
    const f = await files()
    await ws.flush()
    const d = await ws.getDoc(id)
    if (!d) throw new Error('that document is gone.')
    const native = kinds.get(d.kind)?.exports?.find((x) => x.key === opts.format)
    if (native) {
      const data = native.write(d.body as never, d.name)
      const name = (opts.filename ?? d.name) + native.ext
      saveFile(name, data as BlobPart, native.type ?? 'text/plain')
      logEvent('note', `export: ${name}`)
      return
    }
    const out = await f.writeDoc(ws, kinds, d, { includeLocal: opts.includeLocal })
    const name = opts.filename ? opts.filename + f.docExt(kinds, d.kind) : out.name
    if (opts.seal) saveFile(name, (await (await sealing()).sealFile(opts.seal, 'document', new TextEncoder().encode(out.text))) as BlobPart, 'application/json')
    else saveFile(name, out.text, 'application/json')
    logEvent('note', `export: ${name}${opts.seal ? ', sealed' : ''}${out.left.length ? `. left out, local only: ${out.left.join(', ')}` : ''}`)
  })
}

/** Download the open project as one .hbsuite.zip. */
export async function exportWorkspace(opts: { filename?: string; includeLocal?: boolean; seal?: string } = {}): Promise<void> {
  await task('exporting the workspace', async () => {
    const f = await files()
    const out = await f.writeWorkspace(ws, kinds, { includeLocal: opts.includeLocal })
    const name = opts.filename ? opts.filename + WORKSPACE_EXT : out.name
    const bytes = opts.seal ? await (await sealing()).sealFile(opts.seal, 'workspace', out.bytes) : out.bytes
    saveFile(name, bytes as BlobPart, 'application/zip')
    const n = out.manifest.files.filter((x) => x.path.startsWith('docs/')).length
    logEvent('note', `export: ${name}, ${n} documents, ${bytes.length} bytes (measured)${opts.seal ? ', sealed' : ''}${out.manifest.left.length ? `. left out, local only: ${out.manifest.left.join(', ')}` : ''}`)
  })
}

/** Local only blob names in the open project, for the export panel's box. */
export async function localNames(): Promise<string[]> {
  const { blobsIn } = await import('./workspace.ts')
  const hashes = new Set<string>()
  for (const d of await ws.docs()) blobsIn(d.body, hashes)
  const names: string[] = []
  for (const h of hashes) {
    const b = await ws.getBlob(h)
    if (b?.local) names.push(b.name)
  }
  return names
}

/** A file two tools take: the shell shows the choice and answers here. */
export interface Choice {
  file: string
  options: { key: string; label: string }[]
  answer: (key: string | null) => void
}
export const choice = shallowRef<Choice | null>(null)
function choose(file: string, takers: { kind: DocKind; via: NativeImport<unknown> }[]): Promise<string | null> {
  return new Promise((resolve) => {
    choice.value = {
      file,
      options: takers.map((t) => ({ key: t.kind.kind, label: t.via.label })),
      answer: (k) => {
        choice.value = null
        resolve(k)
      },
    }
  })
}

/** A sealed file waits for its password: the shell shows the box and answers here. */
export interface PasswordAsk {
  file: string
  error: string
  answer: (password: string | null) => void
}
export const passwordAsk = shallowRef<PasswordAsk | null>(null)
function askPassword(file: string, error = ''): Promise<string | null> {
  return new Promise((resolve) => {
    passwordAsk.value = {
      file, error,
      answer: (p) => {
        passwordAsk.value = null
        resolve(p)
      },
    }
  })
}

/** The plain bytes of a picked file: a sealed one asks for its password
 * until it opens or the person cancels (null). */
async function unseal(file: File): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const s = await sealing()
  let sealed
  try {
    sealed = await s.readSealed(bytes)
  } catch (e) {
    toast(`${file.name}: ${(e as Error).message}`, { kind: 'err' })
    return null
  }
  if (!sealed) return bytes
  let error = ''
  for (;;) {
    const pw = await askPassword(file.name, error)
    if (pw === null) return null
    try {
      const plain = await s.openSealed(pw, sealed)
      logEvent('note', `import: ${file.name} opened with its password`)
      return plain
    } catch (e) {
      error = (e as Error).message
      logEvent('fail', `import: ${file.name}: ${error}`)
    }
  }
}

/** The shell's file input, set by the panels; ctrl+o and the menu's import press it. */
export const picker = shallowRef<(() => void) | null>(null)
export const pickFiles = () => picker.value?.()
/** The project rename box is open. */
export const renaming = ref(false)
/** The document picked in the documents drawer, for its actions and the export panel. */
export const selected = ref<string | null>(null)

/** Where opened documents go: the shell routes to the tool that owns them. */
export const opened = shallowRef<Doc | null>(null)

/** Route picked or dropped files: a workspace zip, a document file, or a
 * file a tool reads natively. Asks only when two tools take a file. */
export async function importFiles(list: File[]): Promise<void> {
  if (busy.value) return void toast(busy.value, { kind: 'warn' })
  let last: Doc | null = null
  for (const file of list) {
    const lower = file.name.toLowerCase()
    if (lower.endsWith(WORKSPACE_EXT)) {
      const plain = await unseal(file)
      if (!plain) continue
      const read = await task('reading the workspace', async () => (await files()).readWorkspace(kinds, plain))
      if (!read) continue
      const n = read.docs.length
      const ok = await dialog.ask({
        title: `import ${n} document${n === 1 ? '' : 's'} into this project. nothing is replaced.`,
        message: `from ${file.name}, exported ${read.manifest.exported.slice(0, 10)}.`,
        confirmLabel: 'import', cancelLabel: 'cancel',
      })
      if (!ok) continue
      const added = await task('importing', async () => (await files()).addWorkspace(ws, read))
      if (added) logEvent('note', `import: ${added.length} documents from ${file.name}`)
    } else if (kinds.isDocFile(lower)) {
      const plain = await unseal(file)
      if (!plain) continue
      const d = await task('importing', async () => {
        const f = await files()
        return f.addDocFile(ws, f.readDoc(kinds, new TextDecoder().decode(plain)))
      })
      if (d) {
        if (kinds.get(d.kind)) last = d
        logEvent('note', `import: ${d.name} from ${file.name}${kinds.get(d.kind) ? '' : '. no tool in this build opens it yet; it is kept in the project.'}`)
      }
    } else {
      const takers = kinds.takers(file)
      if (!takers.length) {
        toast(`no tool reads ${file.name}. drop a .hbsuite.zip, a document file, or a file a tool lists.`, { kind: 'warn' })
        continue
      }
      const key = takers.length === 1 ? takers[0]!.kind.kind : await choose(file.name, takers)
      const t = takers.find((x) => x.kind.kind === key)
      if (!t) continue
      const d = await task(`reading ${file.name}`, async () => {
        const r = await t.via.read(file)
        return ws.createDoc(t.kind.kind, r)
      })
      if (d) {
        last = d
        logEvent('note', `import: ${file.name} as a ${t.kind.label}`)
      }
    }
  }
  if (last) opened.value = last
}

/** The window drop routes; HbDropzone draws the ring that names them. */
/** A tool's claim on dropped files while it shows its own slots, as the
 * twin gate does; tried before the import routes. */
export interface DropClaim {
  accept(file: { name: string; type: string }): boolean
  take(files: File[]): void
}
let claim: DropClaim | null = null
export const claimDrops = (c: DropClaim | null): void => { claim = c }

export const dropRoutes: DropRoute[] = [
  { name: 'claimed', accept: (f) => !!claim?.accept(f), on: (f) => claim?.take(f) },
  { name: 'workspace', accept: WORKSPACE_EXT, on: (f) => void importFiles(f) },
  { name: 'document', accept: (f) => kinds.isDocFile(f.name), on: (f) => void importFiles(f) },
  { name: 'tool', accept: (f) => kinds.takers(f).length > 0, on: (f) => void importFiles(f) },
]

/** The undo target ctrl+z and ctrl+shift+z drive: the open document of the active tool. */
export interface UndoTarget {
  undo(): boolean
  redo(): boolean
}
const undoTarget = shallowRef<UndoTarget | null>(null)
export const undo = () => undoTarget.value?.undo() ?? false
export const redo = () => undoTarget.value?.redo() ?? false

export interface UseDocument<B> {
  doc: ShallowRef<Doc<B> | null>
  body: Ref<B | null>
  /** Change the body through `fn`; records an undo step and autosaves. */
  edit(fn: (body: B) => B | void): void
  /** Open a saved document of this kind, or the newest one, or a new one. */
  open(id?: string): Promise<Doc<B>>
  /** A new document of this kind, opened. */
  create(name?: string): Promise<Doc<B>>
  undo(): boolean
  redo(): boolean
  canUndo: Ref<boolean>
  canRedo: Ref<boolean>
}

/**
 * The document of one kind a tool edits. Changes go through `edit`, which
 * keeps the undo stack and autosaves; ctrl+z and ctrl+shift+z reach it while
 * the tool is mounted. Call in a tool view's setup.
 */
export function useDocument<B>(kind: string, opts: { limit?: number } = {}): UseDocument<B> {
  const doc = shallowRef<Doc<B> | null>(null)
  const body = ref(null) as Ref<B | null>
  const stack: UndoStack<B> = undoStack<B>(opts.limit ?? 100)
  const canUndo = ref(false)
  const canRedo = ref(false)
  const flags = () => {
    canUndo.value = stack.canUndo
    canRedo.value = stack.canRedo
  }
  const apply = (b: B) => {
    if (!doc.value) return
    const d = { ...doc.value, body: b }
    doc.value = d
    body.value = b
    ws.change(d)
    flags()
  }
  const show = (d: Doc<B>) => {
    doc.value = d
    body.value = d.body
    stack.clear()
    flags()
    return d
  }
  const api: UseDocument<B> = {
    doc, body, canUndo, canRedo,
    edit(fn) {
      if (!doc.value) return
      const before = doc.value.body
      const draft = structuredClone(before)
      const next = (fn(draft) ?? draft) as B
      stack.push(before)
      apply(next)
    },
    async open(id) {
      await startWorkspace()
      const found = id ? await ws.getDoc<B>(id) : ((await ws.docs()).find((d) => d.kind === kind) as Doc<B> | undefined)
      return show(found ?? (await ws.createDoc<B>(kind)))
    },
    async create(name) {
      await startWorkspace()
      return show(await ws.createDoc<B>(kind, name ? { name } : {}))
    },
    undo() {
      const b = doc.value && stack.undo(doc.value.body)
      if (b === undefined || b === null) return false
      apply(b)
      return true
    },
    redo() {
      const b = doc.value && stack.redo(doc.value.body)
      if (b === undefined || b === null) return false
      apply(b)
      return true
    },
  }
  if (getCurrentInstance()) {
    const target: UndoTarget = { undo: api.undo, redo: api.redo }
    undoTarget.value = target
    onBeforeUnmount(() => {
      if (undoTarget.value === target) undoTarget.value = null
      void ws.flush()
    })
  }
  return api
}
