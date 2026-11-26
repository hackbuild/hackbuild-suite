// a camera that follows: one walker on a figure eight and a friend in a
// yard of boxes, seen through four rigs: follow, orbit, group and its own
// eye. The inset shows what the walker sees, with its head hidden.
import { BoxGeometry, CylinderGeometry, Mesh, MeshStandardMaterial, PerspectiveCamera, SphereGeometry, Vector3, WebGLRenderer } from "three";
import { FirstPerson, Follow, Group, Orbit, Shake } from "@hackbuild/cameras";
import { eyeInset } from "@hackbuild/agents-views";
import { threeStage } from "@hackbuild/motion-views/vanilla";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

// small page helpers, kept here so this file stands alone
const draw = (host: HTMLElement, markup: string) => ((host.innerHTML = markup.trim()), host.firstElementChild as HTMLElement);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const kv = (el: Element, rows: Record<string, string | number>) =>
  (el.innerHTML = Object.entries(rows).map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${k}</span><span class="hb-readout">${v}</span></div>`).join(""));

type Rig = "follow" | "orbit" | "group" | "eye";
const RIGS: Rig[] = ["follow", "orbit", "group", "eye"];

export default function mount(host: HTMLElement): { sample: () => Promise<void>; dispose: () => void } {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" aria-label="the yard"></div>
          <div class="hb-lay-inset" data-eye></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="camera">
            ${RIGS.map((r) => `<button type="button" class="hb-btn" data-rig="${r}" aria-pressed="${r === "follow"}">${r}</button>`).join("")}
            <button type="button" class="hb-btn hb-btn-go" data-shake>shake</button>
          </div>
        </section>
        <aside class="hb-rack" aria-label="camera">
          <nav class="hb-tabs" role="tablist" aria-label="camera tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">camera</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">rigs</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">how</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">now</div><p class="hb-marker" data-rigname>follow</p><div data-now></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">the four rigs</div><div data-rigs></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">how they move</div><p class="hb-note">each rig eases toward where it wants to be at a rate per second, so it looks the same at any frame rate. shake is seeded noise that fades.</p></section></section>
        </aside>
      </div>
    </div>`);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  kv($("[data-rigs]"), { follow: "behind, eased", orbit: "circles a point", group: "keeps both in view", eye: "the walker's own view" });
  let rig: Rig = "follow";
  const walker = new Mesh(new CylinderGeometry(0.22, 0.22, 1.5, 16), new MeshStandardMaterial({ color: "#1a1a1a" }));
  const head = new Mesh(new SphereGeometry(0.2, 16, 12), new MeshStandardMaterial({ color: "#fe0386" }));
  head.position.y = 0.9;
  walker.add(head);
  const friend = new Mesh(new CylinderGeometry(0.22, 0.22, 1.2, 16), new MeshStandardMaterial({ color: "#2f5fa7" }));
  const pos = new Vector3();
  let heading = 0;
  let follow: Follow, orbit: Orbit, group: Group, shake: Shake, mainEye: FirstPerson;

  const view = threeStage($(".hb-lay-subject"), (dt, t) => {
    // the walker draws a figure eight; the friend trails it
    const next = new Vector3(4 * Math.sin(t * 0.35), 0.75, 2.5 * Math.sin(t * 0.7));
    heading = Math.atan2(next.x - pos.x, next.z - pos.z);
    pos.copy(next);
    walker.position.copy(pos);
    walker.rotation.y = heading;
    friend.position.lerp(new Vector3(pos.x - 1.2, 0.6, pos.z - 1.2), 0.02);
    const p = { x: pos.x, y: 0, z: pos.z };
    if (rig === "follow") follow.update(p, heading, dt);
    if (rig === "orbit") (orbit.rotate(dt * 0.25, 0), (orbit.target = p), orbit.apply());
    if (rig === "group") group.update([p, { x: friend.position.x, y: 0, z: friend.position.z }], dt);
    if (rig === "eye") mainEye.place(head.getWorldPosition(new Vector3()), heading, -0.1);
    const s = shake.step(dt);
    view.camera.position.add(new Vector3(s.x, s.y, s.z));
    eye.frame();
    kv($("[data-now]"), { "camera to walker": `${view.camera.position.distanceTo(pos).toFixed(1)} m`, shake: shake.amplitude.toFixed(2) });
  });
  view.orbit.enabled = false; // the rigs aim the camera
  for (let i = 0; i < 14; i++) {
    const b = new Mesh(new BoxGeometry(0.6, 0.4 + (i % 4) * 0.4, 0.6), new MeshStandardMaterial({ color: i % 3 ? "#c9c1b3" : "#8f877a" }));
    b.position.set(Math.cos(i * 2.4) * (5.5 + (i % 3)), b.geometry.parameters.height / 2, Math.sin(i * 2.4) * (4.5 + (i % 3)));
    view.scene.add(b);
  }
  view.scene.add(walker, friend);
  follow = new Follow(view.camera, { distance: 4, pitch: 0.35, lookHeight: 1 });
  orbit = new Orbit(view.camera, 0.6, 0.45, 9);
  group = new Group(view.camera, { pitch: 0.7, pad: 1.4, minDistance: 4, maxDistance: 20 });
  shake = new Shake(Math.random);
  mainEye = new FirstPerson(view.camera, head);

  // the walker's eye in the inset, its head hidden while it draws
  const eyeCam = new PerspectiveCamera(70, 2, 0.05, 100);
  const fp = new FirstPerson(eyeCam, head);
  let eyeGl: WebGLRenderer | null = null;
  const eye = eyeInset($("[data-eye]"), {
    who: [{ id: "walker", label: "walker eye", title: "what the walker sees", eye: fp }],
    draw: (canvas) => {
      eyeGl ??= new WebGLRenderer({ canvas, antialias: true });
      fp.place(head.getWorldPosition(new Vector3()), heading, -0.1);
      eyeGl.render(view.scene, eyeCam);
    },
  });

  const pick = (r: Rig) => {
    rig = r;
    for (const b of root.querySelectorAll("[data-rig]")) b.setAttribute("aria-pressed", String(b.getAttribute("data-rig") === r));
    $("[data-rigname]").textContent = r;
  };
  root.querySelectorAll<HTMLElement>("[data-rig]").forEach((b) => b.addEventListener("click", () => pick(b.dataset.rig as Rig)));
  $("[data-shake]").addEventListener("click", () => shake.kick(0.25));

  const lay = layout(root);
  // the built in sample: the group rig, and a shake
  const sample = async () => {
    pick("group");
    shake.kick(0.2);
    await sleep(800);
  };
  return {
    sample,
    dispose: () => {
      view.dispose();
      eye.dispose();
      eyeGl?.dispose();
      lay.dispose();
      host.innerHTML = "";
    },
  };
}
