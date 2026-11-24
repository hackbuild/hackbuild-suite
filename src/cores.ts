// Library cores, created once and shared (design 2.9). A tool asks for a
// core with core('dsp') when it mounts or at its first action; two tools
// asking for the same core get the same promise, so one wasm instance
// serves both. Nothing here runs at import time.
//
// Every core starts on a stub provider that loads nothing. The item that
// builds a tool swaps in the real loader from its package with provide(),
// for example provide('dsp', () => loadDsp(url)) from @hackbuild/audio-dsp.

/** The wasm cores of the libraries, by the package that owns each. */
export const CORES = {
  dsp: '@hackbuild/audio-dsp',
  'depth-mesh': '@hackbuild/depth-mesh',
  memory: '@hackbuild/memory',
  character: '@hackbuild/character',
  motion: '@hackbuild/motion',
  agents: '@hackbuild/agents',
} as const

export type CoreName = keyof typeof CORES
export type CoreState = 'idle' | 'loading' | 'ready' | 'failed'

/** What a stub provider resolves to: no wasm, no weights, no fetch. */
export interface StubCore {
  stub: true
  name: CoreName
  package: string
}

export interface CoreEvent {
  name: CoreName
  state: CoreState
  /** Load time in ms, measured, on ready. */
  ms?: number
  error?: string
}

type Loader = () => Promise<unknown>

const stub = (name: CoreName): Loader => () => Promise.resolve<StubCore>({ stub: true, name, package: CORES[name] })

const loaders = new Map<CoreName, Loader>()
const pending = new Map<CoreName, Promise<unknown>>()
const states = new Map<CoreName, CoreState>()
const listeners = new Set<(e: CoreEvent) => void>()

function emit(e: CoreEvent): void {
  states.set(e.name, e.state)
  for (const fn of listeners) fn(e)
}

/** Replace a core's provider. Refused once the core has started loading,
 * so two tools never end up with two instances. */
export function provide(name: CoreName, loader: Loader): void {
  if (pending.has(name)) throw new Error(`core ${name} is already loading or loaded; provide it before the first core() call`)
  loaders.set(name, loader)
}

/** The shared core. The first call starts the load; later calls get the
 * same promise. A failed load is forgotten so a retry can start a new one. */
export function core<T = unknown>(name: CoreName): Promise<T> {
  if (!(name in CORES)) return Promise.reject(new Error(`no core named ${name}`))
  let p = pending.get(name)
  if (!p) {
    const start = performance.now()
    emit({ name, state: 'loading' })
    p = (loaders.get(name) ?? stub(name))().then(
      (c) => {
        emit({ name, state: 'ready', ms: Math.round(performance.now() - start) })
        return c
      },
      (err: unknown) => {
        pending.delete(name)
        emit({ name, state: 'failed', error: err instanceof Error ? err.message : String(err) })
        throw err
      },
    )
    pending.set(name, p)
  }
  return p as Promise<T>
}

export function coreState(name: CoreName): CoreState {
  return states.get(name) ?? 'idle'
}

/** Follow loads, for the event log and the activity line. */
export function onCore(fn: (e: CoreEvent) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Tests only: forget every core and provider. */
export function resetCores(): void {
  loaders.clear()
  pending.clear()
  states.clear()
  listeners.clear()
}
