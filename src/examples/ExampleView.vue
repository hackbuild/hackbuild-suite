<script setup lang="ts">
// One example: the live result fills the page, and the foot holds the
// source toggle, the install line and the readme. The source is the
// example's own file, read raw at build time.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { HbButton, HbCodeBlock } from '@virgilvox/hackbuild-ui'
import { STUB, exampleFile, findExample, installLine, loadExample, loadSource, npmUrl, readmeUrl, type Example } from './registry'
import { chipPick } from '../shell/chip'
import { logEvent } from '../shell/shell'

const route = useRoute()
const def = computed(() => findExample(String(route.params.job), String(route.params.id)))
const host = ref<HTMLElement | null>(null)
const source = ref(false)
const code = ref('')
const failed = ref('')
let ex: Example | null = null
let run = 0

function stop() {
  ex?.dispose()
  ex = null
  ;(window as unknown as { hbExample: Example | null }).hbExample = null
  chipPick.value = null
}
watch([def, host], async ([d, h]) => {
  const mine = ++run
  stop()
  source.value = false
  code.value = ''
  failed.value = ''
  if (!d || !h) return
  try {
    const mount = await loadExample(d)
    // the gate and the smokes, and only they, open ?stub: stand ins for this machine and the network
    const hooks = STUB ? (await import('./stubs')).stubHooks(d) : {}
    if (mine !== run) return
    ex = mount(h, hooks)
    chipPick.value = ex.pick ?? null
    // the screen gate and the smokes run the example's sample through this
    ;(window as unknown as { hbExample: Example | null }).hbExample = ex
  } catch (err) {
    failed.value = `this example did not start. ${err instanceof Error ? err.message : String(err)}`
    logEvent('fail', `${d.job}/${d.id}: ${failed.value}`)
  }
}, { immediate: true })
onBeforeUnmount(() => { run++; stop() })

async function toggle() {
  source.value = !source.value
  if (source.value && !code.value && def.value) code.value = await loadSource(def.value)
}
const install = computed(() => (def.value ? installLine(def.value) : ''))
</script>

<template>
  <main v-if="def" class="sx-ex" :data-example="`${def.job}/${def.id}`">
    <div v-show="!source" ref="host" class="sx-ex-live" />
    <p v-if="failed" class="hb-callout is-err">{{ failed }}</p>
    <section v-if="source" class="sx-ex-src" :aria-label="`source of ${def.title}`">
      <HbCodeBlock :code="install" lang="sh" label="install" />
      <HbCodeBlock v-if="code" :code="code" lang="ts" :label="exampleFile(def)" />
    </section>
    <footer class="hb-dock sx-ex-foot">
      <HbButton :aria-pressed="source" @click="toggle">{{ source ? 'result' : 'source' }}</HbButton>
      <code class="sx-ex-install" :title="install">npm install <template v-for="p in [...def.packages, '@virgilvox/hackbuild-ui']" :key="p"><a class="hb-link" :href="npmUrl(p)" target="_blank" rel="noopener">{{ p }}</a>{{ ' ' }}</template></code>
      <a class="hb-link" :href="readmeUrl(def)" target="_blank" rel="noopener">readme</a>
    </footer>
  </main>
  <main v-else class="sx-ex-none">
    <p class="hb-note">no example here. press the name in the bar to pick one.</p>
  </main>
</template>
