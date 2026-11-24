<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HbActivity, HbAppShell, HbDrawer, HbEmptyState, HbEventLog, HbHeader, HbKeyMap, HbPalette, HbPills,
  HbSettingsForm, HbStatusBar, HbSuiteNav, HbTag, HbToaster, HbWorkspaceMenu, useHotkeys,
  type HbPaletteSection, type HbStatusItem, type HbSuiteGroup,
} from '@virgilvox/hackbuild-ui'
import { resetValues, summarize, type ActivityTask } from '@virgilvox/hackbuild-ui/vanilla'
import { GROUPS, toolPath } from './tools/define'
import { TOOLS } from './tools/registry'
import { events, focusComposer, jobs, logEvent, overlay, runPrimary, stopAll, type Overlay } from './shell/shell'
import { SCHEMA, SECTIONS, loadSettings, settings } from './shell/settings'

const route = useRoute()
const router = useRouter()
loadSettings()

const toolId = computed(() => (route.meta.tool as string | undefined) ?? '')
const tool = computed(() => TOOLS.find((t) => t.id === toolId.value))

// Groups and tools for the nav and the tool sheet (design 2.1).
const groups: HbSuiteGroup[] = GROUPS.map((g) => ({
  key: g.id,
  label: g.title,
  tools: TOOLS.filter((t) => t.group === g.id).map((t) => ({ key: t.id, label: t.title, needs: t.packages })),
}))
const navRoute = computed({
  get: () => toolId.value,
  set: (k: string) => {
    const t = TOOLS.find((x) => x.id === k)
    if (t) router.push(toolPath(t, TOOLS))
  },
})

// One overlay at a time; each drawer is a bottom sheet under 761 px.
const wideQuery = matchMedia('(min-width: 761px)')
const wide = ref(wideQuery.matches)
const onWide = () => (wide.value = wideQuery.matches)
wideQuery.addEventListener('change', onWide)
onBeforeUnmount(() => wideQuery.removeEventListener('change', onWide))
const side = computed(() => (wide.value ? 'right' : 'bottom'))
const shown = (o: Overlay) =>
  computed({ get: () => overlay.value === o, set: (v: boolean) => (overlay.value = v ? o : overlay.value === o ? '' : overlay.value) })
const settingsOpen = shown('settings')
const keysOpen = shown('keys')
const logOpen = shown('log')
const modelsOpen = shown('models')
const paletteOpen = shown('palette')
const open = (o: Overlay): void => { overlay.value = o }

// The key map of design 2.7. alt+1 to alt+7, [ and ] come from the nav.
useHotkeys([
  { keys: '/', label: 'palette; in a tool with a composer, focus the composer', group: 'shell', run: () => { if (!focusComposer()) open('palette') } },
  { keys: 'ctrl+k', label: 'palette: tools and commands', group: 'shell', inFields: true, run: () => open('palette') },
  { keys: 'm', label: 'model manager', group: 'shell', run: () => open('models') },
  { keys: ',', label: 'settings', group: 'shell', run: () => open('settings') },
  { keys: '?', label: 'this key map', group: 'shell', run: () => open('keys') },
  { keys: 'ctrl+enter', label: "run the tool's primary action", group: 'tool', inFields: true, run: () => runPrimary() },
  { keys: 'esc', label: 'close the top overlay; with none open, stop audio and generation', group: 'shell', run: () => {
    if (overlay.value) { overlay.value = ''; return }
    return stopAll() > 0
  } },
])

// The palette: tools, then shell commands (documents and models join in 2.5 and 2.6).
const COMMANDS: Record<string, { label: string; kbd?: string; run: () => void }> = {
  'cmd:home': { label: 'home: every tool', run: () => router.push('/') },
  'cmd:settings': { label: 'settings', kbd: ',', run: () => open('settings') },
  'cmd:models': { label: 'model manager', kbd: 'm', run: () => open('models') },
  'cmd:log': { label: 'event log', run: () => open('log') },
  'cmd:keys': { label: 'key map', kbd: '?', run: () => open('keys') },
}
const sections: HbPaletteSection[] = [
  { label: 'tools', items: TOOLS.map((t) => ({ key: t.id, label: t.title, hint: t.group, words: t.job })) },
  { label: 'commands', items: Object.entries(COMMANDS).map(([key, c]) => ({ key, label: c.label, kbd: c.kbd })) },
]
function runPalette(key: string) {
  overlay.value = ''
  const cmd = COMMANDS[key]
  if (cmd) cmd.run()
  else navRoute.value = key
}

// Header pills: nothing is loaded in the shell. The manager (2.6) feeds them.
const gpu = 'gpu' in navigator
const pills: HbStatusItem[] = [
  ...['brain', 'voice', 'ears', 'eyes', 'memory'].map((key) => ({ key, label: key, state: 'off' as const, title: 'no model loaded', goto: 'models' })),
  { key: 'gpu', label: 'gpu', state: gpu ? 'ok' : 'warn', title: gpu ? 'webgpu api present. no adapter asked for yet.' : 'no webgpu here. models run on cpu, slower.', goto: 'models' },
]

// Status strip figures: job, device, storage, tools.
const tasks = ref<ActivityTask[]>(jobs.list())
const offJobs = jobs.subscribe((t) => (tasks.value = t))
onBeforeUnmount(offJobs)
const job = computed(() => {
  const s = summarize(tasks.value)
  return s.first ? s.first.label : 'idle'
})
const used = ref('unknown')
navigator.storage?.estimate?.().then(
  (e) => (used.value = e.usage === undefined ? 'unknown' : `${(e.usage / 1e6).toFixed(1)} mb`),
  () => undefined,
)

logEvent('note', `suite: shell ready. ${TOOLS.length} tools, nothing loaded, nothing fetched.`)
watch(toolId, (id) => { if (id) logEvent('note', `open ${id}`) })
</script>

<template>
  <HbAppShell>
    <template #header>
      <HbHeader title="suite" accent="." tagline="local only. models run in this tab." tagline-kind="tool">
        <HbWorkspaceMenu
          v-model:level="settings.level as string"
          name="scratch"
          current="scratch"
          :projects="[{ id: 'scratch', name: 'scratch' }]"
          :levels="['guided', 'standard', 'expert']"
          busy
        >
          <template #reason>one workspace for now. projects, export and import come next.</template>
        </HbWorkspaceMenu>
        <HbPills :items="pills" label="what is loaded" @goto="open('models')" />
        <HbActivity :source="jobs" />
        <HbTag>local only</HbTag>
      </HbHeader>
    </template>
    <template #tabs>
      <HbSuiteNav v-model:route="navRoute" :groups="groups" keys />
    </template>
    <RouterView />
    <template #statusbar>
      <HbStatusBar role="button" tabindex="0" aria-label="open the event log" @click="open('log')" @keydown.enter="open('log')">
        <span>job <b>{{ job }}</b></span>
        <span>device <b>{{ gpu ? 'webgpu' : 'cpu' }}</b></span>
        <span>model <b>none</b></span>
        <span>stored <b>{{ used }}</b></span>
        <span>tool <b>{{ tool?.title ?? 'home' }}</b></span>
      </HbStatusBar>
    </template>
  </HbAppShell>

  <HbPalette v-model:open="paletteOpen" :sections="sections" :keys="false" placeholder="tools and commands" @run="runPalette" />
  <HbDrawer v-model="settingsOpen" :side="side" title="settings">
    <HbSettingsForm
      v-model="settings"
      :schema="SCHEMA"
      :sections="SECTIONS"
      :level="settings.level as 'guided'"
      @reset="(s) => (settings = resetValues(settings, SCHEMA, s))"
    />
  </HbDrawer>
  <HbDrawer v-model="keysOpen" :side="side" title="keys">
    <HbKeyMap />
  </HbDrawer>
  <HbDrawer v-model="logOpen" :side="side" title="event log">
    <HbEventLog :rows="events" label="this project" filters />
  </HbDrawer>
  <HbDrawer v-model="modelsOpen" :side="side" title="models">
    <HbEmptyState title="no models yet">
      the model manager lands in phase 2. nothing downloads until you press a load button that names the size.
    </HbEmptyState>
  </HbDrawer>
  <HbToaster />
</template>
