/// <reference types="vite/client" />
declare const __SINGLE__: boolean
/** The tool group of a group single file, empty in the hosted and full builds. */
declare const __GROUP__: string
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}
declare module '@hackbuild/*/how' {
  import type { HbHowDoc } from '@virgilvox/hackbuild-ui'
  const doc: HbHowDoc
  export default doc
}
