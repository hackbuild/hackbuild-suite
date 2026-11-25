// The json schema toggle (design 3.1, gap rank 15): the reply is asked for
// as json matching a schema the person writes, then read back through
// `repairJSON` and `parseLooseJSON` of @hackbuild/structured and checked
// against the schema's top level: type, required keys and the primitive
// type of each listed property. The verdict rides on the reply as a tool
// call card, kept beside the session so it never goes back to the model.
// Framework free, so the rules are unit tested.
import { parseLooseJSON, repairJSON } from '@hackbuild/structured'
import type { HbToolCallData } from '@virgilvox/hackbuild-ui'

export const SCHEMA_TOOL = 'json schema'
export const DEFAULT_SCHEMA = `{
  "type": "object",
  "properties": { "answer": { "type": "string" }, "confidence": { "type": "number" } },
  "required": ["answer"]
}`

type Schema = { type?: string; properties?: Record<string, { type?: string }>; required?: string[] }

/** The schema text as an object, or the reason it is not one. */
export function parseSchema(text: string): { schema: Record<string, unknown> } | { error: string } {
  let s: unknown
  try { s = JSON.parse(text) } catch (e) { return { error: `the schema is not json: ${e instanceof Error ? e.message : String(e)}` } }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { error: 'the schema is not a json object.' }
  return { schema: s as Record<string, unknown> }
}

export interface Verdict {
  ok: boolean
  /** clean: parsed as written; repaired: parsed after repairJSON; extracted: the largest object inside parsed; none: no json. */
  how: 'clean' | 'repaired' | 'extracted' | 'none'
  missing: string[]
  wrong: string[]
  note: string
}

const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v)
const fits = (want: string, v: unknown) => { const t = typeOf(v); return want === t || (want === 'number' && t === 'integer') }

/** Read the reply as json and check it against the schema's top level. */
export function verdictOf(text: string, schema: Record<string, unknown>): Verdict {
  let value: unknown
  let how: Verdict['how'] = 'none'
  try { value = JSON.parse(text.trim()); how = 'clean' } catch {
    try { value = JSON.parse(repairJSON(text)); how = 'repaired' } catch {
      value = parseLooseJSON(text)
      if (value !== null && value !== undefined) how = 'extracted'
    }
  }
  if (how === 'none') return { ok: false, how, missing: [], wrong: [], note: 'no json in the reply.' }
  const s = schema as Schema
  const word = how === 'clean' ? 'json as written' : how === 'repaired' ? 'json after repair' : 'json cut from the prose'
  if (s.type && !fits(s.type, value)) return { ok: false, how, missing: [], wrong: ['(root)'], note: `${word}, but a ${typeOf(value)}, not a ${s.type}.` }
  const obj = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const missing = (s.required ?? []).filter((k) => !(k in obj))
  const wrong = Object.entries(s.properties ?? {}).filter(([k, p]) => k in obj && p.type && !fits(p.type, obj[k])).map(([k]) => k)
  const ok = !missing.length && !wrong.length
  const parts = [missing.length ? `missing ${missing.join(', ')}` : '', wrong.length ? `wrong type for ${wrong.join(', ')}` : ''].filter(Boolean)
  return { ok, how, missing, wrong, note: ok ? `${word}, matches the schema.` : `${word}, ${parts.join('; ')}.` }
}

/** The verdict as a tool call card: the note as the result, or as the failure. */
export function verdictCard(v: Verdict): HbToolCallData {
  return v.ok
    ? { name: SCHEMA_TOOL, args: { read: v.how }, result: v.note, state: 'ok' }
    : { name: SCHEMA_TOOL, args: { read: v.how }, error: v.note, state: 'error' }
}
