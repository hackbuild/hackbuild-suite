<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { HbAppShell, HbHeader, HbTabs, HbChip, HbStatusBar } from '@virgilvox/hackbuild-ui'
import { GROUPS, toolPath, type GroupId } from './tools/define'
import { TOOLS } from './tools/registry'

const route = useRoute()
const router = useRouter()

const group = computed<GroupId | ''>(() => (route.meta.group as GroupId | undefined) ?? '')
const toolId = computed(() => (route.meta.tool as string | undefined) ?? '')
const groupTools = computed(() => TOOLS.filter((t) => t.group === group.value))

const tabs = GROUPS.map((g) => ({ label: g.title, value: g.id }))
const tabValue = computed({
  get: () => group.value,
  set: (g) => {
    const first = TOOLS.find((t) => t.group === g)
    if (first) router.push(toolPath(first, TOOLS))
  },
})
const mode = __SINGLE__ ? 'single file' : 'hosted'
</script>

<template>
  <HbAppShell>
    <template #header>
      <HbHeader title="hackbuild" accent="." suffix="suite" tagline="local only. models run in this tab." tagline-kind="tool">
        <RouterLink to="/" class="hb-link hb-on-ink">home</RouterLink>
      </HbHeader>
    </template>
    <template #tabs>
      <HbTabs v-model="tabValue" :tabs="tabs" label="tool groups" id-prefix="suite" />
    </template>
    <template v-if="groupTools.length > 1" #toolbar>
      <nav class="hb-row" aria-label="tools in this group">
        <HbChip
          v-for="t in groupTools"
          :key="t.id"
          :model-value="t.id === toolId"
          @click="router.push(toolPath(t, TOOLS))"
        >{{ t.title }}</HbChip>
      </nav>
    </template>
    <RouterView />
    <template #statusbar>
      <HbStatusBar><b>{{ TOOLS.length }}</b> tools. {{ mode }} build.</HbStatusBar>
    </template>
  </HbAppShell>
</template>
