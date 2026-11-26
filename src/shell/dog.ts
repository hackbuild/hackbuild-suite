// The dog simulator site, and the owner's human body it serves as a plain
// file (dog-simulator pages, with access-control-allow-origin on every
// file, so a cross origin isolated page fetches it in cors mode).
export const DOG = 'https://hackbuild.github.io/dog-simulator/'
export const HUMAN_GLB = `${DOG}assets/human.glb`
/**
 * The dog site the yard loads from: beside the suite on pages (one origin), the
 * public site anywhere else. A single file is never hosted beside it.
 */
export const DOG_SITE = !__SINGLE__ && location.pathname.includes('/hackbuild-suite/') ? new URL('../dog-simulator/', location.href).href : DOG
/** His mocap clips, baked onto the human glb's rig (idle, talking idle, walks, sitting). */
export const HUMAN_CLIPS = `${DOG}assets/anims.json`
/** His voice reference, for the cloned voice. */
// written whole: the likeness check allows the voice only by its full path on the dog site
export const HUMAN_VOICE = "https://hackbuild.github.io/dog-simulator/assets/voice.wav"

/**
 * Clones his voice from the dog site's reference onto a speaker whose
 * engine clones (pocket). True when it took; false offline or when the
 * engine cannot clone, and the speaker keeps its own voice.
 */
export async function cloneOwnVoice(sp: { cloneFile(f: File): Promise<unknown>; readonly cloned: boolean }): Promise<boolean> {
  if (sp.cloned) return true
  try {
    const r = await fetch(HUMAN_VOICE)
    if (!r.ok) return false
    await sp.cloneFile(new File([await r.blob()], 'reference.wav', { type: 'audio/wav' }))
    return true
  } catch {
    return false
  }
}
