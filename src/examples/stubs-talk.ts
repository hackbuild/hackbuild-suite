// Stand in runtimes for the talk examples, under ?stub only.
import { scripted } from '@hackbuild/chat'
import type { Job } from '@hackbuild/ai-views'
import type { ExampleDef } from './registry'

export function runtimeFor(job: Job, def: ExampleDef): unknown {
  if (job === 'chat') {
    return scripted({
      replies: [`stand in reply for the ${def.id} example. no model ran.`],
      chunk: 6,
    })
  }
  return undefined
}
