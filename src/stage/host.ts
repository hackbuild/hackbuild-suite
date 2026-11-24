// The stage host (design 2.9). Framework free. It sizes a renderer to its
// container, runs one loop per stage, and stops the loop whenever nobody
// can see it: page hidden, host off screen or at zero size, route not
// active, or an overlay covering the stage. three.js is never imported
// here; any renderer with this shape works, and canvas 2D stages pass a
// small adapter.

export interface StageRenderer {
  domElement: HTMLCanvasElement
  setSize(width: number, height: number, updateStyle?: boolean): void
  setPixelRatio(ratio: number): void
  setAnimationLoop(fn: ((time: number) => void) | null): void
  dispose(): void
  forceContextLoss?(): void
}

export interface StageHostOptions {
  renderer: StageRenderer
  /** Draw one frame. dt and time in seconds. */
  draw(dt: number, time: number): void
  /** Container size changed: set the camera aspect here. */
  resize?(width: number, height: number): void
  /** The fixed step the first delta after a pause is clamped to. Default 1/60 s. */
  step?: number
  /** Default 2. */
  maxPixelRatio?: number
  /** The 3d context was lost: show "the 3d view was lost. press to restore." */
  onLost?(): void
  /** The context is back: rebuild the scene from the document. */
  onRestored?(): void
  /** Browser globals, replaced in tests. */
  env?: Partial<StageEnv>
}

export interface StageEnv {
  document: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>
  devicePixelRatio: number
  ResizeObserver: typeof ResizeObserver
  IntersectionObserver: typeof IntersectionObserver
  matchMedia: (q: string) => Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>
  now: () => number
}

export interface StageHost {
  /** The loop is running. */
  readonly running: boolean
  /** Frames drawn since creation. */
  readonly frames: number
  /** The tool's route is the active one. */
  setActive(on: boolean): void
  /** A sheet or modal covers the whole stage. */
  setCovered(on: boolean): void
  /** Draw one frame now; the way a paused or reduced motion stage shows a change. */
  invalidate(): void
  /** Stop the loop, dispose the renderer and drop its context. */
  dispose(): void
}

export function createStageHost(host: HTMLElement, opts: StageHostOptions): StageHost {
  const env: StageEnv = {
    document: globalThis.document,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
    ResizeObserver: globalThis.ResizeObserver,
    IntersectionObserver: globalThis.IntersectionObserver,
    matchMedia: (q) => globalThis.matchMedia(q),
    now: () => performance.now(),
    ...opts.env,
  }
  const { renderer } = opts
  const step = opts.step ?? 1 / 60
  const canvas = renderer.domElement
  renderer.setPixelRatio(Math.min(env.devicePixelRatio, opts.maxPixelRatio ?? 2))
  if (canvas.parentElement !== host) host.appendChild(canvas)

  let width = 0
  let height = 0
  let onScreen = true
  let active = true
  let covered = false
  let lost = false
  let disposed = false
  let running = false
  let frames = 0
  let last = 0
  let fresh = true
  const reduced = env.matchMedia('(prefers-reduced-motion: reduce)')

  const frame = (dt: number, time: number) => {
    opts.draw(dt, time)
    frames++
  }

  const loop = (time: number) => {
    const t = time / 1000
    // Time does not jump on resume: the first delta is one fixed step.
    const dt = fresh ? step : Math.min(t - last, step * 4)
    fresh = false
    last = t
    frame(dt, t)
  }

  const visible = () => !env.document.hidden && onScreen && width > 0 && height > 0 && active && !covered && !lost && !disposed

  const update = () => {
    const want = visible() && !reduced.matches
    if (want === running) return
    running = want
    if (want) {
      fresh = true
      renderer.setAnimationLoop(loop)
      // Never blank on return: one frame at once.
      frame(step, env.now() / 1000)
    } else {
      renderer.setAnimationLoop(null)
    }
  }

  const sized = (w: number, h: number) => {
    width = Math.floor(w)
    height = Math.floor(h)
    if (width > 0 && height > 0) {
      renderer.setSize(width, height, true)
      opts.resize?.(width, height)
    }
    const was = running
    update()
    // A paused or reduced motion stage still shows the new size.
    if (!was && !running && visible()) frame(0, env.now() / 1000)
  }

  const ro = new env.ResizeObserver((entries) => {
    const box = entries[entries.length - 1]?.contentRect
    if (box) sized(box.width, box.height)
  })
  ro.observe(host)
  const io = new env.IntersectionObserver((entries) => {
    const e = entries[entries.length - 1]
    if (e) onScreen = e.isIntersecting
    update()
  })
  io.observe(host)

  const onVisibility = () => update()
  const onReduced = () => update()
  const onLost = (e: Event) => {
    e.preventDefault()
    lost = true
    update()
    opts.onLost?.()
  }
  const onRestored = () => {
    lost = false
    opts.onRestored?.()
    update()
    if (!running && visible()) frame(0, env.now() / 1000)
  }
  env.document.addEventListener('visibilitychange', onVisibility)
  reduced.addEventListener('change', onReduced)
  canvas.addEventListener('webglcontextlost', onLost)
  canvas.addEventListener('webglcontextrestored', onRestored)

  return {
    get running() {
      return running
    },
    get frames() {
      return frames
    },
    setActive(on) {
      active = on
      update()
    },
    setCovered(on) {
      covered = on
      update()
    },
    invalidate() {
      if (visible() && !running) frame(0, env.now() / 1000)
    },
    dispose() {
      if (disposed) return
      disposed = true
      update()
      ro.disconnect()
      io.disconnect()
      env.document.removeEventListener('visibilitychange', onVisibility)
      reduced.removeEventListener('change', onReduced)
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      renderer.setAnimationLoop(null)
      renderer.dispose()
      renderer.forceContextLoss?.()
      canvas.remove()
    },
  }
}
