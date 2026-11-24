import type { Component } from 'vue'

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
  /** Libraries the tool uses, for the needs chips and the fold. */
  packages: string[]
  /** Loads the tool view. */
  load: () => Promise<{ default: Component }>
}

export type GroupId = 'chat' | 'voice' | 'image' | 'character' | 'rooms' | 'motion' | 'agents'

export const GROUPS: { id: GroupId; title: string }[] = [
  { id: 'chat', title: 'chat' },
  { id: 'voice', title: 'voice' },
  { id: 'image', title: 'image' },
  { id: 'character', title: 'character' },
  { id: 'rooms', title: 'rooms' },
  { id: 'motion', title: 'motion' },
  { id: 'agents', title: 'agents' },
]

export function defineTool(def: ToolDef): ToolDef {
  if (!/^[a-z][a-z0-9-]*$/.test(def.id)) throw new Error(`tool id "${def.id}" must be lowercase words joined by dashes`)
  return def
}

/** Route path for a tool. Groups with one tool route to the group itself. */
export function toolPath(t: ToolDef, all: ToolDef[]): string {
  const inGroup = all.filter((x) => x.group === t.group)
  return inGroup.length === 1 ? `/${t.group}` : `/${t.group}/${t.id}`
}
