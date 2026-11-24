// The vision document kind (design 3.4): a session holds the captures,
// each a small jpeg of the exact frame the models saw, with what each task
// returned and how long it took. Saved as `.hbvision.json`; an image
// dropped on the window opens as a new session; the results export as
// json and the annotated frame as png (drawn by the view). Framework free,
// so the tests run it in node.

import type { DocKind } from '../workspace/kinds.ts'

export const VISION_KIND = 'vision.session'
/** Captures kept per session, newest first. */
export const CAPTURES_CAP = 8
/** The long side of a stored frame, px. Models see the same frame. */
export const FRAME_SIDE = 640
/** Horizontal field of view used for bearings when the camera's is unknown (inferred, a typical webcam). */
export const FOV_DEG = 60

export type Task = 'detect' | 'landmarks' | 'caption' | 'ask'
export const TASKS: Task[] = ['detect', 'landmarks', 'caption', 'ask']
export type LandmarkKind = 'face' | 'hand' | 'pose'
export const LANDMARK_KINDS: LandmarkKind[] = ['face', 'hand', 'pose']

/** The capability each task routes by on the hub. */
export const capOf = (t: Task, kind: LandmarkKind): string =>
  t === 'detect' ? 'detect' : t === 'landmarks' ? `landmarks.${kind}` : t === 'caption' ? 'vision.caption' : 'vision.ask'

export interface Found {
  label: string
  score: number
  /** Frame pixels. */
  box: { x: number; y: number; w: number; h: number }
  hidden?: boolean
}

export interface Answer {
  question: string
  answer: string
  at: number
  ms: number
  model: string
}

export interface Capture {
  id: string
  name: string
  at: number
  /** upload, camera, paste, sample, drop, live. */
  from: string
  /** A jpeg data url of the frame, at most FRAME_SIDE on its long side. */
  image: string
  width: number
  height: number
  found: Found[]
  /** Landmark sets, x and y 0 to 1. */
  points: { kind: LandmarkKind; sets: [number, number, number][][]; source: string }[]
  caption: string | null
  answers: Answer[]
  /** ms per task, measured. */
  ms: Partial<Record<Task, number>>
  /** Record ids that answered. */
  models: string[]
}

export interface VisionBody {
  tasks: Task[]
  landmarks: LandmarkKind
  question: string
  captures: Capture[]
  current: string | null
}

export const newSession = (): VisionBody => ({ tasks: ['detect', 'caption'], landmarks: 'face', question: '', captures: [], current: null })

/** Push a capture, newest first, capped; it becomes the current one. */
export function withCapture(b: VisionBody, c: Capture): VisionBody {
  return { ...b, captures: [c, ...b.captures.filter((x) => x.id !== c.id)].slice(0, CAPTURES_CAP), current: c.id }
}

/** Fit w by h inside a square of `side`, never enlarging. */
export function fitSide(w: number, h: number, side = FRAME_SIDE): { width: number; height: number } {
  const k = Math.min(1, side / Math.max(w, h, 1))
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) }
}

/** Where a box sits left or right of the frame centre, in degrees (ARBOR's in view list). */
export function bearing(box: Found['box'], width: number, fov = FOV_DEG): string {
  const off = (box.x + box.w / 2) / Math.max(1, width) - 0.5
  const deg = Math.round(off * fov)
  return deg === 0 ? 'ahead' : `${Math.abs(deg)} deg ${deg < 0 ? 'left' : 'right'}`
}

/** One line for the history strip: what was found, and the slowest task. */
export function captureMeta(c: Capture): string {
  const n = c.found.length
  const parts = [n ? `${n} found` : 'none found']
  if (c.caption) parts.push('caption')
  const ms = Object.values(c.ms).filter((v): v is number => typeof v === 'number')
  if (ms.length) parts.push(`${Math.round(Math.max(...ms))} ms`)
  return parts.join(', ')
}

/** The results without the frames, for the json export. */
export function results(b: VisionBody, name: string): string {
  return JSON.stringify(
    {
      session: name,
      captures: b.captures.map(({ image: _image, ...c }) => ({ ...c, found: c.found.map(({ hidden: _h, ...f }) => f) })),
    },
    null,
    2,
  )
}

function check(b: unknown): string | null {
  const s = b as Partial<VisionBody> | null
  if (!s || typeof s !== 'object') return 'a session is an object.'
  if (!Array.isArray(s.captures)) return 'a session has no capture list.'
  if (!Array.isArray(s.tasks)) return 'a session names no tasks.'
  if (s.captures.some((c) => typeof c?.image !== 'string' || !c.image.startsWith('data:image/'))) return 'a capture has no frame.'
  return null
}

/** Decode an image file into a stored frame; the browser only. */
export type FrameReader = (file: Blob) => Promise<{ image: string; width: number; height: number }>

export function visionKind(readFrame: FrameReader): DocKind<VisionBody> {
  return {
    kind: VISION_KIND,
    tool: 'vision',
    label: 'vision session',
    ext: '.hbvision.json',
    version: 1,
    create: newSession,
    check,
    models: (b) => [...new Set(b.captures.flatMap((c) => c.models))],
    imports: [
      {
        accept: 'image/*,.png,.jpg,.jpeg,.webp,.gif',
        label: 'open in vision',
        async read(file) {
          if (file.type && !file.type.startsWith('image/')) throw new Error(`${file.name} is not an image.`)
          const f = await readFrame(file)
          const name = file.name.replace(/\.[a-z0-9]+$/i, '')
          const c: Capture = { id: Date.now().toString(36), name, at: Date.now(), from: 'drop', ...f, found: [], points: [], caption: null, answers: [], ms: {}, models: [] }
          return { name, body: withCapture(newSession(), c) }
        },
      },
    ],
    exports: [
      { key: 'results', label: 'results', ext: '.vision.json', note: 'what each task found, per capture, without the frames.', type: 'application/json', write: (b, name) => results(b, name) },
    ],
  }
}
