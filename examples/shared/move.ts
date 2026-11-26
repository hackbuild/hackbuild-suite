// What the move and think examples share: a lit three.js stage that fills
// a layout subject, a dog of bones and boxes, and a walk written as bvh text.
// Everything is built in code; no model, clip or weight file.
import {
  AmbientLight, Bone, BoxGeometry, Color, DirectionalLight, Group, Mesh, MeshStandardMaterial, PerspectiveCamera,
  PlaneGeometry, Scene, Vector3, WebGLRenderer, type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface Stage3 {
  scene: Scene;
  camera: PerspectiveCamera;
  renderer: WebGLRenderer;
  controls: OrbitControls;
  dispose(): void;
}

/** A stage on paper light in `subject`, drawn each frame after `tick(dt)`; it stops on dispose. */
export function stage3(subject: HTMLElement, tick: (dt: number, t: number) => void, opts: { ground?: boolean } = {}): Stage3 {
  const renderer = new WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.domElement.style.cssText = "display:block;width:100%;height:100%";
  subject.append(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color("#efe9db");
  const camera = new PerspectiveCamera(40, 1, 0.05, 200);
  camera.position.set(2.4, 1.6, 3.2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.5, 0);
  controls.enableDamping = true;
  scene.add(new AmbientLight("#ffffff", 1.1));
  const sun = new DirectionalLight("#ffffff", 1.6);
  sun.position.set(3, 6, 4);
  scene.add(sun);
  if (opts.ground !== false) {
    const g = new PlaneGeometry(40, 40);
    g.rotateX(-Math.PI / 2);
    scene.add(new Mesh(g, new MeshStandardMaterial({ color: "#d9d0bd", roughness: 1 })));
  }
  const fit = () => {
    const w = Math.max(1, subject.clientWidth);
    const h = Math.max(1, subject.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(fit);
  ro.observe(subject);
  fit();
  let raf = 0;
  let last = performance.now();
  let t = 0;
  const frame = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    tick(dt, t);
    if (controls.enabled) controls.update();
    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return {
    scene, camera, renderer, controls,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof Mesh) {
          o.geometry.dispose();
          for (const m of [o.material].flat()) m.dispose();
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

/** Label and value rows in the kit's kv look. */
export function kv(host: Element, rows: Record<string, string | number>): void {
  host.innerHTML = Object.entries(rows).map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${k}</span><span class="hb-readout">${v}</span></div>`).join("");
}

/** A dog of bones and boxes facing +z, about 0.78 m nose to tail; the names `@hackbuild/gait` expects. */
export function buildDog(color = "#c9a36b"): Group {
  const root = new Group();
  const bone = (name: string, parent: Object3D, p: [number, number, number]) => {
    const b = new Bone();
    b.name = name;
    b.position.set(...p);
    parent.add(b);
    return b;
  };
  const hips = bone("hips", root, [0, 0.38, 0]);
  const spine = bone("spine2", hips, [0, 0, 0.1]);
  const chest = bone("chest", spine, [0, 0, 0.12]);
  const head = bone("head", bone("neck1", chest, [0, 0.08, 0.05]), [0, 0.08, 0.06]);
  for (const [s, x] of [["L", 0.09], ["R", -0.09]] as const) {
    const fe = bone(`frontHorselink.${s}`, bone(`frontLeg.${s}_03`, bone(`frontUpr.${s}`, chest, [x, 0, 0]), [0, -0.18, -0.08]), [0, -0.16, 0.08]);
    bone(`frontToe.${s}`, fe, [0, -0.02, 0.03]);
    const re = bone(`rearHorselink.${s}`, bone(`rearLwr.${s}`, bone(`rearUpr.${s}`, hips, [x, 0, -0.2]), [0, -0.17, 0.07]), [0, -0.15, -0.08]);
    bone(`rearToe.${s}`, bone(`rearFoot.${s}`, re, [0, -0.02, 0.01]), [0, -0.02, 0.03]);
  }
  bone("tail_03", bone("tail3", bone("tail1", hips, [0, 0.02, -0.25]), [0, 0, -0.08]), [0, 0, -0.08]);
  const mat = new MeshStandardMaterial({ color, roughness: 0.7 });
  const Z = new Vector3(0, 0, 1);
  const parts: [Object3D, Mesh][] = [];
  root.traverse((o) => {
    if (!(o instanceof Bone)) return;
    for (const c of o.children) {
      if (!(c instanceof Bone) || c.position.length() < 1e-4) continue;
      const thick = c.name === "spine2" || c.name === "chest" ? 0.17 : /Upr/.test(c.name) ? 0.07 : /tail/.test(c.name) ? 0.03 : 0.045;
      const m = new Mesh(new BoxGeometry(thick, thick, c.position.length()), mat);
      m.position.copy(c.position).multiplyScalar(0.5);
      m.quaternion.setFromUnitVectors(Z, c.position.clone().normalize());
      parts.push([o, m]);
    }
  });
  for (const [o, m] of parts) o.add(m);
  const skull = new Mesh(new BoxGeometry(0.11, 0.1, 0.18), mat);
  skull.position.set(0, 0.02, 0.05);
  head.add(skull);
  return root;
}

export const DOG_NAMES = {
  hips: "hips",
  spine: ["spine2", "chest"],
  tail: ["tail1", "tail3", "tail_03"],
  legs: {
    LF: { up: "frontUpr.L", mid: "frontLeg.L_03", end: "frontHorselink.L", toes: ["frontToe.L"] },
    RF: { up: "frontUpr.R", mid: "frontLeg.R_03", end: "frontHorselink.R", toes: ["frontToe.R"] },
    LH: { up: "rearUpr.L", mid: "rearLwr.L", end: "rearHorselink.L", toes: ["rearFoot.L", "rearToe.L"] },
    RH: { up: "rearUpr.R", mid: "rearLwr.R", end: "rearHorselink.R", toes: ["rearFoot.R", "rearToe.R"] },
  },
};

/** A walk as bvh text: another rig, other bone names, centimeters, arms down, so a retarget has work to do. */
export function walkBvh(seconds = 2.4, fps = 30, swing = 1): string {
  const J: [string, number, number[]][] = [
    ["Hips", -1, [0, 0, 0]], ["Spine", 0, [0, 12, 0]], ["Spine1", 1, [0, 16, 0]], ["Neck", 2, [0, 26, 0]], ["Head", 3, [0, 11, 0]],
    ["LeftArm", 2, [18, 22, 0]], ["LeftForeArm", 5, [29, 0, 0]], ["LeftHand", 6, [26, 0, 0]],
    ["RightArm", 2, [-18, 22, 0]], ["RightForeArm", 8, [-29, 0, 0]], ["RightHand", 9, [-26, 0, 0]],
    ["LeftUpLeg", 0, [10, -6, 0]], ["LeftLeg", 11, [0, -47, 0]], ["LeftFoot", 12, [0, -45, 0]], ["LeftToeBase", 13, [0, -8, 14]],
    ["RightUpLeg", 0, [-10, -6, 0]], ["RightLeg", 15, [0, -47, 0]], ["RightFoot", 16, [0, -45, 0]], ["RightToeBase", 17, [0, -8, 14]],
  ];
  const kids = (i: number) => J.map((j, k) => [j, k] as const).filter(([j]) => j[1] === i).map(([, k]) => k);
  const order: number[] = [];
  const write = (i: number, pad: string): string => {
    order.push(i);
    const [name, parent, o] = J[i]!;
    const ch = parent < 0 ? "CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation" : "CHANNELS 3 Zrotation Xrotation Yrotation";
    const c = kids(i);
    const body = c.length ? c.map((k) => write(k, pad + "  ")).join("") : `${pad}  End Site\n${pad}  {\n${pad}    OFFSET 0 6 0\n${pad}  }\n`;
    return `${pad}${parent < 0 ? "ROOT" : "JOINT"} ${name}\n${pad}{\n${pad}  OFFSET ${o.join(" ")}\n${pad}  ${ch}\n${body}${pad}}\n`;
  };
  const tree = write(0, "");
  const n = Math.round(seconds * fps);
  const lines: string[] = [];
  for (let f = 0; f < n; f++) {
    const ph = (f / fps) * 2 * Math.PI * (1 / seconds) * 2;
    const s = Math.sin(ph) * swing;
    const rot: Record<string, number[]> = {
      LeftUpLeg: [0, -28 * s, 0], RightUpLeg: [0, 28 * s, 0],
      LeftLeg: [0, 45 * Math.max(0, Math.sin(ph + 1.4)) * swing, 0], RightLeg: [0, 45 * Math.max(0, Math.sin(ph + 1.4 + Math.PI)) * swing, 0],
      LeftArm: [-70, 22 * s, 0], RightArm: [70, -22 * s, 0], LeftForeArm: [0, 0, -15], RightForeArm: [0, 0, 15],
    };
    lines.push(order.map((i) => (i === 0 ? [0, 106 + 2.5 * Math.cos(2 * ph), 0, 2 * s, 0, 3 * s] : rot[J[i]![0]] ?? [0, 0, 0]).map((v) => v.toFixed(3)).join(" ")).join(" "));
  }
  return `HIERARCHY\n${tree}MOTION\nFrames: ${n}\nFrame Time: ${(1 / fps).toFixed(6)}\n${lines.join("\n")}\n`;
}
