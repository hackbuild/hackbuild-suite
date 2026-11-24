<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { HbEmptyState } from '@virgilvox/hackbuild-ui'
import { TOOLS } from '../tools/registry'

const route = useRoute()
const tool = computed(() => TOOLS.find((t) => t.id === route.meta.tool))
</script>

<template>
  <HbEmptyState v-if="tool" :title="`${tool.title} is not built yet`">
    {{ tool.job }}. it lands in phase {{ tool.phase }} of the build and uses {{ tool.packages.join(', ') }}.
  </HbEmptyState>
</template>
