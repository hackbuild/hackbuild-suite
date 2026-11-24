import { defineTool, type ToolDef } from './define'

// Every tool starts as the pending view and swaps its load() for its own
// view in the item that builds it (BUILD-STATUS.md).
const pending = () => import('../views/PendingTool.vue')

export const TOOLS: ToolDef[] = [
  defineTool({ id: 'chat', group: 'chat', title: 'chat', job: 'talk to a model running in this tab', phase: 2, packages: ['models', 'weights', 'chat', 'converse'], load: () => import('../chat/ChatView.vue') }),
  defineTool({ id: 'memory', group: 'chat', title: 'memory', job: 'see, edit and forget what a character remembers', phase: 2, packages: ['memory', 'models'], load: () => import('../memory/MemoryView.vue') }),
  defineTool({ id: 'transcribe', group: 'voice', title: 'transcribe', job: 'turn recordings into text you can edit and export', phase: 2, packages: ['transcribe', 'audio-dsp', 'media'], load: () => import('../transcribe/TranscribeView.vue') }),
  defineTool({ id: 'speak', group: 'voice', title: 'speak', job: 'read text aloud and save the audio', phase: 3, packages: ['speak', 'models'], load: () => import('../speak/SpeakView.vue') }),
  defineTool({ id: 'vision', group: 'image', title: 'vision', job: 'point a camera or an image at the models and read what they see', phase: 3, packages: ['vision', 'models'], load: () => import('../vision/VisionView.vue') }),
  defineTool({ id: 'masks', group: 'image', title: 'masks', job: 'cut objects out of an image by pointing at them', phase: 3, packages: ['vision', 'models'], load: () => import('../masks/MasksView.vue') }),
  defineTool({ id: 'relief', group: 'image', title: 'relief', job: 'turn a photo into a printable relief', phase: 3, packages: ['vision', 'depth-mesh'], load: () => import('../relief/ReliefView.vue') }),
  defineTool({ id: 'generate', group: 'image', title: 'generate', job: 'make images from a prompt', phase: 3, packages: ['imagegen', 'models'], load: () => import('../generate/GenerateView.vue') }),
  defineTool({ id: 'character', group: 'character', title: 'character', job: 'talk with a character that sees, speaks and remembers', phase: 4, packages: ['character', 'converse', 'speak', 'avatar-host', 'memory'], load: () => import('../character/CharacterView.vue') }),
  defineTool({ id: 'room', group: 'rooms', title: 'room', job: 'watch an agent live in a room and inspect its mind', phase: 4, packages: ['agent', 'act', 'senses', 'drives'], load: pending }),
  ...['avatar', 'retarget', 'ik', 'gait', 'lipsync', 'motion-match', 'motion-net'].map((id) =>
    defineTool({ id, group: 'motion', title: id, job: `${id} for 3d characters`, phase: 5, packages: [id], load: pending }),
  ),
  ...['senses', 'drives', 'cameras', 'mover', 'scenario'].map((id) =>
    defineTool({ id, group: 'agents', title: id, job: `${id} for embodied agents`, phase: 5, packages: [id], load: pending }),
  ),
]
