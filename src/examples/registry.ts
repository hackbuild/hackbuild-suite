// The examples of examples/index.json that have a file. Each loads through a
// dynamic import, and its source comes in raw from the same file at build
// time, so the source on screen is the file that runs.
import type { Job } from '@hackbuild/ai-views'
import index from '../../examples/index.json'
import type { Env } from '@hackbuild/ai-env'
import type { Loader, ModelPick } from '@hackbuild/ai-views'

/** What an example hands back: how to stop, the pick its bar chip shows, and its built in sample. */
export interface Example {
  dispose(): void
  pick?: ModelPick
  sample?: () => Promise<void>
}
/** Stand ins the gate and the smokes pass in; a visitor's page passes nothing. */
export interface Hooks {
  env?: Env
  loaderFor?: (job: Job) => Loader
}
/** The one switch for stand ins: ?stub in the page address, set only by the gate and the smokes. */
export const STUB = typeof location !== 'undefined' && new URLSearchParams(location.search).has('stub')

export interface ExampleDef {
  job: string
  id: string
  title: string
  line: string
  layout: string
  model?: Job
  readme: string
  packages: string[]
  repo: string
}

// a group single file carries no examples
type Lazy<T> = Record<string, () => Promise<T>>
const modules: Lazy<{ default: (host: HTMLElement, hooks?: Hooks) => Example }> = __GROUP__ ? {} : import.meta.glob<{ default: (host: HTMLElement, hooks?: Hooks) => Example }>('../../examples/*/*/example.ts')
const sources: Lazy<string> = __GROUP__ ? {} : import.meta.glob<string>('../../examples/*/*/example.ts', { query: '?raw', import: 'default' })
const key = (e: { job: string; id: string }) => `../../examples/${e.job}/${e.id}/example.ts`

export const JOBS: { id: string; title: string }[] = index.jobs
export const EXAMPLES: ExampleDef[] = (index.examples as ExampleDef[]).filter((e) => key(e) in modules)

export const examplePath = (e: { job: string; id: string }) => `/examples/${e.job}/${e.id}`
export const exampleFile = (e: { job: string; id: string }) => `examples/${e.job}/${e.id}/example.ts`
export const findExample = (job: string, id: string) => EXAMPLES.find((e) => e.job === job && e.id === id)
export const loadExample = (e: ExampleDef) => modules[key(e)]!().then((m) => m.default)
export const loadSource = (e: ExampleDef) => sources[key(e)]!()

/** The install line: the packages the example imports, and the kit. */
export const installLine = (e: ExampleDef) => `npm install ${[...e.packages, '@virgilvox/hackbuild-ui'].join(' ')}`
export const npmUrl = (pkg: string) => `https://www.npmjs.com/package/${pkg}`
export const readmeUrl = (e: ExampleDef) => npmUrl(e.readme)
