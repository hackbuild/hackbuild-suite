// Clip and avatar previews (design 4.4e) from @hackbuild/avatar-host/thumbs:
// one clip at a time on the clay placeholder figure, urgent ones first,
// each tried once a visit. A drawn PNG goes into the workspace blobs store
// by content hash; the kv index `thumbs` maps a preview id to its hash, so
// a later visit shows it with no render. Under ?stub a canvas renderer
// draws the id instead of a figure, so smokes need no GPU. The thumbs
// subpath loads on the first want only.
import { shallowRef } from 'vue'
import type { AnimationClip } from 'three'
import type { BodySource } from '@hackbuild/avatar-host'
import type { ThumbProgress, ThumbQueue, ThumbRenderer } from '@hackbuild/avatar-host/thumbs'
import { kvGet, kvPut } from '../workspace/db'
import { startWorkspace, ws } from '../workspace/state'
import { logEvent } from '../shell/shell'

const STUB = typeof location !== 'undefined' && new URLSearchParams(location.search).has('stub')
const INDEX = 'thumbs'

/** Preview id to an object URL, for the history strip and tile media. */
export const thumbs = shallowRef<Record<string, string>>({})
/** Preview id to why it gave no image this visit. */
export const thumbFails = shallowRef<Record<string, string>>({})
export const thumbProgress = shallowRef<ThumbProgress>({ active: false, done: 0, total: 0 })

export interface ClipJob { id: string; clip(): AnimationClip | Promise<AnimationClip>; hold?: boolean }
export interface AvatarJob { id: string; source: BodySource }

let index: Promise<Record<string, string>> | null = null as Promise<Record<string, string>> | null
const indexOf = () => (index ??= startWorkspace().then(() => kvGet<Record<string, string>>(INDEX)).then((x): Record<string, string> => x ?? {}, (): Record<string, string> => ({})))

function show(id: string, image: Blob): void {
  const old = thumbs.value[id]
  if (old) URL.revokeObjectURL(old)
  thumbs.value = { ...thumbs.value, [id]: URL.createObjectURL(image) }
}

async function save(id: string, image: Blob): Promise<void> {
  const data = new Uint8Array(await image.arrayBuffer())
  const hash = await ws.putBlob(data, { name: `${id.replace(/[^a-z0-9]+/gi, '-')}.png`, type: image.type || 'image/png' })
  const idx = await indexOf()
  idx[id] = hash
  await kvPut(INDEX, idx)
  show(id, image)
}

function failed(id: string, reason: string): void {
  thumbFails.value = { ...thumbFails.value, [id]: reason }
  logEvent('warn', `preview ${id}: ${reason}`)
}

/** The ids with no stored preview; stored ones are shown on the way. */
async function missing<J extends { id: string }>(jobs: readonly J[]): Promise<J[]> {
  const idx = await indexOf()
  const out: J[] = []
  for (const j of jobs) {
    if (thumbs.value[j.id]) continue
    const h = idx[j.id]
    const b = h ? await ws.getBlob(h) : undefined
    if (b) show(j.id, new Blob([b.data as BlobPart], { type: b.type }))
    else out.push(j)
  }
  return out
}

/** Draws the id on a small canvas: the ?stub renderer. */
function stubRenderer<J extends { id: string }>(w: number, h: number): ThumbRenderer<J> {
  return {
    lost: false,
    async draw(job) {
      ;(job as { source?: BodySource }).source?.release?.()
      const c = document.createElement('canvas')
      c.width = w
      c.height = h
      const g = c.getContext('2d')!
      g.fillStyle = '#c9c1b3'
      g.fillRect(0, 0, w, h)
      g.fillStyle = '#1a1a1a'
      g.font = '14px monospace'
      g.fillText(job.id.slice(-18), 8, h / 2)
      return new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
    },
    dispose() {},
  }
}

const common = { save, failed, onProgress: (p: ThumbProgress) => (thumbProgress.value = p) }
let clipQ: Promise<ThumbQueue<ClipJob>> | null = null
let avatarQ: Promise<ThumbQueue<AvatarJob>> | null = null
const lib = () => import('@hackbuild/avatar-host/thumbs')

/** Ask for clip previews; `urgent` puts these first. */
export async function wantClips(jobs: readonly ClipJob[], urgent = false): Promise<void> {
  const todo = await missing(jobs)
  if (!todo.length) return
  clipQ ??= lib().then((m) => (STUB ? new m.ThumbQueue<ClipJob>({ ...common, renderer: async () => stubRenderer(192, 192) }) : m.clipThumbs(common)))
  ;(await clipQ).want(todo, urgent)
}

/** Ask for avatar previews, drawn at rest with their own materials. */
export async function wantAvatars(jobs: readonly AvatarJob[]): Promise<void> {
  const todo = await missing(jobs)
  if (!todo.length) {
    for (const j of jobs) j.source.release?.()
    return
  }
  avatarQ ??= lib().then((m) => (STUB
    ? new m.ThumbQueue<AvatarJob>({ ...common, renderer: async () => stubRenderer(240, 320) })
    : m.avatarThumbs({ ...common, portrait: { vrm: () => import('@hackbuild/avatar/vrm').then((v) => v.vrmHook()) } })))
  ;(await avatarQ).want(todo)
}
