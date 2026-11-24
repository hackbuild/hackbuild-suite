<script setup lang="ts">
import { HbEmptyState } from '@virgilvox/hackbuild-ui'
</script>

<template>
  <HbEmptyState title="no tool at this address">
    the link may be from a newer build. <RouterLink to="/" class="hb-link">open the tool list</RouterLink>.
  </HbEmptyState>
</template>
