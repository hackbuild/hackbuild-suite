// Stand in runtimes for the talk examples, under ?stub only: what jobLoader
// would resolve to, written in code. A chat job gets a scripted ChatEngine
// shaped for its example; an embed job gets the hashed embedder.
import { scripted } from '@hackbuild/chat'
import { hashedEmbedder } from '@hackbuild/memory'
import type { Job } from '@hackbuild/ai-views'
import type { ExampleDef } from './registry'

const REPLIES: Record<string, string[]> = {
  chat: ['stand in reply for the gate. no model ran.'],
  think: ['<think>a stand in plan: three steps, the slow part first.</think>stand in answer for the gate. no model ran.'],
  json: ['{"project": "desk lamp", "parts": ["led strip", "switch", "usb cable",], "hours": 3,}'],
  memory: ['stand in reply. memory found the lines under this.'],
  'character-card': ['stand in line from the character. no model ran.'],
}

export function runtimeFor(job: Job, def: ExampleDef): unknown {
  if (job === 'chat') return scripted({ replies: REPLIES[def.id] ?? REPLIES.chat!, chunk: 6, schema: def.id === 'json' })
  if (job === 'embed') return hashedEmbedder(512)
  return undefined
}
