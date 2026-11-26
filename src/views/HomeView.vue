<script setup lang="ts">
// Home (rebuild plan 4): one line on what this is, the yard at full width,
// the explorers as pictures, the examples by job and the parts. The yard is
// a still of the dog simulator until a press plays it here, in a frame.
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { HbTile, HbTiles } from '@virgilvox/hackbuild-ui'
import { toolPath } from '../tools/define'
import { TOOLS } from '../tools/registry'
import { EXPLORERS } from '../shell/explorers'
import { EXAMPLES, JOBS, examplePath } from '../examples/registry'
import yard from '../assets/yard.jpg'

const DOG = 'https://hackbuild.github.io/dog-simulator/'
const playing = ref(false)
const play = () => { playing.value = true }
const router = useRouter()
const openTool = (id: string) => {
  const t = TOOLS.find((x) => x.id === id)
  if (t) router.push(toolPath(t, TOOLS))
}
const explorerTools = new Set(EXPLORERS.map((e) => e.tool))
const parts = TOOLS.filter((t) => !explorerTools.has(t.id))
const jobs = JOBS.map((j) => ({ ...j, examples: EXAMPLES.filter((e) => e.job === j.id) })).filter((j) => j.examples.length)
</script>

<template>
  <main class="sx-home">
    <p class="hb-note sx-home-line">browser ai and 3d characters that run in this tab. nothing is uploaded.</p>
    <section class="sx-yard" data-ux="subject" aria-label="the dog simulator">
      <iframe v-if="playing" class="sx-yard-pic" :src="DOG" title="the dog simulator" allow="autoplay; microphone; camera; fullscreen" />
      <template v-else>
        <button type="button" class="sx-yard-pic" aria-label="play the dog simulator here" @click="play"><img :src="yard" alt="a dog and its person in a low poly yard" width="1440" height="601" /></button>
        <div class="hb-lay-verbs">
          <button type="button" class="hb-btn hb-btn-go" @click="play">play the dog simulator</button>
          <a class="hb-btn" :href="DOG" target="_blank" rel="noopener">open it in a new tab</a>
        </div>
      </template>
    </section>

    <section class="sx-home-sec" aria-labelledby="h-explorers">
      <h2 id="h-explorers" class="hb-panel-hd">explorers</h2>
      <HbTiles>
        <HbTile v-for="e in EXPLORERS" :key="e.id" :name="e.title" :sub="e.line" @click="openTool(e.tool)">
          <template #media><span class="sx-pic" v-html="e.picture" /></template>
        </HbTile>
      </HbTiles>
    </section>

    <section class="sx-home-sec" aria-labelledby="h-examples">
      <h2 id="h-examples" class="hb-panel-hd">examples</h2>
      <div class="sx-jobs">
        <div v-for="j in jobs" :key="j.id" class="sx-job">
          <h3 class="hb-panel-hd">{{ j.title }}</h3>
          <ul class="sx-cards">
            <li v-for="e in j.examples" :key="e.id">
              <RouterLink :to="examplePath(e)" class="hb-link">{{ e.title }}</RouterLink>
              <span class="hb-note">{{ e.line }}</span>
            </li>
          </ul>
        </div>
      </div>
    </section>

    <section class="sx-home-sec" aria-labelledby="h-parts">
      <h2 id="h-parts" class="hb-panel-hd">parts</h2>
      <p class="sx-parts">
        <RouterLink v-for="t in parts" :key="t.id" :to="toolPath(t, TOOLS)" class="hb-link" :title="t.job">{{ t.title }}</RouterLink>
      </p>
    </section>
  </main>
</template>
