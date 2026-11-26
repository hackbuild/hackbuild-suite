// depth from a photo: a depth model turns a photo into a map of how near
// each pixel is, and the map lifts the photo into a surface you can turn.
// The model pick loads a real depth model in this tab (its size is on the
// load button). Until then the map is a sample guessed from the rows of the
// photo, near at the foot and far at the top, labelled as one.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { define, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { depthHeight } from "@hackbuild/depth-mesh";
import { meshTurntable } from "@hackbuild/motion-views/vanilla";
import { depthToRgba } from "@hackbuild/vision";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import * as THREE from "three";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}
type Depth = { width: number; height: number; data: Float32Array };

// a cc0 photo (examples/samples/CREDITS.md)
const PHOTO = new URL("../../samples/street.jpg", import.meta.url).href;
const ICON = (d: string) => `<svg class="hb-icon is-stroke" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg>`;

// the sample: lower rows nearer, upper rows farther; no model reads the photo
function rowGuess(w: number, h: number): Depth {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) data.fill(Math.max(0, (y / h - 0.45) / 0.55) ** 1.5, y * w, y * w + w);
  return { width: w, height: h, data };
}

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="what to show">
          <button type="button" class="hb-iconbtn" data-tool="surface" aria-label="the surface" title="the surface" aria-pressed="true">${ICON('<path d="M3 17l6-6 4 3 8-8M3 21h18"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="map" aria-label="the depth map" title="the depth map" aria-pressed="false">${ICON('<rect x="3" y="5" width="18" height="14"/><path d="M3 12h18"/>')}</button>
        </nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><div data-out="stage" style="position:absolute;inset:0"></div><canvas data-out="map" hidden style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain"></canvas></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-act="open">open a photo</button><input type="file" accept="image/*" hidden></div>
        </section>
        <aside class="hb-rack" aria-label="depth">
          <nav class="hb-tabs" role="tablist" aria-label="depth tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">depth</button><button type="button" class="hb-tab" role="tab" aria-selected="false">surface</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">the depth map</div><p class="hb-note" data-out="label"></p><img data-out="photo" alt="the photo" style="width:100%"></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">surface</div><label class="hb-field"><span class="hb-label">how deep</span><input class="hb-range" type="range" min="2" max="40" value="18" data-depth></label></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">depth model</div><model-select job="depth"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the photo is cc0 from wikimedia commons. white is near, black is far. drag the surface to turn it.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // every depth model the catalogue knows, fitted to this machine; jobLoader
  // fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("depth", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("depth") ?? jobLoader("depth") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let model: ((image: unknown) => Promise<Depth>) | null = null;

  const table = meshTurntable(root.querySelector('[data-out="stage"]')!);
  const map = root.querySelector('[data-out="map"]') as HTMLCanvasElement;
  const label = root.querySelector('[data-out="label"]')!;
  const deep = root.querySelector("[data-depth]") as HTMLInputElement;
  let photo: HTMLCanvasElement | null = null;
  let depth: Depth | null = null;

  // the photo on a grid, each vertex lifted by its depth
  function lift(): void {
    if (!photo || !depth) return;
    const cols = 160;
    const rows = Math.round((cols * photo.height) / photo.width);
    const z = depthHeight(depth, cols, rows);
    const width = 60;
    const geo = new THREE.PlaneGeometry(width, (width * photo.height) / photo.width, cols - 1, rows - 1);
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, z[i]! * Number(deep.value));
    geo.computeVertexNormals();
    table.show(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(photo), roughness: 0.9, side: THREE.DoubleSide })));
    map.width = depth.width;
    map.height = depth.height;
    map.getContext("2d")!.putImageData(new ImageData(depthToRgba(depth) as Uint8ClampedArray<ArrayBuffer>, depth.width, depth.height), 0, 0);
  }
  async function see(src: string | Blob): Promise<void> {
    const bmp = await createImageBitmap(typeof src === "string" ? await (await fetch(src)).blob() : src);
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    photo = document.createElement("canvas");
    photo.width = Math.round(bmp.width * k);
    photo.height = Math.round(bmp.height * k);
    photo.getContext("2d")!.drawImage(bmp, 0, 0, photo.width, photo.height);
    (root.querySelector('[data-out="photo"]') as HTMLImageElement).src = photo.toDataURL("image/jpeg", 0.8);
    label.textContent = model ? "" : "sample, no model loaded. this map is a guess from the rows of the photo; load a model from the chip in the bar for a real one.";
    depth = model ? await model(photo) : rowGuess(160, Math.round((160 * photo.height) / photo.width));
    lift();
  }
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded" && s.loaded && model !== s.loaded) {
      model = s.loaded as typeof model;
      if (photo) void see(photo.toDataURL());
    }
  });
  const file = root.querySelector('input[type="file"]') as HTMLInputElement;
  file.addEventListener("change", () => file.files?.[0] && void see(file.files[0]));
  root.querySelector('[data-act="open"]')!.addEventListener("click", () => file.click());
  deep.addEventListener("input", lift);
  const lay = layout(root, {
    onTool: (t) => {
      map.hidden = t !== "map";
      (root.querySelector('[data-out="stage"]') as HTMLElement).hidden = t === "map";
    },
  });
  const sample = () => see(PHOTO);
  void sample();
  return { pick, sample, dispose: () => (off(), table.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
