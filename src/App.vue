<script setup lang="ts">
// The shell (rebuild plan 2.1): one light 52 px bar and the page under it.
// The tool name opens the switcher: explorers, then the examples by job,
// then the parts, the single package benches. The menu holds the project,
// settings, keys and the log.
import { computed, defineAsyncComponent, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HbAppShell, HbDrawer, HbEventLog, HbKeyMap, HbPalette, HbSettingsForm, HbToaster, useHotkeys,
  type HbPaletteSection,
} from '@virgilvox/hackbuild-ui'
import { resetValues } from '@virgilvox/hackbuild-ui/vanilla'
import type { ModelPick } from '@hackbuild/ai-views'
import { toolPath } from './tools/define'
import { TOOLS } from './tools/registry'
import { EXPLORERS } from './shell/explorers'
import { EXAMPLES, JOBS, examplePath, findExample } from './examples/registry'
import { dock, events, focusComposer, logEvent, overlay, runPrimary, stopAll, type Overlay } from './shell/shell'
import { SCHEMA, SECTIONS, loadSettings, settings } from './shell/settings'
import { chipPick, toolPick } from './shell/chip'
import SuiteBar from './shell/SuiteBar.vue'
import ProjectPanel from './shell/ProjectPanel.vue'
import WorkspacePanels from './shell/WorkspacePanels.vue'
import { loadModels } from './models/lazy'
import { opened, pickFiles, redo, saveNow, startWorkspace, undo } from './workspace/state'

const route = useRoute()
const router = useRouter()
loadSettings()
void startWorkspace()

const toolId = computed(() => (route.meta.tool as string | undefined) ?? '')
const tool = computed(() => TOOLS.find((t) => t.id === toolId.value))
const example = computed(() => (route.name === 'example' ? findExample(String(route.params.job), String(route.params.id)) : undefined))
// a lab page draws its own shell; home and the examples draw edge to edge under the bar
const bare = computed(() => route.meta.bare === true)
const full = computed(() => route.meta.full === true)
const name = computed(() => tool.value?.title ?? (example.value ? example.value.id.replace(/-/g, ' ') : route.name === 'home' ? 'suite' : 'not found'))

// the chip: an example hands its own pick over; a tool gets one for its job
const toolChip = shallowRef<ModelPick | null>(null)
watch(() => tool.value?.model, (job) => {
  toolChip.value = null
  if (job) void toolPick(job).then((p) => { if (tool.value?.model === job) toolChip.value = p })
}, { immediate: true })
watch(() => route.name, () => { if (route.name !== 'example') chipPick.value = null })
const pick = computed(() => (route.name === 'example' ? chipPick.value : toolChip.value))

const shown = (o: Overlay) =>
  computed({ get: () => overlay.value === o, set: (v: boolean) => (overlay.value = v ? o : overlay.value === o ? '' : overlay.value) })
const settingsOpen = shown('settings')
const keysOpen = shown('keys')
const logOpen = shown('log')
const modelsOpen = shown('models')
const paletteOpen = shown('palette')
const open = (o: Overlay): void => { overlay.value = o }

useHotkeys([
  { keys: '/', label: 'switch tool; in a tool with a composer, focus the composer', group: 'shell', run: () => { if (!focusComposer()) open('palette') } },
  { keys: 'ctrl+k', label: 'switch tool, or run a command', group: 'shell', inFields: true, run: () => open('palette') },
  { keys: 'm', label: 'model manager', group: 'shell', run: () => open('models') },
  { keys: ',', label: 'settings', group: 'shell', run: () => open('settings') },
  { keys: '?', label: 'this key map', group: 'shell', run: () => open('keys') },
  { keys: 'ctrl+s', label: 'save now (autosave is on)', group: 'workspace', inFields: true, run: () => void saveNow() },
  { keys: 'ctrl+o', label: 'open or import: the documents of this project', group: 'workspace', inFields: true, run: () => open('docs') },
  { keys: 'ctrl+shift+e', label: 'export panel', group: 'workspace', inFields: true, run: () => open('export') },
  { keys: 'ctrl+z', label: 'undo in the open document', group: 'workspace', run: () => undo() },
  { keys: 'ctrl+shift+z', label: 'redo in the open document', group: 'workspace', run: () => redo() },
  { keys: 'ctrl+enter', label: "run the tool's primary action", group: 'tool', inFields: true, run: () => runPrimary() },
  { keys: 'esc', label: 'close the top overlay; with none open, stop audio and generation', group: 'shell', run: () => {
    if (overlay.value) { overlay.value = ''; return }
    return stopAll() > 0
  } },
])

// the switcher: explorers, the examples by job, the parts, then commands
const COMMANDS: Record<string, { label: string; kbd?: string; run: () => void }> = {
  'cmd:home': { label: 'home', run: () => router.push('/') },
  'cmd:project': { label: 'project', run: () => open('project') },
  'cmd:settings': { label: 'settings', kbd: ',', run: () => open('settings') },
  'cmd:models': { label: 'model manager', kbd: 'm', run: () => open('models') },
  'cmd:log': { label: 'event log', run: () => open('log') },
  'cmd:keys': { label: 'key map', kbd: '?', run: () => open('keys') },
  'cmd:docs': { label: 'documents: open, rename, duplicate, delete', kbd: 'ctrl+o', run: () => open('docs') },
  'cmd:save': { label: 'save now', kbd: 'ctrl+s', run: () => void saveNow() },
  'cmd:import': { label: 'import a file', run: () => pickFiles() },
  'cmd:export': { label: 'export the workspace or a document', kbd: 'ctrl+shift+e', run: () => open('export') },
}
const explorerTools = new Set(EXPLORERS.map((e) => e.tool))
const sections: HbPaletteSection[] = [
  { label: 'explorers', items: EXPLORERS.map((e) => ({ key: `tool:${e.tool}`, label: e.title, hint: e.line, words: e.id })) },
  ...JOBS.map((j) => ({ label: j.title, items: EXAMPLES.filter((e) => e.job === j.id).map((e) => ({ key: `example:${e.job}/${e.id}`, label: e.title, hint: e.line })) })).filter((s) => s.items.length),
  { label: 'parts', items: TOOLS.filter((t) => !explorerTools.has(t.id)).map((t) => ({ key: `tool:${t.id}`, label: t.title, hint: t.job })) },
  { label: 'commands', items: Object.entries(COMMANDS).map(([key, c]) => ({ key, label: c.label, kbd: c.kbd })) },
]
function runPalette(key: string) {
  overlay.value = ''
  if (key.startsWith('tool:')) {
    const t = TOOLS.find((x) => x.id === key.slice(5))
    if (t) router.push(toolPath(t, TOOLS))
  } else if (key.startsWith('example:')) {
    const [job, id] = key.slice(8).split('/')
    router.push(examplePath({ job: job!, id: id! }))
  } else COMMANDS[key]?.run()
}
function menu(v: string) {
  open(v as Overlay)
}

// The model manager drawer is its own chunk.
const ModelsPanel = defineAsyncComponent(() => import('./models/ModelsPanel.vue'))
// Document kinds register early, so a file dropped on any page routes to its tool.
setTimeout(() => void Promise.all([import('./speak/kind.ts'), import('./workspace/state')]).then(([m, st]) => { if (!st.kinds.get(m.SPEECH_KIND)) st.registerKind(m.speechKind) }), 0)
setTimeout(() => void import('./transcribe/register.ts').then((m) => m.registerTranscript()), 0)
setTimeout(() => void import('./vision/frame.ts').then((m) => m.registerVision()), 0)
setTimeout(() => void import('./masks/register.ts').then((m) => m.registerMasks()), 0)
setTimeout(() => void import('./relief/register.ts').then((m) => m.registerRelief()), 0)
setTimeout(() => void Promise.all([import('./generate/kind.ts'), import('./workspace/state')]).then(([m, st]) => { if (!st.kinds.get(m.GEN_KIND)) st.registerKind(m.genKind()) }), 0)
setTimeout(() => void Promise.all([import('./memory/kind.ts'), import('./workspace/state')]).then(([m, st]) => { if (!st.kinds.get(m.MEMORY_KIND)) st.registerKind(m.memoryKind) }), 0)
setTimeout(() => void loadModels().catch((err: unknown) => logEvent('fail', `models: the manager did not start. ${err instanceof Error ? err.message : String(err)}`)), 0)

logEvent('note', `suite: shell ready. ${EXPLORERS.length} explorers, ${EXAMPLES.length} examples, nothing loaded, nothing fetched.`)
watch(() => route.fullPath, (p) => { if (route.name !== 'home') logEvent('note', `open ${p}`) })

// An opened or imported document goes to the tool that owns it.
watch(opened, (d) => {
  const t = d && TOOLS.find((x) => x.id === d.tool)
  overlay.value = ''
  if (t) router.push({ path: toolPath(t, TOOLS), query: { doc: d!.id } })
})
watch(name, (n) => { document.title = n === 'suite' ? 'hackbuild suite' : `${n}. hackbuild suite` }, { immediate: true })
</script>

<template>
  <RouterView v-if="bare" />
  <div v-else-if="full" class="hb sx-full">
    <SuiteBar :name="name" :pick="pick" @switcher="open('palette')" @menu="menu" />
    <RouterView />
  </div>
  <HbAppShell v-else>
    <template #header>
      <SuiteBar :name="name" :pick="pick" @switcher="open('palette')" @menu="menu" />
    </template>
    <RouterView />
    <template v-if="dock > 0" #dock />
  </HbAppShell>

  <HbPalette v-model:open="paletteOpen" :sections="sections" :keys="false" label="switch tool" placeholder="a tool, an example or a command" @run="runPalette" />
  <HbDrawer v-model="settingsOpen" side="auto" title="settings">
    <HbSettingsForm
      v-model="settings"
      :schema="SCHEMA"
      :sections="SECTIONS"
      level="expert"
      @reset="(s) => (settings = resetValues(settings, SCHEMA, s))"
    />
  </HbDrawer>
  <HbDrawer v-model="keysOpen" side="auto" title="keys">
    <HbKeyMap />
  </HbDrawer>
  <HbDrawer v-model="logOpen" side="auto" title="event log">
    <HbEventLog :rows="events" label="this project" filters />
  </HbDrawer>
  <HbDrawer v-model="modelsOpen" side="auto" size="md" title="models">
    <ModelsPanel />
  </HbDrawer>
  <ProjectPanel />
  <WorkspacePanels />
  <HbToaster />
</template>
