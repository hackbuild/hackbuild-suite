<script setup lang="ts">
// Home: on a first visit the welcome card with the capability panel and a
// list that ticks itself from live state (design 2.4, P-START-2); then the
// tools by group.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { HbCapabilities, HbSectionHead, HbWelcome, type HbWelcomeStart, type HbWelcomeStep } from '@virgilvox/hackbuild-ui'
import { GROUPS, toolPath } from '../tools/define'
import { TOOLS } from '../tools/registry'
import { overlay } from '../shell/shell'
import { loadModels, models } from '../models/lazy'

const router = useRouter()
void loadModels()
const welcome = ref(true)

const caps = computed(() => models.value?.caps.value ?? [])
const machine = computed(() => models.value?.machine.value ?? 'checking this machine.')
const steps = computed<HbWelcomeStep[]>(() => {
  const m = models.value
  const stored = m?.stored.value.length ?? 0
  const loaded = m?.resident.value.length ?? 0
  const kept = m?.storage.value?.persisted === true
  return [
    { name: 'check this machine', text: machine.value, done: !!m?.env.value },
    { name: 'pick a model', text: 'every row names its download size before anything loads.', done: stored > 0, ...(stored ? { count: `${stored} stored` } : { action: 'open the models' }) },
    { name: 'load one', text: 'it stays in memory for every tool that needs it.', done: loaded > 0, ...(loaded ? { count: `${loaded} loaded` } : { action: 'open the models' }) },
    { name: 'keep the weights', text: 'ask the browser not to clear them when space runs low.', done: kept, ...(kept ? { count: 'kept' } : { action: 'keep' }) },
  ]
})
function step(i: number) {
  if (i === 3) void models.value?.persist()
  else overlay.value = 'models'
}
const starts: HbWelcomeStart[] = [
  { id: 'chat', name: 'chat', sub: 'talk to a model in this tab', primary: true },
  { id: 'transcribe', name: 'transcribe', sub: 'recordings to text' },
  { id: 'relief', name: 'relief', sub: 'a photo to a printable relief' },
]
function start(id: string) {
  const t = TOOLS.find((x) => x.id === id)
  if (t) router.push(toolPath(t, TOOLS))
}
</script>

<template>
  <div class="hb-shell">
    <HbWelcome
      v-model:open="welcome"
      title="suite"
      note="browser ai and 3d character tools. models run in this tab and nothing leaves it."
      :steps="steps"
      :starts="starts"
      persist-key="hb-suite.welcome"
      @step="step"
      @start="start"
    >
      <HbCapabilities :caps="caps" @act="(id, verb) => models?.act(id, verb)" />
    </HbWelcome>
    <HbSectionHead title="tools" kicker="hackbuild suite" />
    <section v-for="g in GROUPS" :key="g.id" class="hb-panel">
      <h2 class="hb-panel-hd">{{ g.title }}</h2>
      <ul class="hb-list">
        <li v-for="t in TOOLS.filter((x) => x.group === g.id)" :key="t.id">
          <RouterLink :to="toolPath(t, TOOLS)" class="hb-link">{{ t.title }}</RouterLink>{{ ': ' + t.job + '. ' }}<span v-if="t.phase" class="hb-tag">phase {{ t.phase }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>
