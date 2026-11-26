import type { Component } from 'vue'
import type { Job } from '@hackbuild/ai-views'

/** One tool in the suite. The view loads through a dynamic import, so a
 * route never pulls another tool's code, runtime or weights (design 2.9). */
export interface ToolDef {
  /** Route id, unique, lowercase. */
  id: string
  /** Group id from GROUPS. */
  group: GroupId
  /** Name shown in the toolbar and the palette. */
  title: string
  /** One line: the job a person does with it. */
  job: string
  /** Build phase the tool lands in (design 6.2); 0 means built. */
  phase: number
  /** The model job its bar chip picks for, when the tool loads a model. */
  model?: Job
  /** Libraries the tool uses, for the needs chips and the fold. */
  packages: string[]
  /** Loads the tool view. */
  load: () => Promise<{ default: Component }>
}

export type GroupId = 'chat' | 'voice' | 'image' | 'character' | 'rooms' | 'motion' | 'agents'

const ALL_GROUPS: { id: GroupId; title: string }[] = [
  { id: 'chat', title: 'chat' },
  { id: 'voice', title: 'voice' },
  { id: 'image', title: 'image' },
  { id: 'character', title: 'character' },
  { id: 'rooms', title: 'rooms' },
  { id: 'motion', title: 'motion' },
  { id: 'agents', title: 'agents' },
]

/** The groups this build carries: one in a group single file (design D11), else all. */
export const GROUPS = __GROUP__ ? ALL_GROUPS.filter((g) => g.id === __GROUP__) : ALL_GROUPS

export function defineTool(def: ToolDef): ToolDef {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`tool id "${def.id}" must be lowercase words joined by dashes`)
  return def
}

/** Route path for a tool. Groups with one tool route to the group itself. */
export function toolPath(t: ToolDef, all: ToolDef[]): string {
  const inGroup = all.filter((x) => x.group === t.group)
  return inGroup.length === 1 ? `/${t.group}` : `/${t.group}/${t.id}`
}
