// The session as the lines HbChat draws, and the context meter's segments.
// Framework free, so the rules are unit tested.
import type { ChatSession, SessionMessage } from '@hackbuild/converse'
import type { HbChatLine, HbMessageAction } from '@virgilvox/hackbuild-ui'

export interface LineState {
  /** The reply streaming now. */
  live?: string | null
  /** What the live reply waits on before its first word. */
  pending?: string
  /** Text and think of the live reply, ahead of the session's copy. */
  text?: string
  think?: string
}

function actions(m: SessionMessage, lastReply: boolean): HbMessageAction[] {
  if (m.role === 'user') return ['copy', 'edit', 'remove']
  return lastReply ? ['speak', 'retry', 'copy', 'remove'] : ['speak', 'copy', 'remove']
}

export function toLines(s: Pick<ChatSession, 'messages'>, st: LineState = {}): HbChatLine[] {
  const last = s.messages.map((m) => m.role).lastIndexOf('assistant')
  return s.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const live = m.id === st.live
      const line: HbChatLine = {
        id: m.id,
        role: m.role as 'user' | 'assistant',
        text: live && st.text !== undefined ? st.text : m.content,
        think: live && st.think !== undefined ? st.think : m.think,
        done: !live,
        actions: live ? [] : actions(m, s.messages.indexOf(m) === last),
      }
      if (live && !line.text) line.pending = st.pending ?? 'thinking'
      if (m.error !== undefined) {
        line.error = true
        line.note = `reply stopped: ${m.error.replace(/\.$/, '')}. press redo.`
      } else if (m.edited) line.note = 'edited'
      if (m.stats) {
        line.stats = { tokPerSec: m.stats.tokensPerSecond, firstMs: m.stats.firstTokenMs, tokens: m.stats.tokens, source: m.stats.tokensSource }
      }
      if (m.toolCalls?.length) line.tools = m.toolCalls.map((c) => ({ name: c.name, args: c.arguments, state: 'ok' }))
      if (m.recalled?.length) line.recalled = m.recalled.map((r) => ({ title: r.text, ref: r.id }))
      if (m.seen) line.seen = m.seen
      return line
    })
}

/** Tokens for a text: 4 characters each (inferred; no tokenizer is loaded for the meter). */
export const tokensOf = (text: string) => Math.ceil(text.length / 4)

/** What the next request holds, by source, for HbContextMeter. */
export function contextSegments(s: Pick<ChatSession, 'system' | 'messages'>, draft = '') {
  const turns = s.messages.filter((m) => m.error === undefined).reduce((a, m) => a + tokensOf(m.raw ?? m.content), 0)
  return [
    { key: 'sys', label: 'instructions', tokens: tokensOf(s.system ?? '') },
    { key: 'turns', label: 'turns', tokens: turns },
    { key: 'draft', label: 'this message', tokens: tokensOf(draft) },
  ]
}
