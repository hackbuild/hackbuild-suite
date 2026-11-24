<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  HbAppShell, HbButton, HbChat, HbGauges, HbHeader, HbHudStat, HbKv, HbMemoryPanel,
  HbNameHud, HbPad, HbPanel, HbPill, HbSeg, HbSelect, HbStageCaption, HbStatusBar,
  HbSwitch, HbTabs, HbViewport, usePersisted, type HbAppMode, type HbChatLine, type HudState,
} from '@virgilvox/hackbuild-ui'
import { DRIVES, MEMORY, NAME, ORDERS, RACK_TABS, REPLIES, TALK } from './room'
import type { PhoneStage } from '../stage/walk'

// The phone layout check with the real stage: the layout of the
// hackbuild-ui phone stage plus rack demo (HbAppShell fit, rack sheet,
// docked composer over the keyboard), with an avatar-host stage in the
// studio scene in place of the still picture. Not a tool: the route is
// left out of the nav. Rack tabs and replies are fixtures.
const mode = usePersisted<HbAppMode>('suite-lab-phone-stage-mode', 'split')
const rack = ref(false)
const tab = ref<string | number>('talk')
const lines = ref<HbChatLine[]>([...TALK])
const hud = ref<HudState>('idle')
const move = ref({ x: 0, y: 0 })
const brain = ref('in tab')
const inset = ref('depth')
const captions = ref(true)
const engine = ref('browser speech')
const speak = ref(true)

const host = ref<HTMLElement | null>(null)
const fps = ref<number | string>('--')
const draw = ref('--')
const cover = ref('loading the stage')
const failed = ref(false)
let ps: PhoneStage | null = null
let gone = false

onMounted(async () => {
  try {
    const { createPhoneStage } = await import('../stage/walk')
    if (gone || !host.value) return
    ps = createPhoneStage(host.value, (s) => {
      fps.value = s.fps
      draw.value = `${s.width}x${s.height}`
    })
    // for the smoke: the stage handle on its host element, no global
    ;(host.value as HTMLElement & { phoneStage?: PhoneStage }).phoneStage = ps
    ps.setMove(move.value)
    cover.value = ''
  } catch (err) {
    failed.value = true
    cover.value = `the 3d view did not start. ${err instanceof Error ? err.message : String(err)}`
  }
})
watch(move, (v) => ps?.setMove(v))
onBeforeUnmount(() => {
  gone = true
  ps?.dispose()
  ps = null
  clearTimeout(timer)
})

const lastUser = computed(() => [...lines.value].reverse().find((l) => l.role === 'user'))
const lastReply = computed(() => [...lines.value].reverse().find((l) => l.role === 'assistant'))

let timer: ReturnType<typeof setTimeout> | undefined
function send(text: string) {
  lines.value.push({ role: 'user', text }, { role: 'assistant', text: REPLIES[lines.value.length % REPLIES.length]! })
  hud.value = 'talking'
  clearTimeout(timer)
  timer = setTimeout(() => { hud.value = 'idle' }, 2400)
}
function act() {
  lines.value.push({ role: 'system', text: 'act: waved.' })
}
</script>

<template>
  <HbAppShell v-model:mode="mode" v-model:rail-open="rack" recipe="rack" rail-label="rack" fit>
    <template #header>
      <HbHeader title="phone stage" accent="." tagline="real 3d stage." tagline-kind="tool">
        <p class="hb-fixture is-strip"><b>fixture</b> replies and rack tabs are sample state.</p>
        <a class="hb-link" href="#/">exit</a>
        <HbPill status="ok">stage</HbPill>
      </HbHeader>
    </template>

    <HbViewport aspect="fill" label="the stage" :cover-title="cover || undefined" :cover-error="failed">
      <div ref="host" class="hb-viewport-host" />
      <template #tl><HbNameHud :name="NAME" :state="hud" /></template>
      <template #telemetry>
        <HbHudStat label="fps" :value="fps" :digits="0" />
        <HbHudStat label="draw" :value="draw" />
      </template>
      <template #hint><span>drag to orbit, pinch to zoom, wasd to walk</span></template>
      <template #caption>
        <HbStageCaption :echo="lastUser ? `you: ${lastUser.text}` : ''" :line="lastReply?.text ?? ''" :who="NAME" :max-chars="160" />
      </template>
      <template #pad><HbPad v-model="move" action="act" keys @action="act" /></template>
    </HbViewport>

    <template #rail>
      <HbTabs v-model="tab" :tabs="RACK_TABS" label="rack" persist-key="suite-lab-phone-stage" overflow="collapse">
        <template #default="{ value }">
          <HbPanel v-if="value === 'talk'" heading="talk" sunk>
            <HbChat :lines="lines" :composer="false" :actions="false" label="talk" user-name="you" :assistant-name="NAME" />
            <div class="hb-acts">
              <button v-for="o in ORDERS" :key="o" type="button" class="hb-chip" @click="send(o)">{{ o }}</button>
            </div>
          </HbPanel>
          <HbPanel v-else-if="value === 'mind'" heading="drives" sunk class="hb-instrument">
            <HbKv label="state" value="standing" />
            <HbGauges :rows="DRIVES" :max="1" label="drives" />
          </HbPanel>
          <HbPanel v-else-if="value === 'eyes'" heading="inset" sunk>
            <HbSeg v-model="inset" :options="['off', 'depth', 'labels']" />
            <label class="hb-check"><HbSwitch v-model="captions" label="captions" /> captions</label>
          </HbPanel>
          <HbMemoryPanel v-else-if="value === 'memory'" :items="MEMORY" readonly />
          <HbPanel v-else-if="value === 'body'" heading="body" sunk>
            <HbKv label="model" value="mannequin, made in code" />
            <HbKv label="scene" value="studio, made in code" />
          </HbPanel>
          <HbPanel v-else-if="value === 'brain'" heading="who decides" sunk>
            <HbSeg v-model="brain" :options="['reflex only', 'in tab', 'your endpoint']" />
          </HbPanel>
          <HbPanel v-else heading="voice" sunk>
            <HbSelect v-model="engine" label="engine" :options="['browser speech', 'none']" />
            <label class="hb-check"><HbSwitch v-model="speak" label="speak replies" /> speak replies</label>
          </HbPanel>
        </template>
      </HbTabs>
    </template>

    <template #dock="{ sheet }">
      <HbSeg v-if="!sheet" v-model="mode" :options="['stage', 'split']" />
      <HbChat :lines="lines" :log="false" :placeholder="`talk to ${NAME}`" label="talk to the agent" @send="send">
        <template #composer-start>
          <HbButton v-if="sheet" variant="secondary" :aria-expanded="rack" @click="rack = !rack">rack</HbButton>
        </template>
      </HbChat>
    </template>

    <template #statusbar>
      <HbStatusBar>
        <span>stage <b>{{ cover ? 'off' : 'on' }}</b></span>
        <span>draw <b>{{ draw }}</b></span>
      </HbStatusBar>
    </template>
  </HbAppShell>
</template>
