// The model manager module is a lazy chunk. The shell starts it after the
// first paint; the pills, the status strip and home read it once it is in.
import { shallowRef } from 'vue'

export type Models = typeof import('./hub')
export const models = shallowRef<Models | null>(null)

let loading: Promise<Models> | null = null
export function loadModels(): Promise<Models> {
  loading ??= import('./hub').then(async (m) => {
    models.value = m
    await m.start()
    return m
  })
  return loading
}
