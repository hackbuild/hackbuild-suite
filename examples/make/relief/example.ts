// photo to relief: a photo, its depth map and @hackbuild/depth-mesh make a
// closed solid you can turn and save as an stl to print. The model pick
// loads a real depth model in this tab (its size is on the load button).
// Until then the dog is puffed up from an outline drawn by hand, labelled
// as a sample; brightness needs no model for a photo of your own.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { define, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { loadDepthMesh, openEdges, photoRelief, toStl, type HeightSourceName, type Mesh } from "@hackbuild/depth-mesh";
import { DEPTH_MESH_WASM_BASE64 } from "@hackbuild/depth-mesh/inline";
import { meshTurntable } from "@hackbuild/motion-views/vanilla";
import { layout, polygonFill } from "@virgilvox/hackbuild-ui/vanilla";
import * as THREE from "three";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}
type Depth = (image: unknown) => Promise<{ width: number; height: number; data: Float32Array }>;

// a cc0 photo (examples/samples/CREDITS.md), 800 by 533, and the dog in it, outlined by hand
const PHOTO = new URL("../../samples/dog.jpg", import.meta.url).href;
const DOG = [
  [315, 112], [333, 79], [367, 71], [392, 79], [433, 58], [467, 67], [479, 83], [500, 138], [529, 146], [527, 171], [508, 188], [470, 203],
  [500, 167], [550, 162], [588, 208], [612, 238], [588, 250], [588, 275], [521, 279], [467, 342], [442, 392], [333, 467], [288, 482], [250, 479],
  [242, 462], [275, 450], [325, 408], [283, 400], [229, 467], [204, 471], [202, 450], [250, 392], [279, 350], [275, 275], [271, 208], [300, 183], [313, 142],
].map(([x, y]) => ({ x: x!, y: y! }));

function cutAlpha(img: ImageData): ImageData {
  const out = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  const inside = polygonFill(img.width, img.height, DOG);
  for (let i = 0; i < inside.length; i++) out.data[i * 4 + 3] = inside[i] ? 255 : 0;
  return out;
}

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" data-out="stage"></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions">
            <button type="button" class="hb-btn hb-btn-go" data-act="stl">save the stl</button>
            <button type="button" class="hb-btn" data-act="open">open a photo</button><input type="file" accept="image/*" hidden>
          </div>
        </section>
        <aside class="hb-rack" aria-label="relief">
          <nav class="hb-tabs" role="tablist" aria-label="relief tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">relief</button><button type="button" class="hb-tab" role="tab" aria-selected="false">shape</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">the relief</div><p class="hb-note" data-out="label"></p><div data-out="facts"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">shape</div><form data-shape>
            <label class="hb-field"><span class="hb-label">tallest, mm</span><input class="hb-range" type="range" name="height" min="0.6" max="6" step="0.2" value="2.4"></label>
            <label class="hb-field"><span class="hb-label">base, mm</span><input class="hb-range" type="range" name="base" min="0.2" max="2" step="0.1" value="0.4"></label>
            <label class="hb-field"><span class="hb-label">width, mm</span><input class="hb-range" type="range" name="width" min="20" max="120" step="5" value="60"></label>
          </form></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">depth model</div><model-select job="depth"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the photo is cc0 from wikimedia commons. drag the relief to turn it; the stl is in millimetres, ready to slice.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // every depth model the catalogue knows, fitted to this machine; jobLoader
  // fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("depth", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("depth") ?? jobLoader("depth") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let depth: Depth | null = null;

  const table = meshTurntable(root.querySelector('[data-out="stage"]')!);
  const shape = root.querySelector("[data-shape]") as HTMLFormElement;
  const val = (n: string) => Number((shape.elements.namedItem(n) as HTMLInputElement).value);
  const label = root.querySelector('[data-out="label"]')!;
  const core = loadDepthMesh({ base64: DEPTH_MESH_WASM_BASE64 });
  let photo: ImageData | null = null;
  let onSample = true;
  let mesh: Mesh | null = null;

  async function build(): Promise<void> {
    if (!photo) return;
    // a depth model when one is loaded; else the hand drawn dog for the sample, brightness for yours
    const source: HeightSourceName = depth ? "depth" : onSample ? "inflate" : "brightness";
    label.textContent = depth ? "" : onSample ? "sample, no model loaded. the dog is puffed up from an outline drawn by hand." : "height from brightness. load a depth model from the chip in the bar for real depth.";
    // the sample: the photo with the hand drawn dog as its alpha, which the puffed outline reads
    const image = onSample && !depth ? cutAlpha(photo) : photo;
    const r = await photoRelief(await core, image, {
      source,
      ...(depth ? { depth: depth as (img: unknown) => ReturnType<Depth> } : {}),
      height: val("height"),
      base: val("base"),
      width: val("width"),
      cells: 160,
    });
    mesh = r.mesh;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(r.mesh.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(r.mesh.indices, 1));
    geo.computeVertexNormals();
    table.show(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.7 })));
    const open = openEdges(r.mesh.indices);
    root.querySelector('[data-out="facts"]')!.innerHTML = [
      ["height from", source === "inflate" ? "puffed outline" : source],
      ["size", `${val("width")} mm across`],
      ["triangles", String(r.mesh.indices.length / 3)],
      ["solid", open ? `no, ${open} open edges` : "yes, ready to slice"],
    ].map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${k}</span><span class="hb-readout">${v}</span></div>`).join("");
  }
  async function open(src: Blob, sample: boolean): Promise<void> {
    const bmp = await createImageBitmap(src);
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const c = new OffscreenCanvas(Math.round(bmp.width * k), Math.round(bmp.height * k));
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    photo = c.getContext("2d")!.getImageData(0, 0, c.width, c.height);
    onSample = sample;
    await build();
  }
  const sample = async () => open(await (await fetch(PHOTO)).blob(), true);
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded" && s.loaded && depth !== s.loaded) (depth = s.loaded as Depth), void build();
  });
  const file = root.querySelector('input[type="file"]') as HTMLInputElement;
  root.querySelector('[data-act="open"]')!.addEventListener("click", () => file.click());
  file.addEventListener("change", () => file.files?.[0] && void open(file.files[0], false));
  shape.addEventListener("change", () => void build());
  root.querySelector('[data-act="stl"]')!.addEventListener("click", () => {
    if (!mesh) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([toStl(mesh) as Uint8Array<ArrayBuffer>], { type: "model/stl" }));
    a.download = "relief.stl";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const lay = layout(root);
  void sample();
  return { pick, sample, dispose: () => (off(), table.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
