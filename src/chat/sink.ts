// The session store: the conversation core saves through a ChatSink, and
// the chat tool backs it with its open document, so every save is an undo
// step and an autosave of the workspace. Framework free.
import { migrateSession, type ChatSession, type ChatSink } from '@hackbuild/converse'

export interface DocAccess {
  /** The open document's id and body, or null when none is open. */
  read(): { id: string; body: unknown } | null
  /** Replace the open document's body; the caller records the undo step. */
  write(body: ChatSession): void
}

/**
 * A sink over one open document. A load for another id finds nothing, so
 * a conversation made for a closed document starts empty and saves nowhere
 * the open one can see. The saved body carries the document id.
 */
export function docSink(doc: DocAccess): ChatSink {
  return {
    async load(id) {
      const d = doc.read()
      if (!d || d.id !== id) return null
      // a body made by the kind, or imported, carries another id: the document's wins
      return { ...migrateSession(d.body, { id, now: Date.now() }), id }
    },
    async save(session) {
      const d = doc.read()
      if (!d || d.id !== session.id) return
      doc.write(structuredClone(session))
    },
  }
}
