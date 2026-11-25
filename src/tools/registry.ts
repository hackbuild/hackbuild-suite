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
  defineTool({ id: 'avatar', group: 'motion', title: 'avatar', job: 'load any character file and inspect it', phase: 5, packages: ['avatar', 'avatar-host', 'tunables'], load: () => import('../avatar/AvatarView.vue') }),
  defineTool({ id: 'retarget', group: 'motion', title: 'retarget', job: 'put a bvh or vmd clip on your character', phase: 5, packages: ['retarget', 'rig', 'avatar-host'], load: () => import('../retarget/RetargetView.vue') }),
  defineTool({ id: 'ik', group: 'motion', title: 'ik', job: 'pose limbs by dragging targets', phase: 5, packages: ['ik', 'avatar-host'], load: () => import('../ik/IkView.vue') }),
  defineTool({ id: 'gait', group: 'motion', title: 'gait', job: 'make a quadruped walk and tune it', phase: 5, packages: ['gait', 'rig', 'avatar-host'], load: () => import('../gait/GaitView.vue') }),
  defineTool({ id: 'lipsync', group: 'motion', title: 'lipsync', job: 'drive a mouth from text, audio or the mic', phase: 5, packages: ['lipsync', 'speak', 'avatar-host'], load: () => import('../lipsync/LipsyncView.vue') }),
  defineTool({ id: 'motion-match', group: 'motion', title: 'motion-match', job: 'steer a character through a clip set', phase: 5, packages: ['motion-match', 'ik', 'avatar-host'], load: () => import('../motionmatch/MotionMatchView.vue') }),
  defineTool({ id: 'motion-net', group: 'motion', title: 'motion-net', job: 'run the neural quadruped gait', phase: 5, packages: ['motion-net', 'weights', 'gait'], load: () => import('../motionnet/MotionNetView.vue') }),
  defineTool({ id: 'senses', group: 'agents', title: 'senses', job: 'see what an agent can perceive', phase: 5, packages: ['senses'], load: () => import('../senses/SensesView.vue') }),
  defineTool({ id: 'drives', group: 'agents', title: 'drives', job: 'watch needs rise and choices get made', phase: 5, packages: ['drives'], load: () => import('../drives/DrivesView.vue') }),
  ...['cameras', 'mover', 'scenario'].map((id) =>
    defineTool({ id, group: 'agents', title: id, job: `${id} for embodied agents`, phase: 5, packages: [id], load: pending }),
  ),
]
