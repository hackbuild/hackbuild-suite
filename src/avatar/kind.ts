// The avatar document kind (design 3.11): what the inspector was set to,
// saved as `.hbavatar.json`. It keeps the scene, gaze, the held expression,
// the chosen clip, blendshapes held by hand and saved poses. The body file
// itself is never saved: it stays in the tab it was dropped on, and the
// placeholder mannequin stands in on reload. Framework free.
import type { DocKind } from '../workspace/kinds.ts'
import { readPose, type PoseFile } from './pose.ts'

export const AVATAR_KIND = 'avatar.session'

export type GazeModeName = 'listen' | 'talk' | 'think'

export interface AvatarBody {
  /** Scene id: plain, studio, or an image light id. */
  scene: string
  gaze: boolean
  mode: GazeModeName
  expression: string | null
  clip: string | null
  morphs: Record<string, number>
  poses: PoseFile[]
}

export const POSES_CAP = 24

export const newAvatarBody = (): AvatarBody => ({ scene: 'studio', gaze: true, mode: 'listen', expression: null, clip: null, morphs: {}, poses: [] })

export function checkAvatar(raw: unknown): string | null {
  const b = raw as Partial<AvatarBody> | null
  if (!b || typeof b !== 'object') return 'the body is not an object.'
  if (typeof b.scene !== 'string') return 'scene is missing.'
  if (typeof b.gaze !== 'boolean') return 'gaze is not on or off.'
  if (!['listen', 'talk', 'think'].includes(String(b.mode))) return `gaze mode ${String(b.mode)} is not listen, talk or think.`
  if (!b.morphs || typeof b.morphs !== 'object') return 'morphs is missing.'
  if (!Array.isArray(b.poses)) return 'poses is not a list.'
  try {
    b.poses.forEach(readPose)
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  return null
}

export const avatarKind: DocKind<AvatarBody> = {
  kind: AVATAR_KIND,
  tool: 'avatar',
  label: 'avatar',
  ext: '.hbavatar.json',
  version: 1,
  create: newAvatarBody,
  check: checkAvatar,
}
