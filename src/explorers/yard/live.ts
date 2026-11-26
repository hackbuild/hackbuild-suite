// The yard, live: @hackbuild/agents-views Yard over the dog site's plain files
// (under assets/: the dog, his person, their clip pack and his voice clip, the owner's own, served
// with access-control-allow-origin on pages) and its physics core
// (assets/rapier.mjs, Apache-2.0), with the same core from jsdelivr when the
// site's copy does not load. Imported lazily on a press or on the yard route, so
// three.js's WebGPU build and the yard stay out of the first load.
import { mountYard, type YardHandle } from '@hackbuild/agents-views/yard'
import { DOG_SITE } from '../../shell/dog'

const RAPIER_CDN = 'https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.21.0/dist/rapier.mjs'
const load = (url: string): Promise<unknown> => import(/* @vite-ignore */ url)

/** Mounts the yard in host; the setup panel opens on a first visit only when setup is true. */
export function playYard(host: HTMLElement, setup: boolean): Promise<YardHandle> {
  // whole paths, so the likeness check sees the three owner files only as the dog site's plain files
  const at = (path: string) => new URL(`../${path}`, DOG_SITE).href
  return mountYard(host, {
    physics: () => load(at('dog-simulator/assets/rapier.mjs')).catch(() => load(RAPIER_CDN)),
    dog: at('dog-simulator/assets/dog.glb'),
    human: at('dog-simulator/assets/human.glb'),
    anims: at('dog-simulator/assets/anims.json'),
    voice: at('dog-simulator/assets/voice.wav'),
    // the chips, setup and commands go into the suite bar, as hackle's header held them
    bar: document.querySelector<HTMLElement>('.sx-bar-yard'),
    // the suite keeps its own hash: no lockstep switches, no reseed
    params: '',
    setup,
  })
}
