// Registers the masks kind once, so an image dropped on the masks page, or
// picked in the chooser elsewhere, opens in the masks tool (design 2.5).
import { kinds, registerKind } from '../workspace/state'
import { readFrame } from '../vision/frame.ts'
import { MASKS_KIND, masksKind } from './kind.ts'

export function registerMasks(): void {
  if (!kinds.get(MASKS_KIND)) registerKind(masksKind(readFrame))
}
