// The explorers: one full tool per family of originals (rebuild plan 4).
// Until an explorer is rebuilt its tile opens the tool page the suite has
// today. Each picture is a line drawing in the kit's ink and pink.
import { TOOLS } from '../tools/registry'

export interface Explorer {
  id: string
  title: string
  line: string
  /** The tool id in src/tools/registry.ts it opens until its explorer lands. */
  tool: string
  /** The explorer's own route, once it is rebuilt (rebuild plan 4). */
  route?: string
  picture: string
  /** False for the yard: its block leads home already, so no tile repeats it. */
  tile?: boolean
}

const svg = (body: string) =>
  `<svg viewBox="0 0 160 120" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#1a1a1a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="0" y="0" width="160" height="120" fill="#efe9db" stroke="none"/>${body}</svg>`
const PINK = '#fe0386'

const ALL: Explorer[] = [
  { id: 'yard', title: 'yard', line: 'the dog simulator, in this tab', tool: '', route: '/x/yard', tile: false, picture: svg(`<path d="M20 96h120"/><circle cx="62" cy="70" r="10" fill="#fffdf7"/><path d="M96 96V60M90 60h12" stroke="${PINK}"/>`) },
  { id: 'chat', title: 'chat', line: 'talk to a model in this tab', tool: 'chat', route: '/x/chat', picture: svg(`<rect x="22" y="22" width="82" height="34" fill="#fffdf7"/><path d="M34 34h56M34 44h40"/><rect x="58" y="64" width="80" height="34" fill="${PINK}" stroke="${PINK}"/><path d="M70 76h56M70 86h32" stroke="#fffdf7"/>`) },
  { id: 'character', title: 'character', line: 'a body that talks, looks and listens', tool: 'character', route: '/x/character', picture: svg(`<circle cx="80" cy="44" r="18" fill="#fffdf7"/><path d="M50 104c2-22 14-34 30-34s28 12 30 34"/><path d="M73 50q7 6 14 0" stroke="${PINK}"/><circle cx="73" cy="40" r="1.5" fill="#1a1a1a"/><circle cx="87" cy="40" r="1.5" fill="#1a1a1a"/>`) },
  { id: 'room', title: 'room', line: 'an agent living in a room, and its mind', tool: 'room', route: '/x/room', picture: svg(`<path d="M20 30l40 14v60l-40-14zM60 44h80v60H60M140 44l0-14H20"/><circle cx="96" cy="64" r="6"/><path d="M96 70v18M88 104l8-16 8 16M86 78h20"/><path d="M122 92h12v12h-12z" fill="${PINK}" stroke="${PINK}"/>`) },
  { id: 'transcribe', title: 'transcribe', line: 'recordings to text you can edit', tool: 'transcribe', route: '/x/transcribe', picture: svg(`<path d="M20 40v8M28 32v24M36 38v12M44 26v36M52 36v16M60 30v28M68 40v8" stroke="${PINK}"/><path d="M84 30h56M84 44h44M20 76h120M20 88h96M20 100h108"/>`) },
  { id: 'masks', title: 'mask studio', line: 'cut things out, by hand or by model', tool: 'masks', route: '/x/masks', picture: svg(`<rect x="22" y="70" width="116" height="34" fill="#d9d0bd" stroke="none"/><rect x="56" y="38" width="40" height="44" fill="#c3251f" stroke="none"/><rect x="50" y="32" width="52" height="56" stroke="${PINK}" stroke-dasharray="6 5"/><circle cx="120" cy="80" r="14" fill="#2f5fa7" stroke="none"/>`) },
  { id: 'find', title: 'find', line: 'what is in a picture or a camera', tool: 'vision', picture: svg(`<rect x="18" y="18" width="124" height="84" fill="#fffdf7"/><rect x="34" y="40" width="40" height="46" stroke="${PINK}"/><rect x="92" y="52" width="34" height="34" stroke="${PINK}"/><path d="M34 34h20M92 46h16" stroke="${PINK}"/>`) },
  { id: 'make-an-image', title: 'make an image', line: 'a prompt becomes a picture', tool: 'generate', picture: svg(`<rect x="18" y="18" width="124" height="84" fill="#fffdf7"/><circle cx="112" cy="40" r="10" fill="${PINK}" stroke="${PINK}"/><path d="M18 92l38-36 26 24 18-14 42 34"/>`) },
  { id: 'relief', title: 'relief', line: 'a photo to a relief you can print', tool: 'relief', route: '/x/relief', picture: svg(`<path d="M20 90l40-22 80 0-40 22z" fill="#fffdf7"/><path d="M20 90v12h80l40-22v-12M100 90v12"/><path d="M46 80q14-22 28-6t28-8" stroke="${PINK}"/>`) },
]

/** Where an explorer's tile goes: its own route once rebuilt, else its tool. */
export const explorerPath = (e: Explorer): string | null => (e.route && !__GROUP__ ? e.route : null)

/** The explorers whose tool this build carries (a group single file has a few).
 * The yard has no tool: it is the dog site in a frame, on every build with routes. */
export const EXPLORERS = ALL.filter((e) => (e.id === 'yard' ? !__GROUP__ : TOOLS.some((t) => t.id === e.tool)))
