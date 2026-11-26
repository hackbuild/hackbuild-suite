// The relief in 3D, the original's iso, front, side, explode and cut views:
// each colour body lit from above in its filament colour. Imported on first
// use so three.js stays out of the first load. A drag turns it.
import {
  AmbientLight, BufferAttribute, BufferGeometry, Color, DirectionalLight, DoubleSide, Group, Mesh, MeshStandardMaterial, PerspectiveCamera, Plane, Scene, Vector3, WebGLRenderer,
} from 'three'

export type View3d = 'iso' | 'front' | 'side' | 'explode' | 'cut'
export interface Part3d { positions: Float32Array; indices: Uint32Array; color: string }

export function createStage(host: HTMLElement) {
  const r = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  r.localClippingEnabled = true
  r.domElement.setAttribute('aria-label', 'the relief in 3d. drag to turn it.')
  r.domElement.style.cssText = 'display:block;width:100%;height:100%;touch-action:none'
  host.appendChild(r.domElement)
  const scene = new Scene()
  const cam = new PerspectiveCamera(35, 1, 0.1, 4000)
  scene.add(new AmbientLight(0xffffff, 0.6))
  const sun = new DirectionalLight(0xffffff, 1.5)
  sun.position.set(-0.6, 0.9, 1.2)
  scene.add(sun)
  const group = new Group()
  group.rotation.x = -Math.PI / 2
  scene.add(group)
  const cut = new Plane(new Vector3(0, 0, -1), 0)
  let span = 30, yaw = 0.5, pitch = 0.75, view: View3d = 'iso'

  const draw = () => {
    const w = host.clientWidth || 1, h = host.clientHeight || 1
    r.setPixelRatio(Math.min(2, devicePixelRatio))
    r.setSize(w, h, false)
    cam.aspect = w / h
    const d = span * 3.2
    cam.position.set(Math.sin(yaw) * Math.cos(pitch) * d, Math.sin(pitch) * d, Math.cos(yaw) * Math.cos(pitch) * d)
    cam.lookAt(0, 0, 0)
    cam.updateProjectionMatrix()
    r.render(scene, cam)
  }
  const ro = new ResizeObserver(draw)
  ro.observe(host)
  let drag: { x: number; y: number } | null = null
  const down = (e: PointerEvent) => { drag = { x: e.clientX, y: e.clientY }; r.domElement.setPointerCapture(e.pointerId) }
  const move = (e: PointerEvent) => {
    if (!drag) return
    yaw -= (e.clientX - drag.x) * 0.01
    pitch = Math.max(-1.4, Math.min(1.5, pitch + (e.clientY - drag.y) * 0.01))
    drag = { x: e.clientX, y: e.clientY }
    draw()
  }
  const up = () => { drag = null }
  r.domElement.addEventListener('pointerdown', down)
  r.domElement.addEventListener('pointermove', move)
  r.domElement.addEventListener('pointerup', up)

  function layout() {
    group.children.forEach((m, i) => { m.position.z = view === 'explode' ? i * span * 0.12 : 0 })
    for (const m of group.children) ((m as Mesh).material as MeshStandardMaterial).clippingPlanes = view === 'cut' ? [cut] : []
    if (view === 'front') (yaw = 0), (pitch = 0.05)
    else if (view === 'side') (yaw = Math.PI / 2), (pitch = 0.05)
    else (yaw = 0.5), (pitch = 0.75)
    draw()
  }
  return {
    set(parts: Part3d[]) {
      for (const m of group.children) ((m as Mesh).geometry.dispose(), ((m as Mesh).material as MeshStandardMaterial).dispose())
      group.clear()
      let lo = Infinity, hi = -Infinity
      for (const p of parts) {
        const g = new BufferGeometry()
        g.setAttribute('position', new BufferAttribute(p.positions, 3))
        g.setIndex(new BufferAttribute(p.indices, 1))
        g.computeVertexNormals()
        for (let i = 0; i < p.positions.length; i += 3) (lo = Math.min(lo, p.positions[i]!)), (hi = Math.max(hi, p.positions[i]!))
        group.add(new Mesh(g, new MeshStandardMaterial({ color: new Color(p.color), roughness: 0.7, side: DoubleSide })))
      }
      span = Number.isFinite(hi - lo) ? Math.max(4, hi - lo) : 30
      layout()
    },
    view(v: View3d) { view = v; layout() },
    png: () => (draw(), r.domElement.toDataURL('image/png')),
    dispose() { ro.disconnect(); r.dispose(); r.domElement.remove() },
  }
}
export type Stage = ReturnType<typeof createStage>
