// Shell state every tool shares: the event log, the activity line, the
// open overlay, the composer for "/", the primary action for ctrl+enter
// and the stop handlers for esc (design 2.1, 2.6, 2.7).
import { onBeforeUnmount, ref, shallowRef, type Ref } from 'vue'
import { activity } from '@virgilvox/hackbuild-ui/vanilla'
import type { HbEventRow } from '@virgilvox/hackbuild-ui'
import { onCore } from '../cores.ts'

/** What the app is busy with now; the header line and the status strip read it. */
export const jobs = activity()

/** One event log per project, newest last. */
export const events = shallowRef<HbEventRow[]>([])
let nextId = 1
const clock = () => new Date().toTimeString().slice(0, 8)

/** Add a row, or replace the live row with the same id in place. */
export function logEvent(kind: string, text: string, opts: { id?: string; live?: boolean; fraction?: number } = {}): void {
  const row: HbEventRow = { id: opts.id ?? nextId++, kind, text, t: clock(), live: opts.live, fraction: opts.fraction }
  const at = opts.id === undefined ? -1 : events.value.findIndex((r) => r.id === opts.id)
  const rows = events.value.slice(-499)
  if (at >= 0) rows.splice(rows.findIndex((r) => r.id === opts.id), 1, row)
  else rows.push(row)
  events.value = rows
}

onCore((e) => {
  const id = `core-${e.name}`
  if (e.state === 'loading') {
    jobs.set(id, `loading the ${e.name} core`)
    logEvent('load', `core: ${e.name} loading`, { id, live: true })
  } else if (e.state === 'ready') {
    jobs.end(id)
    logEvent('load', `core: ${e.name} ready in ${e.ms} ms (measured)`, { id })
  } else if (e.state === 'failed') {
    jobs.fail(id, `${e.name} core failed: ${e.error}`)
    logEvent('fail', `core: ${e.name} failed. ${e.error}`, { id })
  }
})

/**
 * Tools that pin an input in the shell's dock on a phone (P-PHONE-1). Above
 * zero the shell draws its dock and a tool teleports into DOCK.
 */
export const dock = ref(0)
export const DOCK = '.hb-app-foot > .hb-dock'

/** The one overlay open at a time. */
export type Overlay = '' | 'settings' | 'keys' | 'log' | 'models' | 'palette' | 'docs' | 'export'
export const overlay = ref<Overlay>('')

/** A tool with a composer registers it; "/" focuses it in place of the palette. */
const composer = shallowRef<HTMLElement | null>(null)
export function focusComposer(): boolean {
  const el = composer.value
  if (!el || !el.isConnected) return false
  el.focus()
  return true
}
export function useComposer(el: Ref<HTMLElement | null | undefined>): void {
  const stop = () => {
    if (composer.value === el.value) composer.value = null
  }
  queueMicrotask(() => (composer.value = el.value ?? null))
  onBeforeUnmount(stop)
}

/** The active tool's primary action, run by ctrl+enter on every pointer. */
const primary = shallowRef<(() => void) | null>(null)
export function runPrimary(): boolean {
  if (!primary.value) return false
  primary.value()
  return true
}
export function usePrimary(fn: () => void): void {
  primary.value = fn
  onBeforeUnmount(() => {
    if (primary.value === fn) primary.value = null
  })
}

/** Audio and generation register a stop; esc with no overlay open runs them all. */
const stoppers = new Set<() => void>()
export function stopAll(): number {
  for (const fn of stoppers) fn()
  return stoppers.size
}
export function useStop(fn: () => void): void {
  stoppers.add(fn)
  onBeforeUnmount(() => stoppers.delete(fn))
}
