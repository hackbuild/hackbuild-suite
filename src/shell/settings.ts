// Shared settings (design 2.3): one schema, rendered by HbSettingsForm,
// kept in the workspace database. Each tool adds its own section in the
// item that builds it.
import { computed, ref, watch } from 'vue'
import { defaultsOf, type SettingDef, type SettingValues } from '@virgilvox/hackbuild-ui/vanilla'
import type { HbSettingsSection } from '@virgilvox/hackbuild-ui'
import { kvGet, kvPut } from '../workspace/db'
import { bindIsolationSwitch } from './isolation'

const single = typeof __SINGLE__ !== 'undefined' && __SINGLE__

export const SECTIONS: HbSettingsSection[] = [
  { key: 'suite', label: 'suite', note: 'how the shell looks and behaves.' },
  { key: 'brain', label: 'brain', note: 'how the chat model writes.' },
  { key: 'voice', label: 'voice', note: 'how replies are spoken.' },
  { key: 'memory', label: 'memory', note: 'what the character recalls.' },
]

export const SCHEMA: SettingDef[] = [
  { section: 'suite', key: 'view', type: 'seg', label: 'default view', why: 'where a tool with a stage and a chat opens.', default: 'split', options: ['stage', 'split', 'chat'] },
  { section: 'suite', key: 'reducedMotion', type: 'switch', label: 'reduce motion', why: 'stages stop idle motion and draw on change only. on by itself when the system asks for it.', default: false },
  ...(single ? [] : [{ section: 'suite', key: 'isolation', type: 'switch', label: 'wasm threads', why: 'a service worker adds the cross origin isolation headers this host leaves out, so wasm runs on several threads. it never caches weights. changing it reloads the page once.', default: true } satisfies SettingDef]),
  { section: 'suite', key: 'keyHints', type: 'switch', label: 'key hints', why: 'prints the key beside buttons that have one.', default: true },
  { section: 'brain', key: 'temperature', type: 'range', label: 'temperature', why: 'higher picks less likely words. above 1 drifts.', default: 0.7, min: 0, max: 2, step: 0.05, applies: 'next reply', level: 'standard' },
  { section: 'brain', key: 'topP', type: 'range', label: 'top p', why: 'keeps only the likeliest words that add up to this share.', default: 0.9, min: 0.05, max: 1, step: 0.05, applies: 'next reply', level: 'standard' },
  { section: 'brain', key: 'context', type: 'select', label: 'context size', why: 'tokens the model reads at once. more costs memory on the gpu.', default: 4096, options: [{ label: '2k', value: 2048 }, { label: '4k', value: 4096 }, { label: '8k', value: 8192 }], applies: 'next load', level: 'expert' },
  { section: 'brain', key: 'think', type: 'seg', label: 'thinking', why: 'how reasoning text shows for models that write it.', default: 'fold', options: ['show', 'fold', 'hide'] },
  { section: 'voice', key: 'rate', type: 'range', label: 'rate', why: 'speaking speed.', default: 1, min: 0.5, max: 2, step: 0.05, unit: 'x' },
  { section: 'voice', key: 'pitch', type: 'range', label: 'pitch', why: 'voice pitch, for system voices.', default: 1, min: 0.5, max: 2, step: 0.05, level: 'standard' },
  { section: 'voice', key: 'kokoro', type: 'switch', label: 'kokoro voice', why: 'opt in. kokoro-js phonemizes with espeak ng, gpl-3.0-or-later, fetched at run time and never bundled. off, kokoro never loads.', default: false, level: 'standard' },
  { section: 'memory', key: 'recall', type: 'range', label: 'recall count', why: 'memories added to each reply. more costs context.', default: 4, min: 0, max: 12, step: 1, applies: 'next reply' },
  { section: 'memory', key: 'compact', type: 'switch', label: 'compaction', why: 'folds old memories into summaries when the budget is full.', default: true, level: 'standard' },
]

const KEY = 'settings'

export const settings = ref<SettingValues>(defaultsOf(SCHEMA))

let loaded = false
/** Read saved values over the defaults, then save every change. */
export async function loadSettings(): Promise<void> {
  if (loaded) return
  loaded = true
  try {
    const saved = await kvGet<SettingValues>(KEY)
    if (saved) settings.value = { ...settings.value, ...saved }
  } catch {
    /* storage blocked: the defaults hold for this visit */
  }
  watch(settings, (v) => kvPut(KEY, { ...v }).catch(() => undefined), { deep: true })
  bindIsolationSwitch(computed(() => settings.value.isolation))
}
