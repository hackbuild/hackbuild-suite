<script setup lang="ts">
// The workspace surfaces the shell mounts once: the documents drawer
// (ctrl+o), the export panel (ctrl+shift+e), the project rename box, the
// promise dialog, the "which tool" choice, the file picker and the window
// drop ring (design 2.5, 2.6).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import {
  HbActions, HbButton, HbConversationList, HbDrawer, HbDropzone, HbEmptyState, HbExportPanel, HbField, HbInput, HbModal, HbToolbar,
  type HbExportFormat, type HbExportRequest,
} from '@virgilvox/hackbuild-ui'
import type { ConfirmRequest } from '@virgilvox/hackbuild-ui/vanilla'
import { overlay, type Overlay } from './shell'
import { TOOLS } from '../tools/registry'
import {
  busy, choice, deleteDoc, dialog, docs, dropRoutes, duplicateDoc, exportDoc, exportWorkspace, importFiles, kindOf,
  localNames, opened, picker, project, renameDoc, renameProject, renaming, selected,
} from '../workspace/state'
import { FALLBACK_EXT, WORKSPACE_EXT } from '../workspace/kinds'

const shown = (o: Overlay) =>
  computed({ get: () => overlay.value === o, set: (v: boolean) => (overlay.value = v ? o : overlay.value === o ? '' : overlay.value) })
const docsOpen = shown('docs')
const exportOpen = shown('export')

const toolTitle = (id: string) => TOOLS.find((t) => t.id === id)?.title ?? id
const sel = computed(() => docs.value.find((d) => d.id === selected.value) ?? null)
watch(docs, (list) => {
  if (selected.value && !list.some((d) => d.id === selected.value)) selected.value = null
})

const items = computed(() => docs.value.map((d) => ({ id: d.id, title: d.name, kind: toolTitle(d.tool), updated: d.updated })))

function openDoc() {
  if (sel.value) opened.value = sel.value
}

// Export panel: the workspace zip, and the picked document in its own
// extension and in its kind's native formats.
const local = shallowRef<string[]>([])
watch(exportOpen, async (on) => { if (on) local.value = await localNames() })
const format = ref('workspace')
const formats = computed<HbExportFormat[]>(() => {
  const out: HbExportFormat[] = [{ key: 'workspace', label: 'workspace', ext: WORKSPACE_EXT, note: `every document in ${project.value?.name ?? 'this project'}, with its files. weights are never in it.` }]
  const d = sel.value
  if (d) {
    const k = kindOf(d)
    out.push({ key: 'doc', label: k?.label ?? 'document', ext: k?.ext ?? FALLBACK_EXT, note: `${d.name} alone, with the files it uses.` })
    for (const n of k?.exports ?? []) out.push({ key: `native:${n.key}`, label: n.label, ext: n.ext, note: n.note, copy: n.copy })
  }
  return out
})
watch(formats, (f) => { if (!f.some((x) => x.key === format.value)) format.value = 'workspace' })
const exportName = computed(() => (format.value === 'workspace' ? project.value?.name ?? 'workspace' : sel.value?.name ?? 'document').toLowerCase().replace(/[^a-z0-9]+/g, '-'))
const readout = computed(() => [
  { label: 'documents', value: docs.value.length },
  { label: 'project', value: project.value?.name ?? 'none' },
])
const checks = [{ tone: 'ok' as const, text: 'weights are never in a workspace. each tool fetches its own on load.' }]
function runExport(r: HbExportRequest) {
  if (r.format === 'workspace') void exportWorkspace({ filename: r.filename, includeLocal: r.includeLocal })
  else if (sel.value) void exportDoc(sel.value.id, { filename: r.filename, includeLocal: r.includeLocal, format: r.format.replace(/^native:/, '') })
}

// Project rename box, opened by the workspace menu.
const projName = ref('')
watch(renaming, (on) => { if (on) projName.value = project.value?.name ?? '' })
async function saveProject() {
  await renameProject(projName.value)
  renaming.value = false
}

// The promise dialog.
const ask = shallowRef<ConfirmRequest | null>(dialog.current)
const offAsk = dialog.subscribe((c) => (ask.value = c))
onBeforeUnmount(offAsk)
const askOpen = computed({ get: () => !!ask.value, set: (v: boolean) => { if (!v && ask.value) dialog.answer(false) } })
const choiceOpen = computed({ get: () => !!choice.value, set: (v: boolean) => { if (!v) choice.value?.answer(null) } })

// The file picker behind ctrl+o import and the menu's import.
const input = ref<HTMLInputElement | null>(null)
onMounted(() => (picker.value = () => input.value?.click()))
onBeforeUnmount(() => (picker.value = null))
function picked() {
  const list = [...(input.value?.files ?? [])]
  if (input.value) input.value.value = ''
  if (list.length) void importFiles(list)
}
</script>

<template>
  <HbDrawer v-model="docsOpen" side="auto" title="documents">
    <HbEmptyState v-if="!docs.length" title="no documents yet">
      tools save here as you work. drop a {{ WORKSPACE_EXT }} or a document file anywhere to bring one in.
    </HbEmptyState>
    <HbConversationList
      v-else
      noun="document"
      :items="items"
      :current="selected"
      :duplicable="false"
      :exportable="false"
      :importable="false"
      :creatable="false"
      note=""
      @open="(id) => (selected = id)"
      @rename="(id, title) => renameDoc(id, title)"
      @remove="(id) => deleteDoc(id)"
    />
    <HbActions v-if="sel" :label="`actions for ${sel.name}`">
      <HbButton size="sm" :disabled="!kindOf(sel)" :title="kindOf(sel) ? '' : 'no tool in this build opens it yet'" @click="openDoc">open</HbButton>
      <HbButton variant="secondary" size="sm" @click="duplicateDoc(sel.id)">duplicate</HbButton>
      <HbButton variant="secondary" size="sm" @click="overlay = 'export'">export</HbButton>
    </HbActions>
    <HbToolbar>
      <HbButton variant="secondary" size="sm" :disabled="!!busy" @click="picker?.()">import</HbButton>
      <HbButton variant="secondary" size="sm" @click="overlay = 'export'">export workspace</HbButton>
      <span class="hb-spacer hb-readout">ctrl+s saves now. changes save as you go.</span>
    </HbToolbar>
  </HbDrawer>

  <HbDrawer v-model="exportOpen" side="auto" title="export">
    <HbExportPanel
      v-model:format="format"
      :formats="formats"
      :name="exportName"
      :local-only="local"
      :readout="readout"
      :checks="checks"
      :busy="busy"
      label="export"
      @export="runExport"
    />
  </HbDrawer>

  <HbModal v-model="renaming" title="rename project" size="sm">
    <form id="ws-proj-form" @submit.prevent="saveProject">
      <HbField label="project name" for="ws-proj-name">
        <HbInput id="ws-proj-name" v-model="projName" />
      </HbField>
    </form>
    <template #footer>
      <HbButton variant="ghost" @click="renaming = false">cancel</HbButton>
      <HbButton type="submit" form="ws-proj-form">save</HbButton>
    </template>
  </HbModal>

  <HbModal v-model="askOpen" :title="ask?.title" size="sm">
    <p>{{ ask?.message }}</p>
    <template #footer>
      <HbButton variant="ghost" @click="dialog.answer(false)">{{ ask?.cancelLabel ?? 'cancel' }}</HbButton>
      <HbButton :variant="ask?.danger ? 'danger' : 'primary'" @click="dialog.answer(true)">{{ ask?.confirmLabel ?? 'confirm' }}</HbButton>
    </template>
  </HbModal>

  <HbModal v-model="choiceOpen" :title="`which tool opens ${choice?.file ?? 'this file'}`" size="sm">
    <p>two tools read this file. pick one.</p>
    <template #footer>
      <HbButton v-for="o in choice?.options ?? []" :key="o.key" variant="secondary" @click="choice?.answer(o.key)">{{ o.label }}</HbButton>
    </template>
  </HbModal>

  <input ref="input" type="file" hidden multiple aria-hidden="true" tabindex="-1" @change="picked" />
  <HbDropzone cover window :routes="dropRoutes" :disabled="!!busy" hint="drop to import: a .hbsuite.zip, a document file, or a file a tool reads" />
</template>
