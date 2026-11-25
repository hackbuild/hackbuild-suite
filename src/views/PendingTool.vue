<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { HbEmptyState } from '@virgilvox/hackbuild-ui'
import { TOOLS } from '../tools/registry'

const route = useRoute()
const tool = computed(() => TOOLS.find((t) => t.id === route.meta.tool))
// the rooms group file: its one page today is the lab stage
const rooms = __GROUP__ === 'rooms'
</script>

<template>
  <HbEmptyState v-if="tool" :title="`${tool.title} is not built yet`">
    {{ tool.job }}. it lands in phase {{ tool.phase }} of the build and uses {{ tool.packages.join(', ') }}.
    <template v-if="rooms"> this file holds only the <RouterLink to="/lab/phone-stage" class="hb-link">lab stage page</RouterLink> until the room tools land.</template>
  </HbEmptyState>
</template>
