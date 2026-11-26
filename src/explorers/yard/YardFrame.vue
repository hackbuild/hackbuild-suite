<script setup lang="ts">
// The yard (rebuild plan 4 and 5): a still of the dog and his person until a
// press plays the dog simulator here, in a frame, with the link out under
// it. Home shows it first at full width; the yard explorer fills the page
// with it. Under isolation the frame needs the same headers: on pages the
// two sites share an origin, so the dog site's own coi-sw takes its scope
// before the frame loads (its storage stays its own); anywhere else the
// frame is credentialless.
import { ref } from 'vue'
import yard from './yard.jpg'

defineProps<{ full?: boolean }>()
// a single file is never isolated and never hosted beside the dog site
const sibling = !__SINGLE__ && location.pathname.includes('/hackbuild-suite/')
const DOG = sibling ? new URL('../dog-simulator/', location.href).href : 'https://hackbuild.github.io/dog-simulator/'
const playing = ref(false)
const credentialless = ref(false)

async function isolateDog(): Promise<boolean> {
  if (__SINGLE__) return false
  const sw = navigator.serviceWorker
  const coep = sw?.controller ? new URL(sw.controller.scriptURL).searchParams.get('coep') : null
  if (!sibling || !sw || !coep) return false
  try {
    const reg = await sw.register(`${DOG}coi-sw.js?coep=${coep}`, { scope: DOG })
    const w = reg.installing ?? reg.waiting
    if (w) await new Promise<void>((ok) => { const t = setTimeout(ok, 4000); w.addEventListener('statechange', () => { if (w.state === 'activated') clearTimeout(t), ok() }) })
    return !!reg.active
  } catch {
    return false
  }
}
async function play() {
  if (self.crossOriginIsolated) credentialless.value = !(await isolateDog())
  playing.value = true
}
defineExpose({ play, DOG })
</script>

<template>
  <section class="sx-yard" :class="{ 'is-full': full }" data-ux="subject" aria-label="the dog simulator">
    <iframe v-if="playing" class="sx-yard-pic" :src="DOG" :credentialless="credentialless || undefined" title="the dog simulator" allow="autoplay; microphone; camera; fullscreen; cross-origin-isolated" />
    <template v-else>
      <button type="button" class="sx-yard-pic" aria-label="play the dog simulator here" @click="play"><img :src="yard" alt="a dog and his person in a low poly yard" width="1440" height="601" /></button>
      <div class="hb-lay-verbs">
        <button type="button" class="hb-btn hb-btn-go" @click="play">play the dog simulator</button>
        <a class="hb-btn" :href="DOG" target="_blank" rel="noopener">open the dog simulator</a>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sx-yard { position: relative; height: calc(100svh - 52px - 40px - 170px); min-height: 280px; overflow: hidden; background: var(--hb-paper-sunk); border-bottom: 2px solid var(--hb-ink); }
.sx-yard.is-full { height: calc(100dvh - 52px); border-bottom: 0; }
.sx-yard-pic, .sx-yard-pic img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 55% 60%; border: 0; padding: 0; margin: 0; background: none; cursor: pointer; }
/* a phone shows the dog and his person both: a 6 by 5 frame keeps 721 of the still's 1440 px (computed) */
@media (max-width: 900px) {
  .sx-yard:not(.is-full) { height: auto; aspect-ratio: 6 / 5; }
  .sx-yard-pic img { object-position: 72% 60%; }
}
</style>
