// Registers the transcript kind once, so a recording dropped on any page
// routes to the transcription tool (design 2.5). The shell calls it after
// the first paint; the tool calls it again on mount, which is a no op.
import { kinds, registerKind, ws } from '../workspace/state'
import { TRANSCRIPT_KIND, transcriptKind } from './kind.ts'

export function registerTranscript(): void {
  if (!kinds.get(TRANSCRIPT_KIND)) registerKind(transcriptKind((data, meta) => ws.putBlob(data, meta)))
}
