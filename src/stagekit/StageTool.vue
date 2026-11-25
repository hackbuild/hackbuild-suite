<script setup lang="ts">
// The shared stage toolbar and stage of the motion and agents tools
// (design 3.11, 3.12): seed with restart, a body by pick or drop, tune;
// the stage with camera chips, telemetry, key hints, the caption and the
// pad (a tool may hide it), the stage menu that sends sentences when the
// tool has one, the tool's own camera chips in place of the views; a tool's own band of verbs and inset in the stage and its own strip under it; the transport; the rack in the side column; the tune
// drawer generated from the tool's tunables registry. State comes from
// useStageTool.
import { computed, reactive } from 'vue'
import {
  HbButton, HbChip, HbContextMenu, HbDrawer, HbHudStat, HbPad, HbPanel, HbParamRow, HbSeed, HbStageCaption, HbToolbar,
  HbTransport, HbViewport, type HbContextItem, type HbContextRequest,
} from '@virgilvox/hackbuild-ui'
import { VIEWS } from '../stage/walk'
import { BODY_ACCEPT } from './body'
import type { StageTool } from './useStageTool'

const props = defineProps<{ tool: StageTool; title: string }>()
const t = props.tool

const groups = computed(() => t.reg.groups().map((g) => ({ group: g.group, defs: g.keys.map((k) => t.reg.def(k)) })))
const helpOf = (d: ReturnType<typeof t.reg.def>) =>
  [d.note, `default ${d.def}${d.unit ? ` ${d.unit}` : ''}, ${d.source ?? 'unknown'}${d.cite ? ` (${d.cite})` : ''}.`].filter(Boolean).join(' ')

// the stage menu: the tool fills it for the point, before it opens
const menu = reactive({ open: false, title: '', items: [] as HbContextItem[] })
function onRequest(req: HbContextRequest) {
  const m = t.menu?.(req.at) ?? null
  menu.title = m?.title ?? ''
  menu.items = m?.items ?? []
}
const onPick = (_: HbContextItem, say: string) => t.say?.(say)

function picked(e: Event) {
  const input = e.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  input.value = ''
  if (files.length) void t.showBody(files)
}
</script>

<template>
  <div class="hb-toolpage is-split is-stage">
    <HbToolbar>
      <HbSeed v-model="t.seed.value" v-model:locked="t.locked.value" />
      <HbButton variant="secondary" aria-keyshortcuts="r" @click="t.restart()">restart</HbButton>
      <HbButton as="label" variant="secondary">
        body
        <input type="file" :accept="BODY_ACCEPT" hidden @change="picked">
      </HbButton>
      <span class="hb-spacer" />
      <HbButton variant="secondary" aria-keyshortcuts="t" :aria-expanded="t.tune.value" @click="t.tune.value = true">tune</HbButton>
    </HbToolbar>

    <HbViewport look="lit" aspect="16/9" :label="`${title} stage`" :cover-title="t.cover.value || undefined" :cover-error="t.failed.value">
      <HbContextMenu
        v-if="t.menu"
        v-model:open="menu.open"
        class="hb-viewport-media"
        :title="menu.title"
        :items="menu.items"
        label="right click or long press a thing for things to say"
        @request="onRequest"
        @pick="onPick"
      >
        <div :ref="(el) => (t.host.value = el as HTMLElement | null)" class="hb-viewport-host" />
      </HbContextMenu>
      <div v-else :ref="(el) => (t.host.value = el as HTMLElement | null)" class="hb-viewport-host" />
      <template #tr>
        <slot v-if="$slots.cams" name="cams" />
        <div v-else class="hb-cams" role="group" aria-label="camera">
          <HbChip
            v-for="(v, i) in VIEWS"
            :key="v"
            :model-value="t.view.value === v"
            toggle
            :hotkey="String(i + 1)"
            :hotkey-label="`view from the ${v}`"
            hotkey-group="stage"
            @click="t.view.value = v"
          >{{ v }}</HbChip>
        </div>
      </template>
      <template #telemetry>
        <HbHudStat label="fps" :value="t.stats.fps" :digits="0" />
        <HbHudStat label="seed" :value="t.seed.value" :digits="0" />
        <HbHudStat label="t" :value="t.transport.time" :digits="2" unit="s" />
      </template>
      <template #hint>
        <span class="hb-hudnote">{{ t.hints.map((h) => `${h.keys} ${h.label}`).join(', ') }}</span>
      </template>
      <template #caption>
        <HbStageCaption :line="t.body.line" :who="t.body.name" :max-chars="160" />
      </template>
      <template v-if="t.pad" #pad><HbPad v-model="t.move.value" keys /></template>
      <template v-if="$slots.band" #b><slot name="band" /></template>
      <template v-if="$slots.inset" #bl><slot name="inset" /></template>
    </HbViewport>

    <slot name="under" />

    <HbTransport
      v-model:loop="t.transport.loop"
      :playing="t.transport.playing"
      :time="t.transport.time"
      :duration="t.transport.duration"
      :rate="t.transport.rate"
      :label="`${title} transport`"
      @play="t.play()"
      @pause="t.pause()"
      @step="t.step"
      @seek="t.seek"
      @rate="(r) => (t.transport.rate = r)"
    />

    <div class="is-side">
      <slot name="rack" />
    </div>
  </div>

  <HbDrawer v-model="t.tune.value" side="auto" :title="`tune ${title}`">
    <HbPanel v-for="g in groups" :key="g.group" :heading="g.group" sunk class="hb-instrument">
      <HbParamRow
        v-for="d in g.defs"
        :key="d.key"
        :model-value="t.values[d.key] ?? d.def"
        :label="d.label"
        :min="d.min"
        :max="d.max"
        :step="d.step"
        :unit="d.unit ?? ''"
        :default-value="d.def"
        :help="helpOf(d)"
        @update:model-value="(v) => t.reg.set(d.key, Number(v))"
      />
    </HbPanel>
    <HbButton variant="secondary" @click="t.reg.reset()">reset all</HbButton>
  </HbDrawer>
</template>
