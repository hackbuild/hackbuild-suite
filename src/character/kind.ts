// The character document kind (design 3.9): one character per document,
// saved as `.hbchar.json`. The body is a Character Card V2 with the
// hackbuild profile at data.extensions.hackbuild, so a card from another
// app opens as a character and a saved one reads elsewhere. The body
// slot is empty by default: the placeholder mannequin stands in, and no
// model file is fetched unless the person drops one. Framework free.
import { fillMacros, profileOf, type CardV2, type Profile } from '@hackbuild/character'
import type { DocKind } from '../workspace/kinds.ts'

export const CHARACTER_KIND = 'character.card'
export const DEFAULT_NAME = 'mannequin'

/** Things to ask, under the greeting (P-START-6). */
export const CHIPS = ['what are you', 'what can you do here', 'remember that my desk is by the window', 'tell me a short story']

export function newProfile(): Profile {
  return {
    version: 1,
    avatar: { uri: '', asset: '', kind: 'glb', expressions: {}, wardrobe: {} },
    voice: { engine: 'pocket-tts', voiceId: '', rate: 1, pitch: 1, cloneRef: '' },
    actions: { moods: [], gestures: [], postures: [], aliases: {} },
    behavior: { gaze: true, blink: true, breath: true, idle: true, ambientGestures: false },
    memory: { enabled: true },
  }
}

export function newCard(name = DEFAULT_NAME): CardV2 {
  return {
    spec: 'chara_card_v2',
    spec_version: '2.0',
    data: {
      name,
      description: '{{char}} is a plain jointed mannequin that lives in a browser tab.',
      personality: 'dry, brief, curious about the person',
      scenario: '{{char}} stands on a small stage in the tab and talks with {{user}}.',
      first_mes: 'hi.\n\ni am {{char}}, a stand in body running in this tab. nothing leaves it.\n\nask me anything.',
      mes_example: '',
      creator_notes: '',
      system_prompt:
        'you are {{char}}. {{char}} is a plain jointed mannequin that lives in a browser tab. talk with {{user}} in short lines, lowercase, at most three short paragraphs separated by blank lines. say what you do not know.',
      post_history_instructions: '',
      alternate_greetings: [],
      tags: [],
      creator: '',
      character_version: '1',
      extensions: { hackbuild: newProfile() },
    },
  }
}

const names = (card: CardV2) => ({ char: card.data.name || DEFAULT_NAME, user: 'you' })
/** The system prompt with the names filled. */
export const systemOf = (card: CardV2) => fillMacros([card.data.system_prompt, card.data.scenario].filter(Boolean).join('\n'), names(card))
/** The first line, with the names filled. */
export const greetingOf = (card: CardV2) => fillMacros(card.data.first_mes, names(card))
/** The profile, or a new one when the card has none. */
export const profileFor = (card: CardV2): Profile => (profileOf(card) as Profile | null) ?? newProfile()

/** A card read from a file: a V2 card as is, a V3 card's data as V2. */
export function cardFrom(raw: unknown): CardV2 {
  const o = raw as { spec?: string; data?: Partial<CardV2['data']> } | null
  if (!o || typeof o !== 'object' || !o.data || typeof o.data.name !== 'string') throw new Error('this file is not a character card: it has no data.name.')
  if (o.spec !== 'chara_card_v2' && o.spec !== 'chara_card_v3') throw new Error(`this file is not a character card: spec is ${String(o.spec ?? 'missing')}.`)
  const base = newCard(o.data.name)
  return { spec: 'chara_card_v2', spec_version: '2.0', data: { ...base.data, ...o.data, extensions: { ...base.data.extensions, ...(o.data.extensions ?? {}) } } }
}

export const characterKind: DocKind<CardV2> = {
  kind: CHARACTER_KIND,
  tool: 'character',
  label: 'character',
  ext: '.hbchar.json',
  version: 1,
  create: () => newCard(),
  check(body) {
    try {
      cardFrom(body)
      return null
    } catch (e) {
      return e instanceof Error ? e.message : String(e)
    }
  },
  imports: [
    {
      accept: '.json,application/json',
      label: 'open as a character',
      async read(file) {
        const card = cardFrom(JSON.parse(await file.text()))
        return { name: card.data.name, body: card }
      },
    },
  ],
}
