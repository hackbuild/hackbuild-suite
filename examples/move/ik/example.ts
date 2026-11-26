// reach with two bone ik: the stand in's right arm reaches for a pink ball.
// The ball circles on its own; drag on the stage to put it somewhere, and the
// upper arm, forearm and hand solve toward it every frame.
import { Mesh, MeshStandardMaterial, Plane, Raycaster, SphereGeometry, Vector2, Vector3 } from "three";
import { load } from "@hackbuild/ik";
import { solveTwoBone } from "@hackbuild/ik/three";
import { characterStage } from "@hackbuild/motion-views/vanilla";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

// small page helpers, kept here so this file stands alone
const draw = (host: HTMLElement, markup: string) => ((host.innerHTML = markup.trim()), host.firstElementChild as HTMLElement);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const kv = (el: Element, rows: Record<string, string | number>) =>
  (el.innerHTML = Object.entries(rows).map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${k}</span><span class="hb-readout">${v}</span></div>`).join(""));

export default function mount(host: HTMLElement): { sample: () => Promise<void>; dispose: () => void } {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage"></section>
        <aside class="hb-rack" aria-label="reach">
          <nav class="hb-tabs" role="tablist" aria-label="reach tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">reach</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">arm</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">how</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">the hand</div><p class="hb-marker" data-word>reaching</p><div data-now></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">the chain</div><div data-arm></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">how it solves</div><p class="hb-note">two bones and a target make a triangle. the elbow bends toward a pole behind the arm, then the hand turns to the ball.</p></section></section>
        </aside>
      </div>
    </div>`);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const view = characterStage($(".hb-lay-stage"), {
    framing: "full",
    verbs: [{ id: "somewhere", label: "reach somewhere new", go: true }, { id: "circle", label: "circle" }],
  });
  view.stage.controls.enabled = false;
  const ball = new Mesh(new SphereGeometry(0.05, 20, 14), new MeshStandardMaterial({ color: "#fe0386" }));
  view.stage.scene.add(ball);
  const target = new Vector3(-0.35, 1.3, 0.35);
  const pole = new Vector3(0, -0.4, -1);
  let circling = true;
  let t = 0;
  let ready = false;

  // after the body's own pose each frame, the arm solves toward the ball
  const hook = () => {
    const body = view.body;
    if (!body) return;
    const b = body.avatar.bones;
    const [up, low, hand] = [b.rightUpperArm, b.rightLowerArm, b.rightHand];
    if (!up || !low || !hand) return;
    kv($("[data-arm]"), { upper: up.name, lower: low.name, end: hand.name });
    const update = body.avatar.update.bind(body.avatar);
    body.avatar.update = (dt: number) => {
      update(dt);
      t += dt;
      if (circling) target.set(-0.32 + 0.2 * Math.cos(t * 1.2), 1.3 + 0.18 * Math.sin(t * 1.2), 0.32);
      ball.position.copy(target);
      if (!ready) return;
      const reached = solveTwoBone(up, low, hand, target, pole);
      const d = hand.getWorldPosition(new Vector3()).distanceTo(target);
      $("[data-word]").textContent = reached ? "holding it" : "reaching";
      kv($("[data-now]"), { "hand to ball": `${(d * 100).toFixed(1)} cm`, reached: reached ? "yes" : "no", ball: circling ? "circling" : "held" });
    };
  };
  const offView = view.on((e) => {
    if (e.type === "loaded") hook();
    if (e.type === "verb" && e.id === "somewhere") somewhere();
    if (e.type === "verb" && e.id === "circle") circling = true;
  });
  if (view.body) hook();
  void load().then(() => (ready = true));
  const somewhere = () => {
    circling = false;
    target.set(-0.2 - Math.random() * 0.4, 1.0 + Math.random() * 0.6, 0.15 + Math.random() * 0.3);
  };

  // drag on the stage: the ball follows the pointer on a plane in front of the body
  const canvas = view.stage.canvas;
  const ray = new Raycaster();
  const plane = new Plane(new Vector3(0, 0, 1), -0.32);
  const move = (e: PointerEvent) => {
    if (!(e.buttons & 1)) return;
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), view.stage.camera);
    if (ray.ray.intersectPlane(plane, target)) circling = false;
  };
  canvas.addEventListener("pointerdown", move);
  canvas.addEventListener("pointermove", move);

  const lay = layout(root);
  // the built in sample: the ball goes somewhere new and the arm follows
  const sample = async () => {
    somewhere();
    await sleep(600);
  };
  return {
    sample,
    dispose: () => {
      offView();
      canvas.removeEventListener("pointerdown", move);
      canvas.removeEventListener("pointermove", move);
      ball.geometry.dispose();
      (ball.material as MeshStandardMaterial).dispose();
      view.dispose();
      lay.dispose();
      host.innerHTML = "";
    },
  };
}
