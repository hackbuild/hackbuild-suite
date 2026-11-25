/// <reference types="vite/client" />
declare const __SINGLE__: boolean
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
