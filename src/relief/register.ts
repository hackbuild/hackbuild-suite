// Registers the relief kind once, so a photo dropped on the relief page, or
// picked in the chooser elsewhere, opens in the relief tool (design 2.5),
// and provides the depth-mesh core from the wasm inlined in the package, so
// it also loads from file://.
import { coreState, provide } from '../cores.ts'
import { kinds, registerKind } from '../workspace/state'
import { readFrame } from '../vision/frame.ts'
import { RELIEF_KIND, reliefKind } from './kind.ts'

export function registerRelief(): void {
  if (!kinds.get(RELIEF_KIND)) registerKind(reliefKind(readFrame))
}

export function provideDepthMesh(): void {
  if (coreState('depth-mesh') !== 'idle') return
  provide('depth-mesh', async () => {
    const [{ loadDepthMesh }, { DEPTH_MESH_WASM_BASE64 }] = await Promise.all([import('@hackbuild/depth-mesh'), import('@hackbuild/depth-mesh/inline')])
    return loadDepthMesh({ base64: DEPTH_MESH_WASM_BASE64 })
  })
}
