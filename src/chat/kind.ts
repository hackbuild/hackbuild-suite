// The chat document kind (design 3.1): one session per document, saved as
// `.hbchat.json`, with markdown as a native export and a plain json chat
// export from another app as a native import. Framework free.
import { createSession, importSession, migrateSession, sessionToMarkdown, type ChatSession } from '@hackbuild/converse'
import type { DocKind } from '../workspace/kinds.ts'

export const CHAT_KIND = 'chat.session'
/** The name a new chat document gets until its first message names it. */
export const NEW_CHAT = 'new chat'

/** A document name from the first user turn: one line, at most 40 characters. */
export function titleFrom(s: Pick<ChatSession, 'messages'>): string | null {
  const first = s.messages.find((m) => m.role === 'user')?.content.replace(/\s+/g, ' ').trim()
  if (!first) return null
  return first.length > 40 ? `${first.slice(0, 39).trimEnd()}...` : first
}

export const chatKind: DocKind<ChatSession> = {
  kind: CHAT_KIND,
  tool: 'chat',
  label: 'chat',
  ext: '.hbchat.json',
  version: 1,
  create: () => createSession({ id: 'chat', now: Date.now(), title: NEW_CHAT }),
  check(body) {
    try {
      migrateSession(body)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  },
  models: (b) => (b.model ? [b.model.id] : []),
  imports: [
    {
      accept: '.json,application/json',
      label: 'open as a chat',
      async read(file) {
        const s = importSession(await file.text(), { now: Date.now() })
        return { name: s.title === 'imported chat' ? file.name.replace(/\.json$/i, '') : s.title, body: s }
      },
    },
  ],
  exports: [{ key: 'md', label: 'markdown', ext: '.md', copy: true, type: 'text/markdown', write: (b) => sessionToMarkdown(b) }],
}
