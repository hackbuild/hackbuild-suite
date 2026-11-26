<script setup lang="ts">
// The yard (rebuild plan 4 and 5): a still of the dog and his person until a
// press mounts the dog simulator here, live, as @hackbuild/agents-views Yard
// over the dog site's plain files, with the link out under the still. Home
// shows it first at full width; the yard explorer fills the page with it and
// plays at once. The still stands in on ?stub (for gates) and offline, and
// again with the reason when the yard does not load.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type { YardHandle } from '@hackbuild/agents-views/yard'
import { DOG } from '../../shell/dog'
import yard from './yard.jpg'

const props = defineProps<{ full?: boolean }>()
const host = ref<HTMLElement | null>(null)
const playing = ref(false)
const fault = ref('')
const stub = new URLSearchParams(location.search).has('stub')
let handle: YardHandle | null = null
let gone = false

async function play() {
  if (playing.value) return
  if (!navigator.onLine) { fault.value = 'you are offline. the yard loads its dog from the dog site.'; return }
  fault.value = ''
  playing.value = true
  try {
    const { playYard } = await import('./live')
    // the explorer opens the setup panel on a first visit (not on ?stub, for gates); home's press
    // is the choice to just play
    const h = await playYard(host.value as HTMLElement, !!props.full && !stub)
    if (gone) { h.dispose(); return }
    handle = h
    await h.ready
  } catch (e) {
    handle?.dispose()
    handle = null
    playing.value = false
    console.warn('yard', e)
    if (!gone) fault.value = 'the yard did not load from the dog site. open the dog simulator instead.'
  }
}
// the yard explorer plays at once; home keeps the still and the press
onMounted(() => { if (props.full && !stub) void play() })
onBeforeUnmount(() => { gone = true; handle?.dispose(); handle = null })
defineExpose({ play, DOG })
</script>

<template>
  <section class="sx-yard" :class="{ 'is-full': full, 'is-live': playing }" :data-ux="playing ? undefined : 'subject'" aria-label="the dog simulator">
    <div v-show="playing" ref="host" class="sx-yard-live" />
    <template v-if="!playing">
      <button type="button" class="sx-yard-pic" aria-label="play the dog simulator here" @click="play"><img :src="yard" alt="a dog and his person in a low poly yard" width="1440" height="601" /></button>
      <div class="hb-lay-verbs">
        <button type="button" class="hb-btn hb-btn-go" @click="play">play here</button>
        <a class="hb-btn" :href="DOG" target="_blank" rel="noopener">open in its own tab</a>
      </div>
      <p v-if="fault" class="hb-note sx-yard-fault" role="status">{{ fault }}</p>
    </template>
  </section>
</template>

<style scoped>
.sx-yard { position: relative; height: calc(100svh - 52px - 44px - 250px); min-height: 280px; overflow: hidden; background: var(--hb-paper-sunk); border-bottom: 2px solid var(--hb-ink); }
.sx-yard.is-full { height: calc(100dvh - 52px); border-bottom: 0; }
.sx-yard.is-live:not(.is-full) { height: calc(100svh - 52px - 40px); }
.sx-yard-live { height: 100%; }
.sx-yard-pic, .sx-yard-pic img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 55% 60%; border: 0; padding: 0; margin: 0; background: none; cursor: pointer; }
.sx-yard-fault { position: absolute; left: 12px; top: 12px; max-width: min(480px, calc(100% - 24px)); margin: 0; padding: 6px 10px; background: var(--hb-paper); border: 1.5px solid var(--hb-ink); color: var(--hb-err); }
/* a phone shows the dog and his person both: a 6 by 5 frame keeps 721 of the still's 1440 px (computed) */
@media (max-width: 900px) {
  .sx-yard:not(.is-full) { height: auto; aspect-ratio: 6 / 5; }
  /* the explorer's still too: at full height a cover crop keeps 296 of the 1440 px at 390 wide,
     the person alone; the dog and his person span 675 px, so 6 by 5 is the tallest frame that
     holds both (computed) */
  .sx-yard.is-full:not(.is-live) { height: auto; aspect-ratio: 6 / 5; }
  .sx-yard-pic img { object-position: 72% 60%; }
  /* live, the yard stacks its rack under the stage and the page scrolls as one */
  .sx-yard.is-live { height: auto; aspect-ratio: auto; overflow: visible; }
}
</style>
