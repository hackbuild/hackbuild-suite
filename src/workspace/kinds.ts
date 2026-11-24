// Document kinds. A tool registers each kind of document it saves, so the
// workspace can autosave it, list it, export it as a file in the tool's own
// extension, read it back, and route a dropped file to the tool that takes
// it (design 2.5). Framework free.
import { accepts } from '@virgilvox/hackbuild-ui/vanilla'

/** A file format a kind reads besides its own document file: srt for a
 * transcript, a bone map json for retarget. */
export interface NativeImport<B> {
  /** An input accept string: '.srt,.vtt', 'audio/*'. */
  accept: string
  /** Words for the chooser when two tools take the file: 'open as a transcript'. */
  label: string
  /** Turn the file into a new document body. Throw with words that name the failure. */
  read(file: File): Promise<{ name: string; body: B }>
}

/** A file format a kind writes besides its own document file. */
export interface NativeExport<B> {
  key: string
  /** The chip: 'srt'. */
  label: string
  /** '.srt'. */
  ext: string
  note?: string
  /** Text that can go to the clipboard. */
  copy?: boolean
  /** Mime type of the file. Default text/plain for strings. */
  type?: string
  write(body: B, name: string): string | Uint8Array
}

export interface DocKind<B = unknown> {
  /** 'chat.session': the owning tool id, a dot, a lowercase noun. */
  kind: string
  /** The tool id that opens it. */
  tool: string
  /** One word for lists and the chooser: 'chat', 'transcript'. */
  label: string
  /** The document file extension: '.hbchat.json'. */
  ext: string
  /** Body schema version; bump it and add `migrate` when the body changes. */
  version: number
  /** A new empty body. */
  create(): B
  /** Bring a body saved at an older version up to `version`. */
  migrate?(body: unknown, from: number): B
  /** Words naming what is wrong with a body read from a file, or null. */
  check?(body: unknown): string | null
  /** Model ids the document used, for the workspace manifest. */
  models?(body: B): string[]
  imports?: NativeImport<B>[]
  exports?: NativeExport<B>[]
}

/** The extension of a document file whose kind no registered tool owns. */
export const FALLBACK_EXT = '.hbdoc.json'
export const WORKSPACE_EXT = '.hbsuite.zip'
const KIND_ID = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/
const EXT = /^\.hb[a-z0-9]+\.json$/

export interface Kinds {
  /** Add a kind. Returns the function that removes it. Throws on a bad or taken id or extension. */
  register<B>(def: DocKind<B>): () => void
  get(kind: string): DocKind | undefined
  all(): DocKind[]
  /** True when the name reads as a suite document file (any `.hb*.json`). */
  isDocFile(name: string): boolean
  /** The kind whose extension the name ends in. */
  byExt(name: string): DocKind | undefined
  /** Kinds with a native import that takes this file. */
  takers(file: { name: string; type: string }): { kind: DocKind; via: NativeImport<unknown> }[]
  /** Bring a body to the kind's current version and check it. Throws with named words. */
  upgrade(kind: string, body: unknown, from: number): unknown
  /** Runs on each register and unregister. */
  onChange(fn: () => void): () => void
}

export function createKinds(): Kinds {
  const map = new Map<string, DocKind>()
  const subs = new Set<() => void>()
  const changed = () => subs.forEach((f) => f())
  const lower = (n: string) => n.toLowerCase()
  return {
    register(def) {
      if (!KIND_ID.test(def.kind)) throw new Error(`kind "${def.kind}" must read tool.noun in lowercase`)
      if (!def.kind.startsWith(`${def.tool}.`)) throw new Error(`kind "${def.kind}" must start with its tool id "${def.tool}"`)
      if (!EXT.test(def.ext) || def.ext === FALLBACK_EXT) throw new Error(`kind "${def.kind}": extension "${def.ext}" must read .hb<word>.json`)
      if (!Number.isInteger(def.version) || def.version < 1) throw new Error(`kind "${def.kind}": version must be a whole number from 1`)
      if (map.has(def.kind)) throw new Error(`kind "${def.kind}" is registered already`)
      const clash = [...map.values()].find((k) => k.ext === def.ext)
      if (clash) throw new Error(`extension ${def.ext} belongs to ${clash.kind}`)
      map.set(def.kind, def as DocKind)
      changed()
      return () => {
        if (map.get(def.kind) === (def as DocKind)) {
          map.delete(def.kind)
          changed()
        }
      }
    },
    get: (k) => map.get(k),
    all: () => [...map.values()],
    isDocFile: (n) => /\.hb[a-z0-9]+\.json$/.test(lower(n)),
    byExt: (n) => [...map.values()].find((k) => lower(n).endsWith(k.ext)),
    takers(file) {
      const out: { kind: DocKind; via: NativeImport<unknown> }[] = []
      for (const kind of map.values()) {
        const via = kind.imports?.find((i) => accepts(i.accept, file))
        if (via) out.push({ kind, via: via as NativeImport<unknown> })
      }
      return out
    },
    upgrade(kind, body, from) {
      const k = map.get(kind)
      if (!k) return body
      if (from > k.version) throw new Error(`this ${k.label} file is from a newer suite (version ${from}, this build reads ${k.version})`)
      let b = body
      if (from < k.version) {
        if (!k.migrate) throw new Error(`this ${k.label} file is version ${from} and the tool reads only ${k.version}`)
        b = k.migrate(body, from)
      }
      const bad = k.check?.(b)
      if (bad) throw new Error(`this ${k.label} file does not read: ${bad}`)
      return b
    },
    onChange(fn) {
      subs.add(fn)
      return () => subs.delete(fn)
    },
  }
}

/** The kinds every tool registers into. */
export const kinds = createKinds()
export const registerKind = <B>(def: DocKind<B>) => kinds.register(def)
