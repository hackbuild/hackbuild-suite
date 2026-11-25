// Body files: what a stage takes from a drop or a pick. Twin mode, the room
// and the shared stage toolbar read the same list. A body stays in this tab.
// A pmx or pmd goes through the mmd loader of @hackbuild/avatar, imported on
// the first such drop only; it is flagged local, since most mmd models forbid
// sharing, and is never stored outside the person's own workspace.
import type { AvatarStage } from '@hackbuild/avatar-host/three'

/** A dropped or picked file: a File, or the host's DroppedFile with its path. */
export type BodyFile = Blob & { name: string; path?: string }

export const BODY_ACCEPT = '.glb,.vrm,.pmx,.pmd'

const ext = (name: string) => name.toLowerCase().replace(/^.*\./, '')
/** A pmx or pmd, by its name. */
export const isMmdFile = (f: { name: string }): boolean => ext(f.name) === 'pmx' || ext(f.name) === 'pmd'
/** A glb, vrm, pmx or pmd, by its name. */
export const isBodyFile = (f: { name: string }): boolean => ext(f.name) === 'glb' || ext(f.name) === 'vrm' || isMmdFile(f)

/** What a stage shows of an mmd body once it is on. */
export interface MmdShown { name: string; local: true; warnings: string[]; physics: { colliders: number; joints: number } }

/**
 * Shows a dropped pmx or pmd on the stage. The other files of the drop are
 * its textures. Throws with the copy the caption shows when the bytes are
 * not a pmx or pmd, or the parser fails.
 */
export async function showMmd(stage: AvatarStage, files: readonly BodyFile[]): Promise<MmdShown> {
  const f = files.find(isMmdFile)
  if (!f) throw new Error('no pmx or pmd in this drop.')
  const [{ loadMmd, mmdFormat }, { managerForFiles }, { load }] = await Promise.all([import('@hackbuild/avatar/mmd'), import('@hackbuild/avatar/three'), import('@hackbuild/avatar')])
  const head = new Uint8Array(await f.slice(0, 4).arrayBuffer())
  if (!mmdFormat(head)) throw new Error(`${f.name} is named ${ext(f.name)} but is not one: the first bytes do not match.`)
  await load()
  const rest = new Map<string, Blob>(files.filter((x) => x !== f).map((x) => [x.path || x.name, x]))
  const avatar = await loadMmd(f, { name: f.name, ...(rest.size ? { files: managerForFiles(rest, f.name) } : {}) })
  stage.showAvatar(avatar, f.name)
  return { name: f.name, local: true, warnings: avatar.warnings, physics: avatar.physics }
}

/** Any body drop: a pmx or pmd through `showMmd`, the rest through the stage's own loader. */
export async function showBodyFiles(stage: AvatarStage, files: readonly BodyFile[], failed: (message: string) => void): Promise<void> {
  if (!files.some(isMmdFile)) {
    await stage.show(files)
    return
  }
  try {
    await showMmd(stage, files)
  } catch (e) {
    failed((e instanceof Error ? e.message : String(e)).replace(/^avatar: /, ''))
  }
}
