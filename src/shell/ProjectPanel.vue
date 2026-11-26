<script setup lang="ts">
// The project, from the bar's menu: what was in the header's project menu,
// as one drawer. Documents and export open their own panels.
import { computed } from 'vue'
import { HbButton, HbDrawer, HbToolbar } from '@virgilvox/hackbuild-ui'
import { overlay } from './shell'
import { busy, deleteProject, duplicateProject, newProject, openProject, pickFiles, project, projects, renaming } from '../workspace/state'

const open = computed({ get: () => overlay.value === 'project', set: (v: boolean) => (overlay.value = v ? 'project' : '') })
const others = computed(() => projects.value.filter((p) => p.id !== project.value?.id))
const go = (fn: () => unknown) => { fn() }
</script>

<template>
  <HbDrawer v-model="open" side="auto" :title="`project: ${project?.name ?? 'scratch'}`">
    <p v-if="busy" class="hb-note">{{ busy }}</p>
    <HbToolbar label="this project">
      <HbButton :disabled="!!busy" @click="go(() => (overlay = 'docs'))">documents</HbButton>
      <HbButton :disabled="!!busy" @click="go(pickFiles)">import</HbButton>
      <HbButton :disabled="!!busy" @click="go(() => (overlay = 'export'))">export</HbButton>
      <HbButton :disabled="!!busy" @click="go(() => (renaming = true))">rename</HbButton>
      <HbButton :disabled="!!busy" @click="go(duplicateProject)">duplicate</HbButton>
      <HbButton :disabled="!!busy" @click="go(newProject)">new project</HbButton>
      <HbButton :disabled="!!busy" @click="go(deleteProject)">delete</HbButton>
    </HbToolbar>
    <template v-if="others.length">
      <h2 class="hb-panel-hd-inst">open another</h2>
      <HbToolbar label="other projects">
        <HbButton v-for="p in others" :key="p.id" :disabled="!!busy" @click="openProject(p.id)">{{ p.name }}</HbButton>
      </HbToolbar>
    </template>
  </HbDrawer>
</template>
