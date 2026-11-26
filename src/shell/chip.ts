// The one model chip in the bar. An example hands the shell its own pick;
// a tool page of today gets a pick for its job that loads through the shared
// model hub, so the tool sees what the chip loaded. Both load lazily, after
// the first paint.
import { shallowRef, watch } from 'vue'
import type { Job, ModelPick } from '@hackbuild/ai-views'
import { loadModels } from '../models/lazy'

/** The pick the bar shows, or null for none (home, a part with no model). */
export const chipPick = shallowRef<ModelPick | null>(null)

const tools = new Map<Job, Promise<ModelPick>>()

/** A pick over the hub: its load is the hub's load, its progress the hub's state. */
export function toolPick(job: Job): Promise<ModelPick> {
  let p = tools.get(job)
  if (!p) {
    p = Promise.all([import('@hackbuild/ai-views'), loadModels()]).then(([{ useModelPick }, hub]) =>
      useModelPick(job, {
        ...(hub.env.value ? { env: hub.env.value } : {}),
        loader: async (rec, ctx) => {
          const stop = watch(() => hub.states.value[rec.id], (s) => {
            if (s?.state === 'downloading') ctx.onProgress(s.total ? (s.loaded ?? 0) / s.total : null)
          })
          ctx.signal.addEventListener('abort', () => hub.cancel(rec.id))
          try {
            await hub.load(rec.id)
          } finally {
            stop()
          }
          const s = hub.states.value[rec.id]
          if (s?.state === 'fault') throw new Error(s.error)
        },
      }),
    )
    tools.set(job, p)
  }
  return p
}
