<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  HbActivity, HbAppShell, HbDrawer, HbEventLog, HbHeader, HbKeyMap, HbPalette, HbPills,
  HbSettingsForm, HbStatusBar, HbSuiteNav, HbTag, HbToaster, HbWorkspaceMenu, useHotkeys,
  type HbPaletteSection, type HbStatusCell, type HbStatusItem, type HbSuiteGroup,
} from '@virgilvox/hackbuild-ui'
import { resetValues, summarize, type ActivityTask } from '@virgilvox/hackbuild-ui/vanilla'
import { GROUPS, toolPath } from './tools/define'
import { TOOLS } from './tools/registry'
import { events, focusComposer, jobs, logEvent, overlay, runPrimary, stopAll, type Overlay } from './shell/shell'
import { SCHEMA, SECTIONS, loadSettings, settings } from './shell/settings'
import WorkspacePanels from './shell/WorkspacePanels.vue'
import { loadModels, models } from './models/lazy'
import {
  busy, deleteProject, duplicateProject, newProject, openProject, opened, pickFiles, project, projects, redo, renaming,
  saveNow, startWorkspace, undo,
} from './workspace/state'

const route = useRoute()
const router = useRouter()
loadSettings()
void startWorkspace()

const toolId = computed(() => (route.meta.tool as string | undefined) ?? '')
const tool = computed(() => TOOLS.find((t) => t.id === toolId.value))
// A lab page draws its own shell, so the suite shell steps aside.
const bare = computed(() => route.meta.bare === true)

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

// The palette: tools, then shell commands.
const COMMANDS: Record<string, { label: string; kbd?: string; run: () => void }> = {
  'cmd:home': { label: 'home: every tool', run: () => router.push('/') },
  'cmd:settings': { label: 'settings', kbd: ',', run: () => open('settings') },
  'cmd:models': { label: 'model manager', kbd: 'm', run: () => open('models') },
  'cmd:log': { label: 'event log', run: () => open('log') },
  'cmd:keys': { label: 'key map', kbd: '?', run: () => open('keys') },
  'cmd:docs': { label: 'documents: open, rename, duplicate, delete', kbd: 'ctrl+o', run: () => open('docs') },
  'cmd:save': { label: 'save now', kbd: 'ctrl+s', run: () => void saveNow() },
  'cmd:import': { label: 'import a file', run: () => pickFiles() },
  'cmd:export': { label: 'export the workspace or a document', kbd: 'ctrl+shift+e', run: () => open('export') },
  'cmd:new': { label: 'new project', run: () => void newProject() },
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

// The one hub and store start after the first paint (design 2.2); the
// manager drawer is its own chunk.
const ModelsPanel = defineAsyncComponent(() => import('./models/ModelsPanel.vue'))
// The speech script kind registers early so a .hbspeech.json import opens in its tool.
setTimeout(() => void Promise.all([import('./speak/kind.ts'), import('./workspace/state')]).then(([m, st]) => { if (!st.kinds.get(m.SPEECH_KIND)) st.registerKind(m.speechKind) }), 0)
// The transcript kind registers early so a recording dropped on any page routes to its tool.
setTimeout(() => void import('./transcribe/register.ts').then((m) => m.registerTranscript()), 0)
// The vision session kind, so an image dropped on any page opens in vision.
setTimeout(() => void import('./vision/frame.ts').then((m) => m.registerVision()), 0)
// The masks kind, so an image dropped on the masks page opens there and elsewhere the chooser offers it.
setTimeout(() => void import('./masks/register.ts').then((m) => m.registerMasks()), 0)
// The relief kind, so a photo dropped elsewhere can open in relief through the chooser.
setTimeout(() => void import('./relief/register.ts').then((m) => m.registerRelief()), 0)
// The image runs kind, so a dropped run sidecar or session opens in generate.
setTimeout(() => void Promise.all([import('./generate/kind.ts'), import('./workspace/state')]).then(([m, st]) => { if (!st.kinds.get(m.GEN_KIND)) st.registerKind(m.genKind()) }), 0)
// The memory kind too, so a dropped memory export opens in the memory tool.
setTimeout(() => void Promise.all([import('./memory/kind.ts'), import('./workspace/state')]).then(([m, st]) => { if (!st.kinds.get(m.MEMORY_KIND)) st.registerKind(m.memoryKind) }), 0)
setTimeout(() => void loadModels().catch((err: unknown) => logEvent('fail', `models: the manager did not start. ${err instanceof Error ? err.message : String(err)}`)), 0)

// Header pills from the hub: what is loaded per organ, and the gpu.
const gpu = 'gpu' in navigator
const pills = computed<HbStatusItem[]>(() => {
  const m = models.value
  const env = m?.env.value
  return [
    ...['brain', 'voice', 'ears', 'eyes', 'memory'].map((key) => ({ key, label: key, goto: 'models', ...(m ? m.organ(key) : { state: 'off' as const, title: 'no model loaded' }) })),
    env
      ? { key: 'gpu', label: 'gpu', state: env.webgpu ? 'ok' as const : 'warn' as const, title: env.webgpu ? `webgpu adapter${env.f16 ? ' with shader-f16' : ''}.` : 'no webgpu adapter. models run on cpu, slower.', goto: 'models' }
      : { key: 'gpu', label: 'gpu', state: gpu ? 'load' as const : 'warn' as const, title: gpu ? 'checking the adapter.' : 'no webgpu here. models run on cpu, slower.', goto: 'models' },
  ]
})

// Status strip figures: job, device, storage, tools.
const tasks = ref<ActivityTask[]>(jobs.list())
const offJobs = jobs.subscribe((t) => (tasks.value = t))
onBeforeUnmount(offJobs)
const job = computed(() => {
  const s = summarize(tasks.value)
  return s.first ? s.first.label : 'idle'
})
const used = computed(() => {
  const u = models.value?.storage.value?.used
  return u === null || u === undefined ? 'unknown' : `${(u / 1048576).toFixed(1)} mb`
})

const cells = computed<HbStatusCell[]>(() => [
  { key: 'job', label: 'job', value: job.value, priority: 1, state: job.value === 'idle' ? 'off' : 'load' },
  { key: 'device', label: 'device', value: models.value?.env.value ? (models.value.env.value.webgpu ? 'webgpu' : 'cpu') : gpu ? 'webgpu' : 'cpu', priority: 1 },
  { key: 'model', label: 'model', value: models.value?.modelLine.value ?? 'none', priority: 2, state: (models.value?.modelLine.value ?? 'none') === 'none' ? 'off' : 'ok' },
  { key: 'stored', label: 'stored', value: used.value, priority: 2 },
  { key: 'tool', label: 'tool', value: tool.value?.title ?? 'home', priority: 3 },
])

logEvent('note', `suite: shell ready. ${TOOLS.length} tools, nothing loaded, nothing fetched.`)
watch(toolId, (id) => { if (id) logEvent('note', `open ${id}`) })

// An opened or imported document goes to the tool that owns it.
watch(opened, (d) => {
  const t = d && TOOLS.find((x) => x.id === d.tool)
  overlay.value = ''
  if (t) router.push({ path: toolPath(t, TOOLS), query: { doc: d!.id } })
})
const menuProjects = computed(() => projects.value.map((p) => ({ id: p.id, name: p.name })))
</script>

<template>
  <RouterView v-if="bare" />
  <HbAppShell v-else>
    <template #header>
      <HbHeader title="suite" accent="." tagline="local only. models run in this tab." tagline-kind="tool">
        <HbWorkspaceMenu
          v-model:level="settings.level as string"
          :name="project?.name ?? 'scratch'"
          :current="project?.id ?? 'scratch'"
          :projects="menuProjects"
          :levels="['guided', 'standard', 'expert']"
          :busy="!!busy"
          @open="openProject"
          @new="newProject"
          @rename="renaming = true"
          @duplicate="duplicateProject"
          @export="open('export')"
          @import="pickFiles"
          @delete="deleteProject"
        >
          <template #reason>{{ busy }}</template>
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
      <HbStatusBar :cells="cells" action="open the event log" @press="open('log')" />
    </template>
  </HbAppShell>

  <HbPalette v-model:open="paletteOpen" :sections="sections" :keys="false" placeholder="tools and commands" @run="runPalette" />
  <HbDrawer v-model="settingsOpen" side="auto" title="settings">
    <HbSettingsForm
      v-model="settings"
      :schema="SCHEMA"
      :sections="SECTIONS"
      :level="settings.level as 'guided'"
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
  <WorkspacePanels />
  <HbToaster />
</template>
