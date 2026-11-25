// The character's stage (design 3.9 steps 3 and 4): the AvatarStage of
// @hackbuild/avatar-host in the studio scene, the same stage the phone
// stage lab page runs, with the placeholder mannequin as the default
// body. The body's own presence drives gaze, blink and breath; its
// lip sync is fed the speaker's output level each frame, so the mouth
// follows the one analyser every voice plays through. The view imports
// this module at wake, so three.js and the motion packages stay out of
// the first load.
import { AvatarStage, type Body } from '@hackbuild/avatar-host/three'
import { droppedFiles } from '@hackbuild/avatar-host'
import { showBodyFiles } from '../stagekit/body.ts'

export interface BodyInfo {
  name: string
  placeholder: boolean
  mouth: boolean
  warnings: string[]
}

export interface CharacterStage {
  readonly stage: AvatarStage
  /** Jaw openness of the last frame, 0 to 1, as the lip sync drove it. */
  mouth(): number
  /** Speaking: keep the loop drawing while the mouth moves. */
  setSpeaking(on: boolean): void
  dispose(): void
}

export interface StageHooks {
  /** The speaker's output level, 0 to 1. */
  level(): number
  onBody(info: BodyInfo): void
  onBodyFailed(message: string): void
}

export function createCharacterStage(host: HTMLElement, hooks: StageHooks): CharacterStage {
  const stage = new AvatarStage(host, { environment: 'studio' })
  let mouth = 0
  let speaking = false
  let hooked: Body | null = null

  // the lip frame of each update, read back so a check can see the mouth move
  const hook = (body: Body) => {
    if (hooked === body) return
    hooked = body
    const update = body.lip.update.bind(body.lip)
    body.lip.update = (t, dt) => {
      const f = update(t, dt)
      mouth = f.open
      return f
    }
  }
  stage.on('loaded', (e) => {
    hook(e.body)
    hooks.onBody({ name: e.name, placeholder: e.placeholder, mouth: e.caps.mouth, warnings: e.warnings })
  })
  stage.on('failed', (e) => hooks.onBodyFailed(e.message))
  hook(stage.showPlaceholder())
  hooks.onBody({ name: 'mannequin', placeholder: true, mouth: stage.body?.caps.mouth ?? false, warnings: [] })

  // the level goes in before the body updates on the next frame
  stage.scene.onBeforeRender = () => {
    stage.body?.lip.setLevel(speaking ? hooks.level() : 0)
    if (speaking) stage.loop.invalidate()
  }

  // a dropped glb, vrm, fbx, pmx or pmd becomes the body; it stays in this tab
  const over = (e: DragEvent) => e.preventDefault()
  const drop = async (e: DragEvent) => {
    e.preventDefault()
    if (!e.dataTransfer) return
    const files = await droppedFiles(e.dataTransfer)
    if (files.length) void showBodyFiles(stage, files, hooks.onBodyFailed)
  }
  host.addEventListener('dragover', over)
  host.addEventListener('drop', drop)

  return {
    stage,
    mouth: () => mouth,
    setSpeaking(on) {
      speaking = on
      stage.loop.invalidate()
    },
    dispose() {
      host.removeEventListener('dragover', over)
      host.removeEventListener('drop', drop)
      stage.dispose()
    },
  }
}
