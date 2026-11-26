// Stand ins for the gate and the smokes, loaded only under ?stub (see
// STUB in registry.ts): a machine fixture and a loader that moves a bar,
// fetches nothing, and resolves to the runtime a job's real loader would,
// written in code. A visitor's page never imports this file.
import type { Env } from '@hackbuild/ai-env'
import type { Job, Loader } from '@hackbuild/ai-views'
import type { ExampleDef, Hooks } from './registry'

/** A machine with an 8 gb class gpu, as a probe would report it (fixture). */
export const FIXTURE_ENV = {
  webgpu: true,
  f16: true,
  adapter: null,
  maxBufferBytes: null,
  isolated: false,
  protocol: 'https',
  opfs: true,
  cacheStorage: true,
  indexedDB: true,
  threads: 1,
  deviceMemoryGB: 8,
  promptApi: false,
} as unknown as Env

/** What each job's stand in resolves to, per example; one module per example job. */
export type Runtimes = (job: Job, def: ExampleDef) => unknown | Promise<unknown>
const RUNTIMES: Record<string, () => Promise<{ runtimeFor: Runtimes }>> = {
  talk: () => import('./stubs-talk'),
  listen: () => import('./stubs-listen'),
  see: () => import('./stubs-see'),
  make: () => import('./stubs-see'),
}

/** Moves the bar to full over about a second, then hands back the stand in runtime. */
function stubLoader(job: Job, def: ExampleDef): Loader {
  return (_rec, ctx) =>
    new Promise((ok, bad) => {
      let f = 0
      const t = setInterval(() => {
        f = Math.min(1, f + 0.25)
        ctx.onProgress(f)
        if (f < 1) return
        clearInterval(t)
        const mod = RUNTIMES[def.job]
        if (!mod) return ok(undefined)
        mod().then((m) => m.runtimeFor(job, def)).then(ok, bad)
      }, 150)
      ctx.signal.addEventListener('abort', () => (clearInterval(t), bad(new Error('stopped'))))
    })
}

export function stubHooks(def: ExampleDef): Hooks {
  return { env: FIXTURE_ENV, loaderFor: (job) => stubLoader(job, def) }
}
