<script setup lang="ts">
// Home: hackle's own shape. The yard is the stage; the rack beside it says
// what this is and offers three first things to do, the dog first and pink.
// Under the fold: the tools as blocks with an ink head (the dog's rack
// blocks), the small examples by job, and a footer for developers.
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { toolPath } from '../tools/define'
import { TOOLS } from '../tools/registry'
import { EXPLORERS, explorerPath, type Explorer } from '../shell/explorers'
import { EXAMPLES, JOBS, examplePath } from '../examples/registry'
import YardFrame from '../explorers/yard/YardFrame.vue'
import { DOG } from '../shell/dog'

const router = useRouter()
const yard = ref<InstanceType<typeof YardFrame> | null>(null)
const live = ref(false)
const openExplorer = (e: Explorer) => {
  const p = explorerPath(e)
  if (p) router.push(p)
  else {
    const t = TOOLS.find((x) => x.id === e.tool)
    if (t) router.push(toolPath(t, TOOLS))
  }
}
const byId = (id: string) => EXPLORERS.find((e) => e.id === id)
const tiles = EXPLORERS.filter((e) => e.tile !== false)
const explorerTools = new Set(EXPLORERS.map((e) => e.tool))
const parts = TOOLS.filter((t) => !explorerTools.has(t.id))
const jobs = JOBS.map((j) => ({ ...j, examples: EXAMPLES.filter((e) => e.job === j.id) })).filter((j) => j.examples.length)
const LIBS = [
  { name: 'hackbuild-ui', line: 'the look: classes and parts', href: 'https://hackbuild.github.io/hackbuild-ui/' },
  { name: 'browser ai', line: 'chat, speech, vision, memory', href: 'https://hackbuild.github.io/hackbuild-browser-ai/' },
  { name: 'motion', line: 'bodies, clips, gaze, lips', href: 'https://hackbuild.github.io/hackbuild-motion/' },
  { name: 'agents', line: 'drives, senses, cameras', href: 'https://hackbuild.github.io/hackbuild-agents/' },
]
</script>

<template>
  <main class="sx-home">
    <section class="sx-hero" :class="{ 'is-live': live }">
      <YardFrame ref="yard" bare @live="live = $event" />
      <aside v-if="!live" class="sx-hero-rack" aria-label="start here">
        <section class="sx-block">
          <h2 class="sx-block-hd">what this is</h2>
          <p>small ai models that run inside this browser tab. nothing you open leaves your machine.</p>
          <p class="hb-note">a model downloads once when you ask for it, then stays cached.</p>
        </section>
        <section class="sx-block">
          <h2 class="sx-block-hd">start here</h2>
          <button type="button" class="hb-btn hb-btn-go sx-start" @click="yard?.play()">play with the dog</button>
          <button v-if="byId('character')" type="button" class="hb-btn sx-start" @click="openExplorer(byId('character')!)">talk to his twin</button>
          <button v-if="byId('masks')" type="button" class="hb-btn sx-start" @click="openExplorer(byId('masks')!)">cut a thing out of a photo</button>
          <a class="sx-out" :href="DOG" target="_blank" rel="noopener">the dog simulator in its own tab</a>
        </section>
      </aside>
    </section>

    <div class="sx-wrap">
      <section aria-labelledby="h-tools">
        <h2 id="h-tools" class="sx-sec-hd">tools</h2>
        <div class="sx-cards">
          <button v-for="e in tiles" :key="e.id" type="button" class="sx-card" @click="openExplorer(e)">
            <span class="sx-block-hd">{{ e.title }}</span>
            <span class="sx-card-line">{{ e.line }}</span>
            <span class="sx-card-go" aria-hidden="true">open</span>
          </button>
        </div>
      </section>

      <section aria-labelledby="h-examples">
        <h2 id="h-examples" class="sx-sec-hd">small examples, each with its code</h2>
        <div class="sx-jobs">
          <section v-for="j in jobs" :key="j.id" class="sx-block">
            <h3 class="sx-block-hd">{{ j.title }}</h3>
            <ul class="sx-exlist">
              <li v-for="e in j.examples" :key="e.id">
                <RouterLink :to="examplePath(e)">{{ e.title }}</RouterLink>
                <span class="hb-note">{{ e.line }}</span>
              </li>
            </ul>
          </section>
        </div>
      </section>

      <footer class="sx-foot">
        <h2 class="sx-sec-hd">for developers</h2>
        <div class="sx-libs">
          <a v-for="l in LIBS" :key="l.name" :href="l.href" target="_blank" rel="noopener" class="sx-lib"><b>{{ l.name }}</b><span class="hb-note">{{ l.line }}</span></a>
        </div>
        <details class="sx-parts">
          <summary>single library benches</summary>
          <p><RouterLink v-for="t in parts" :key="t.id" :to="toolPath(t, TOOLS)">{{ t.title }}</RouterLink></p>
        </details>
      </footer>
    </div>
  </main>
</template>
