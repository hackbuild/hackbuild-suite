// Stand ins the see and make examples share: models that know the drawn
// sample, in the shapes @hackbuild/vision gives them, and a small three.js
// turntable for a surface. A real page loads the models through a pick.
import type { DepthMap, Detection, DepthModel, Detector, Vlm } from "@hackbuild/vision";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SAMPLE_THINGS, insideThing, sleep } from "./fixtures.js";

/** Finds the cup and the ball in the sample; a camera frame it does not know. */
export const sampleDetector = (known: unknown): Detector => ({
  detect: async (image) => {
    await sleep(120);
    if (image !== known) return [];
    return SAMPLE_THINGS.map((t): Detection => ({ label: t.label, score: t.score, box: { x: t.x, y: t.y, w: t.w, h: t.h } }));
  },
});

/** Depth of the sample: the wall far, the table nearer toward you, the cup and the ball nearest. */
export function sampleDepthMap(w = 200, h = 150): DepthMap {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = (x / w) * 800;
      const sy = (y / h) * 600;
      let d = sy > 420 ? 0.25 + ((sy - 420) / 180) * 0.35 : 0.12;
      for (const t of SAMPLE_THINGS) {
        if (!insideThing(t, sx, sy)) continue;
        const cx = t.x + t.w / 2;
        const cy = t.y + t.h / 2;
        const r = Math.hypot((sx - cx) / (t.w / 2), (sy - cy) / (t.h / 2));
        d = Math.max(d, t.label === "ball" ? 0.55 + 0.35 * Math.sqrt(Math.max(0, 1 - r * r)) : 0.7);
      }
      data[y * w + x] = d;
    }
  }
  return { width: w, height: h, data, range: [0, 1] };
}
export const sampleDepth: DepthModel = { estimate: async () => (await sleep(150), sampleDepthMap()) };

/** Answers a few questions about the sample, as a vision language model would. */
export const sampleVlm: Vlm = {
  ask: async (_image, question = "") => {
    await sleep(400);
    const q = question.toLowerCase();
    if (/colou?r/.test(q)) return "the cup is red and the ball is blue.";
    if (/how many|count/.test(q)) return "two things: a cup and a ball.";
    if (/where|left|right/.test(q)) return "the cup is in the middle of the table and the ball is to its right.";
    return "a red cup on a table, with a blue ball beside it.";
  },
};

/** Pixels of a canvas, for the libraries that take RGBA. */
export const pixelsOf = (c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height);

/** A lit three.js scene that fills `el`, drag to turn; `show` swaps the object on it. */
export function turntable(el: HTMLElement) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%;touch-action:none";
  el.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xefe9db);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8170, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(30, 60, 50);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 1000);
  camera.position.set(0, -40, 70);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  let shown: THREE.Object3D | null = null;
  let raf = 0;
  const fit = () => {
    const w = el.clientWidth || 1;
    const h = el.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(el);
  const tick = () => {
    controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  tick();
  return {
    show(o: THREE.Object3D) {
      if (shown) scene.remove(shown);
      shown = o;
      scene.add(o);
    },
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
