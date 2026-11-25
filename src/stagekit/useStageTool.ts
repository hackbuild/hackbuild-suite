// The shared stage toolbar state for the motion and agents tools (design
// 3.11 and 3.12): transport, seed with restart, camera views, the pad, a
// dropped body, key hints and the tool's tunables. A tool calls this once
// and hands the result to <StageTool>, which draws it. three.js and the
// motion packages load on mount, through the walking stage module.
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch, type Ref } from 'vue'
import { useHotkeys, type HbContextItem, type Hotkey } from '@virgilvox/hackbuild-ui'
import { rollSeed } from '@virgilvox/hackbuild-ui/vanilla'
import { seededRng, type Rng } from '@hackbuild/organic'
import { createRegistry, type Registry, type StorageLike } from '@hackbuild/tunables'
import type { PhoneStage, View } from '../stage/walk'
import { claimDrops } from '../workspace/state'
import { usePrimary, useStop, logEvent } from '../shell/shell'
import { isBodyFile } from './body'

export interface StageToolOptions {
  /** Tool id: names the stored tunables and the log rows. */
  id: string
  /** Empty state copy, shown in the caption while the built in body stands. */
  empty: string
  /** Clip or run length in seconds; 0 runs open ended with no scrub. */
  duration?: number
  /** Frame step of the step buttons and the period key, per second. Default 30 (proposed). */
  fps?: number
  /** First seed. Default 7 (proposed, as the agents copy reads). */
  seed?: number
  /** Defines the tool's tunables; the drawer is generated from them. */
  tunables?: (reg: Registry) => void
  /** Called on mount and on each restart with a fresh stream for the seed. */
  restart?: (rng: Rng, seed: number, ctx: StageCtx) => void
  /** Called each drawn frame while the transport plays, in transport seconds. */
  tick?: (dt: number, time: number, ctx: StageCtx) => void
  /** Show the pad and walk the body with it and wasd. Default true; a tool with nothing to walk turns it off. */
  pad?: boolean
  /** The pad moves the body itself. Default true; false leaves the moving to the tool, which reads `move`. */
  walk?: boolean
  /**
   * The right click or long press menu of the stage (P-ROOM-2): asked for
   * at a point in stage pixels, before it opens. Null or no items keeps it
   * shut.
   */
  menu?: (at: { x: number; y: number }) => StageMenu | null
  /** A menu item was chosen: the sentence it sends. */
  say?: (sentence: string) => void
  /** Rewrites the key hints of the stage, as the tool's own keys read (P-KEY-6). */
  hints?: (base: KeyHint[]) => KeyHint[]
}

export interface StageMenu {
  title: string
  items: HbContextItem[]
}

export interface StageCtx {
  walk: PhoneStage
  reg: Registry
}

export interface KeyHint {
  keys: string
  label: string
}

/** Values the registry keeps, in this browser's storage when it allows. */
function safeStorage(): StorageLike | undefined {
  try {
    const s = globalThis.localStorage
    s.getItem('suite-probe')
    return s
  } catch {
    return undefined
  }
}

const sizeOf = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} mb` : `${Math.max(1, Math.round(n / 1024))} kb`)

export function useStageTool(opts: StageToolOptions) {
  const fps = opts.fps ?? 30
  const pad = opts.pad ?? true
  const reg = createRegistry({ storage: safeStorage(), storageKey: `suite-tune-${opts.id}` })
  opts.tunables?.(reg)
  reg.restore()

  const values = reactive<Record<string, number>>(reg.snapshot())
  const offReg = reg.onChange((k, v) => { values[k] = v })

  const transport = reactive({ playing: true, time: 0, duration: opts.duration ?? 0, rate: 1, loop: true })
  const seed = ref(opts.seed ?? 7)
  const locked = ref(true)
  const view = ref<View>('front')
  const move = ref({ x: 0, y: 0 })
  const tune = ref(false)
  const body = reactive({ name: 'mannequin', placeholder: true, line: opts.empty, failed: false })
  const stats = reactive({ fps: '--' as number | string, draw: '--' })
  const cover = ref('loading the stage')
  const failed = ref(false)
  const host: Ref<HTMLElement | null> = ref(null)
  const walk = shallowRef<PhoneStage | null>(null)
  let gone = false

  const ctx = (): StageCtx | null => (walk.value ? { walk: walk.value, reg } : null)

  function restart() {
    if (!locked.value) seed.value = rollSeed()
    transport.time = 0
    const c = ctx()
    if (c) opts.restart?.(seededRng(seed.value), seed.value, c)
    walk.value?.stage.loop.invalidate()
  }
  const play = () => { if (transport.duration && transport.time >= transport.duration) transport.time = 0; transport.playing = true; walk.value?.stage.loop.invalidate() }
  const pause = () => { transport.playing = false }
  const toggle = () => (transport.playing ? pause() : play())
  function seek(t: number) {
    transport.time = transport.duration ? Math.min(transport.duration, Math.max(0, t)) : Math.max(0, t)
    walk.value?.stage.loop.invalidate()
  }
  function step(dir: 1 | -1) {
    pause()
    const c = ctx()
    const dt = 1 / fps
    if (dir > 0 && c) opts.tick?.(dt, transport.time + dt, c)
    seek(transport.time + dir * dt)
  }

  /** The transport clock, advanced by the stage's own loop. */
  function frame(dt: number) {
    if (!transport.playing) return
    let t = transport.time + dt * transport.rate
    if (transport.duration && t >= transport.duration) {
      if (transport.loop) t %= transport.duration
      else { t = transport.duration; transport.playing = false }
    }
    transport.time = t
    const c = ctx()
    if (c) opts.tick?.(dt * transport.rate, t, c)
    walk.value?.stage.loop.invalidate()
  }

  async function showBody(files: File[]) {
    const w = walk.value
    const f = files.find(isBodyFile)
    if (!w || !f) {
      if (files[0]) body.line = `this file is a ${files[0].name.replace(/^.*\./, '') || 'file with no extension'}. drop a glb or vrm.`
      return
    }
    body.line = `reading ${f.name}, ${sizeOf(f.size)}.`
    body.failed = false
    logEvent('note', `${opts.id}: reading ${f.name}`)
    await w.stage.show(files)
  }

  onMounted(async () => {
    try {
      const { createPhoneStage } = await import('../stage/walk')
      if (gone || !host.value) return
      const w = createPhoneStage(host.value, (s) => {
        stats.fps = s.fps
        stats.draw = `${s.width}x${s.height}`
      }, { speed: () => (opts.walk === false || !pad ? 0 : reg.has('walk.speed') ? reg.get('walk.speed') : 1.4) })
      w.stage.on('loaded', (e) => {
        body.name = e.name
        body.placeholder = e.placeholder
        body.line = e.placeholder ? opts.empty : `${e.name} on the stage. it stays in this tab.${e.warnings.length ? ` ${e.warnings[0]}` : ''}`
        if (!e.placeholder) logEvent('note', `${opts.id}: ${e.name} on the stage`)
      })
      w.stage.on('failed', (e) => {
        body.failed = true
        body.line = `${e.message} the built in rig is still here.`
        logEvent('fail', `${opts.id}: ${e.message}`)
      })
      const prev = w.stage.scene.onBeforeRender
      let last = w.stage.loop.time
      w.stage.scene.onBeforeRender = (...a) => {
        const t = w.stage.loop.time
        frame(Math.min(0.1, Math.max(0, t - last)))
        last = t
        prev.apply(w.stage.scene, a)
      }
      w.setMove(move.value)
      walk.value = w
      // for the smoke: the tool handle on its host element, no global
      ;(host.value as HTMLElement & { stageTool?: unknown }).stageTool = { walk: w, reg, transport, seed, view, body, values }
      cover.value = ''
      restart()
    } catch (err) {
      failed.value = true
      cover.value = `the 3d view did not start. ${err instanceof Error ? err.message : String(err)}`
    }
  })
  watch(move, (v) => walk.value?.setMove(v))
  watch(view, (v) => walk.value?.view(v))
  watch(seed, () => { if (locked.value) restart() })

  // a glb or vrm dropped anywhere goes to this stage, not the import ring
  claimDrops({ accept: isBodyFile, take: (files) => void showBody(files) })
  usePrimary(toggle)
  useStop(pause)

  const table: Hotkey[] = [
    { keys: 'space', label: 'play or pause', group: 'stage', run: toggle },
    { keys: '.', label: 'step one frame on', group: 'stage', run: () => step(1) },
    { keys: 'l', label: 'loop on or off', group: 'stage', run: () => { transport.loop = !transport.loop } },
    { keys: 'r', label: 'restart with the same seed', group: 'stage', run: restart },
    { keys: 't', label: 'tune: the settings of this tool', group: 'stage', run: () => { tune.value = !tune.value } },
  ]
  useHotkeys(table)
  const base: KeyHint[] = [
    { keys: 'space', label: 'play' },
    { keys: '.', label: 'step' },
    { keys: 'r', label: 'restart' },
    { keys: '1 to 4', label: 'view' },
    { keys: 'wasd', label: 'walk' },
    { keys: 't', label: 'tune' },
  ].filter((h) => pad || h.keys !== 'wasd')
  const hints = opts.hints ? opts.hints(base) : base

  onBeforeUnmount(() => {
    gone = true
    claimDrops(null)
    offReg()
    walk.value?.dispose()
    walk.value = null
  })

  return {
    id: opts.id, pad, menu: opts.menu, say: opts.say, reg, values, transport, seed, locked, view, move, tune, body, stats, cover, failed, host, walk, hints,
    play, pause, toggle, seek, step, restart, showBody,
  }
}

export type StageTool = ReturnType<typeof useStageTool>
