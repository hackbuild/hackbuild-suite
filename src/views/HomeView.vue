<script setup lang="ts">
// Home (rebuild plan 4): the yard first at full width, the explorers as
// pictures, the examples by job, the parts, and one line about privacy.
// The yard is a still of the dog simulator for now; the press opens it.
import { useRouter } from 'vue-router'
import { HbTile, HbTiles } from '@virgilvox/hackbuild-ui'
import { toolPath } from '../tools/define'
import { TOOLS } from '../tools/registry'
import { EXPLORERS } from '../shell/explorers'
import { EXAMPLES, JOBS, examplePath } from '../examples/registry'
import yard from '../assets/yard.jpg'

const DOG = 'https://hackbuild.github.io/dog-simulator/'
const openDog = () => window.location.assign(DOG)
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
    <section class="sx-yard" data-ux="subject" aria-label="the dog simulator">
      <a :href="DOG" class="sx-yard-pic" tabindex="-1" aria-hidden="true"><img :src="yard" alt="" width="1440" height="672" /></a>
      <div class="hb-lay-verbs">
        <button type="button" class="hb-btn hb-btn-go" @click="openDog">open the dog simulator</button>
      </div>
    </section>
    <p class="hb-note sx-home-line">everything runs in this tab. nothing is uploaded.</p>

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
