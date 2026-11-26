// a dog that walks: four legs on an oscillator that picks walk, trot or
// gallop from the speed, body springs that pitch and roll it, and a tail.
// The dog is bones and boxes built in code; it circles the yard.
import { load, BodyDynamics, QuadrupedGait, TailWag, type GaitName, type GaitState } from "@hackbuild/gait";
import { driveQuadruped, measureQuadruped } from "@hackbuild/gait/three";
import { Vector3 } from "three";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { draw, sleep, type Example } from "../../shared/fixtures.js";
import { DOG_NAMES, buildDog, kv, stage3 } from "../../shared/move.js";

const SPEEDS = [0.3, 0.7, 1.4, 2.4, 3.6];

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" aria-label="the dog"></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="pace">
            <button type="button" class="hb-btn hb-btn-go" data-faster>go faster</button>
            <button type="button" class="hb-btn" data-slower>slower</button>
          </div>
        </section>
        <aside class="hb-rack" aria-label="gait">
          <nav class="hb-tabs" role="tablist" aria-label="gait tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">gait</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">feet</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">body</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">how it moves</div><p class="hb-marker" data-gait>walk</p><div data-now></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">on the ground</div><div data-feet></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">the body</div><div data-body></div></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the gait blends five footfall patterns by speed. each leg plants a foot and swings it on its phase; two bone ik puts the paw on the spot.</p></div></details>
        </aside>
      </div>
    </div>`);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const dog = buildDog();
  let speed = 1;
  let parts: { gait: QuadrupedGait; body: BodyDynamics; tail: TailWag; rig: ReturnType<typeof measureQuadruped> } | null = null;
  const pose = { x: 0, z: 0, yaw: 0 };
  let shown = 0;

  const view = stage3($(".hb-lay-subject"), (dt) => {
    if (!parts) return;
    const turnRate = SPEEDS[speed]! / 2.2; // a circle about 4.4 m across
    pose.yaw += turnRate * dt;
    pose.x += Math.sin(pose.yaw) * SPEEDS[speed]! * dt;
    pose.z += Math.cos(pose.yaw) * SPEEDS[speed]! * dt;
    const cmd = { speed: SPEEDS[speed]!, turnRate };
    const s = parts.gait.update(dt, pose, cmd);
    const body = parts.body.update(dt, s, cmd, [0, 0, 0, 0]);
    parts.gait.setOffsets(body.legOffsets);
    const tail = parts.tail.update(dt, { modeWeights: [1, 2, 1, 1, 0, 0, 0, 1], arousal: 0.5, turnRate });
    driveQuadruped(parts.rig, pose, s, body, { tail });
    // the view keeps its angle and distance while the dog circles
    const was = view.controls.target.clone();
    view.controls.target.lerp(new Vector3(pose.x, 0.3, pose.z), 0.1);
    view.camera.position.add(view.controls.target.clone().sub(was));
    if ((shown += dt) > 0.25) (show(s, body.pitch, body.roll), (shown = 0));
  });
  view.camera.position.set(1.6, 0.9, 1.8);
  view.controls.target.set(0, 0.3, 0);
  view.scene.add(dog);

  const show = (s: GaitState, pitch: number, roll: number) => {
    const name = (Object.entries(s.weights) as [GaitName, number][]).sort((a, b) => b[1] - a[1])[0]![0];
    $("[data-gait]").textContent = name;
    kv($("[data-now]"), { speed: `${SPEEDS[speed]} m/s`, "steps a second": s.frequency.toFixed(2), "share on the ground": s.duty.toFixed(2) });
    kv($("[data-feet]"), Object.fromEntries(["left front", "right front", "left hind", "right hind"].map((n, i) => [n, s.feet[i]!.stance ? "planted" : "swinging"])));
    kv($("[data-body]"), { pitch: `${((pitch * 180) / Math.PI).toFixed(1)} deg`, roll: `${((roll * 180) / Math.PI).toFixed(1)} deg` });
  };

  void load().then(() => {
    const rig = measureQuadruped(dog, DOG_NAMES);
    const gait = new QuadrupedGait(rig.specs, rig.legLength, { rng: Math.random, ground: () => 0 });
    gait.reset(0, 0, 0);
    parts = { rig, gait, body: new BodyDynamics(rig.geometry, Math.random), tail: new TailWag(Math.max(1, rig.tail.length), 0.06, Math.random) };
  });
  const faster = $("[data-faster]") as HTMLButtonElement;
  const slower = $("[data-slower]") as HTMLButtonElement;
  const pace = (d: number) => {
    speed = Math.max(0, Math.min(SPEEDS.length - 1, speed + d));
    faster.hidden = speed === SPEEDS.length - 1;
    slower.hidden = speed === 0;
  };
  faster.addEventListener("click", () => pace(1));
  slower.addEventListener("click", () => pace(-1));

  const lay = layout(root);
  // the built in sample: up to a trot
  const sample = async () => {
    pace(1);
    await sleep(800);
  };
  return {
    sample,
    dispose: () => {
      view.dispose();
      if (parts) for (const p of [parts.gait, parts.body, parts.tail]) p.dispose();
      parts = null;
      lay.dispose();
      host.innerHTML = "";
    },
  };
}
