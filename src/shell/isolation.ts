// Cross origin isolation on the hosted build (design 5 item 10). GitHub
// Pages sends no COOP or COEP headers, so the page registers coi-sw.js,
// which adds them to same origin documents and workers, and reloads once
// so the worker serves the page. The single file builds and file:// pages
// never register it. The settings switch turns it off: the worker is
// removed and the page reloads once without isolation.
//
// The one reload is skipped once the visitor has pressed or typed anything:
// a press in the first second used to land on the page the reload threw
// away. That page runs unisolated; the next load is isolated.
//
// The switch lives in the workspace database with every setting, and is
// mirrored into localStorage so the next load knows it before that
// database opens.
import { shallowRef, watch, type Ref } from 'vue'

export type IsolationState = 'on' | 'file' | 'off' | 'no-worker' | 'pending' | 'failed'

const OFF_KEY = 'hb-isolation-off'
const COEP_KEY = 'hb-isolation-coep'
const RELOADED = 'hb-isolation-reloaded'
const SCRIPT = 'coi-sw.js'

const single = typeof __SINGLE__ !== 'undefined' && __SINGLE__

// a press or a key since this page loaded: the reload would lose it
let touched = false
if (typeof addEventListener === 'function') for (const t of ['pointerdown', 'keydown']) addEventListener(t, () => (touched = true), { capture: true, once: true, passive: true })
const isolatedNow = () => typeof self !== 'undefined' && self.crossOriginIsolated === true

function first(): IsolationState {
  if (isolatedNow()) return 'on'
  if (single || typeof location === 'undefined' || location.protocol === 'file:') return 'file'
  return 'pending'
}

/** Where isolation stands on this page; the thread copy reads it. */
export const isolation = shallowRef<IsolationState>(first())

/** Why wasm runs on one thread here, in words for the copy, or null when it does not. */
export function threadsOffWhy(state: IsolationState = isolation.value): string | null {
  switch (state) {
    case 'on': return null
    case 'file': return 'a file page cannot be cross origin isolated'
    case 'off': return 'isolation is off in settings'
    case 'no-worker': return 'this browser allows no service worker here'
    case 'pending': return 'isolation starts after one reload'
    case 'failed': return 'the isolation worker did not take on this browser'
  }
}

const store = {
  get: (s: Storage | undefined, k: string) => { try { return s?.getItem(k) ?? null } catch { return null } },
  set: (s: Storage | undefined, k: string, v: string | null) => { try { if (v === null) s?.removeItem(k); else s?.setItem(k, v) } catch { /* storage blocked */ } },
}
const local = () => (typeof localStorage === 'undefined' ? undefined : localStorage)
const session = () => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage)

/** credentialless where the browser has it, else require-corp, or the fallback a failed try left. */
function coepMode(): 'credentialless' | 'require-corp' {
  if (store.get(local(), COEP_KEY) === 'require-corp') return 'require-corp'
  const ff = /firefox\/(\d+)/i.exec(navigator.userAgent)
  const has = 'credentialless' in HTMLIFrameElement.prototype || (ff !== null && Number(ff[1]) >= 119)
  return has ? 'credentialless' : 'require-corp'
}

const ours = (r: ServiceWorkerRegistration) => [r.active, r.waiting, r.installing].some((w) => w?.scriptURL.includes(`/${SCRIPT}`))

async function removeWorker(): Promise<boolean> {
  const regs = await navigator.serviceWorker.getRegistrations()
  const mine = regs.filter(ours)
  await Promise.all(mine.map((r) => r.unregister()))
  return mine.length > 0
}

function reloadOnce(): boolean {
  if (touched || store.get(session(), RELOADED)) return false
  store.set(session(), RELOADED, '1')
  location.reload()
  return true
}

/** Register the worker, or remove it when the switch is off. Hosted pages only. */
export async function startIsolation(): Promise<void> {
  if (single || location.protocol === 'file:') return
  const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined
  if (!sw || !isSecureContext) { isolation.value = isolatedNow() ? 'on' : 'no-worker'; return }
  try {
    if (store.get(local(), OFF_KEY)) {
      const had = await removeWorker()
      if (had && isolatedNow()) { location.reload(); return }
      isolation.value = isolatedNow() ? 'on' : 'off'
      return
    }
    const mode = coepMode()
    await sw.register(`./${SCRIPT}?coep=${mode}`, { scope: './' })
    if (isolatedNow()) { store.set(session(), RELOADED, null); isolation.value = 'on'; return }
    if (!sw.controller) {
      await sw.ready
      if (!sw.controller) await new Promise<void>((res) => { sw.addEventListener('controllerchange', () => res(), { once: true }); setTimeout(res, 3000) })
      if (sw.controller && reloadOnce()) return
      if (sw.controller && touched) { isolation.value = 'pending'; return }
    } else if (mode === 'credentialless' && store.get(local(), COEP_KEY) === null) {
      // served by the worker and still not isolated: no credentialless here
      store.set(local(), COEP_KEY, 'require-corp')
      store.set(session(), RELOADED, null)
      await sw.register(`./${SCRIPT}?coep=require-corp`, { scope: './' })
      if (reloadOnce()) return
      if (touched) { isolation.value = 'pending'; return }
    }
    isolation.value = 'failed'
  } catch {
    isolation.value = 'failed'
  }
}

/** Follow the settings switch: a change stores it, adds or removes the worker, and reloads once. */
export function bindIsolationSwitch(on: Ref<unknown>): void {
  if (single || typeof location === 'undefined' || location.protocol === 'file:') return
  watch(on, (v) => {
    const off = v === false
    if (off === (store.get(local(), OFF_KEY) !== null)) return
    store.set(local(), OFF_KEY, off ? '1' : null)
    store.set(session(), RELOADED, null)
    if (off) void removeWorker().finally(() => location.reload())
    else void startIsolation()
  }, { immediate: true })
}
