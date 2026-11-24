// Whether the window is at least as wide as a media query, live. A tool
// that shows a part inline from 1024 px, and in a drawer below it, reads
// this to pick where the part goes; the layout itself is the kit's
// `.hb-toolpage.is-split`.
import { onBeforeUnmount, ref, type Ref } from 'vue'

export function useWide(query = '(min-width: 1024px)'): Ref<boolean> {
  const mq = typeof matchMedia === 'function' ? matchMedia(query) : null
  const wide = ref(!!mq?.matches)
  const on = (e: MediaQueryListEvent) => { wide.value = e.matches }
  mq?.addEventListener('change', on)
  onBeforeUnmount(() => mq?.removeEventListener('change', on))
  return wide
}
