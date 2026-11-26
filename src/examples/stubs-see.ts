// Stand in runtimes for the see examples, under ?stub only.
import type { Job } from '@hackbuild/ai-views'
import type { ExampleDef } from './registry'

export function runtimeFor(_job: Job, _def: ExampleDef): unknown {
  return undefined
}
