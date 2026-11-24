// The relief's 3D part (design 3.5, P-DEPTH-9): the closed solid lit from
// above on the stage host, which sizes it to its box and stops the loop
// when nobody can see it (2.9). A drag turns it; left alone it turns
// slowly. This module is the only one that imports three.js, and the view
// imports it on first use, so three stays out of the first load.
import {
  AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, Scene, WebGLRenderer,
} from 'three'
import { createStageHost, type StageHost } from '../stage/host.ts'

export interface ReliefPreview {
  /** Show a new solid, in mm, centred on x and y with z up. */
  set(m: { positions: Float32Array; indices: Uint32Array }): void
  setActive(on: boolean): void
  dispose(): void
}

export function createReliefPreview(host: HTMLElement, tone: (name: string) => string): ReliefPreview {
  const renderer = new WebGLRenderer({ antialias: true, alpha: true })
  renderer.domElement.setAttribute('aria-label', 'the relief in 3d. drag to turn it.')
  renderer.domElement.style.touchAction = 'none'
  const scene = new Scene()
  const camera = new PerspectiveCamera(35, 1, 0.1, 2000)
  scene.add(new AmbientLight(0xffffff, 0.55))
  const sun = new DirectionalLight(0xffffff, 1.6)
  sun.position.set(-0.6, 0.9, 1.2)
  scene.add(sun)
  const material = new MeshStandardMaterial({ color: new Color(tone('--hb-plate-teal') || '#7fb8b0'), roughness: 0.7, metalness: 0 })
  const mesh = new Mesh(new BufferGeometry(), material)
  // print bed lies flat: the relief's z is up, the camera looks down at it from the front
  mesh.rotation.x = -Math.PI / 2
  scene.add(mesh)
  let span = 30
  let yaw = 0.5
  let pitch = 0.75
  let dragging = false
  let idle = true

  const place = () => {
    const d = span * 3.4
    camera.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d)
    camera.lookAt(0, 0, 0)
  }
  const stage: StageHost = createStageHost(host, {
    renderer,
    resize(w, h) { camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix() },
    draw(dt) {
      if (idle && !dragging) yaw += dt * 0.25
      place()
      renderer.render(scene, camera)
    },
  })
  let last: { x: number; y: number } | null = null
  const el = renderer.domElement
  el.addEventListener('pointerdown', (e) => { dragging = true; idle = false; last = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId) })
  el.addEventListener('pointermove', (e) => {
    if (!dragging || !last) return
    yaw -= (e.clientX - last.x) * 0.01
    pitch = Math.min(1.5, Math.max(0.1, pitch + (e.clientY - last.y) * 0.01))
    last = { x: e.clientX, y: e.clientY }
    stage.invalidate()
  })
  const up = () => { dragging = false; last = null }
  el.addEventListener('pointerup', up)
  el.addEventListener('pointercancel', up)

  return {
    set(m) {
      const g = new BufferGeometry()
      g.setAttribute('position', new BufferAttribute(m.positions, 3))
      g.setIndex(new BufferAttribute(m.indices, 1))
      g.computeVertexNormals()
      g.computeBoundingSphere()
      mesh.geometry.dispose()
      mesh.geometry = g
      span = Math.max(4, (g.boundingSphere?.radius ?? 15) * 1.1)
      stage.invalidate()
    },
    setActive: (on) => stage.setActive(on),
    dispose() {
      stage.dispose()
      mesh.geometry.dispose()
      material.dispose()
    },
  }
}
