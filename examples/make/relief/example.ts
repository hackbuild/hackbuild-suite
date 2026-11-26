// photo to relief: a photo, its depth map and @hackbuild/depth-mesh make a
// closed solid you can turn and save as an stl to print. Until a depth
// model is loaded a stand in knows the drawn sample, so a first visit turns
// a relief with no download; brightness and a puffed outline need no model.
import { useModelPick } from "@hackbuild/ai-views";
import { define, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { loadDepthMesh, openEdges, photoRelief, toStl, type HeightSourceName, type Mesh } from "@hackbuild/depth-mesh";
import { DEPTH_MESH_WASM_BASE64 } from "@hackbuild/depth-mesh/inline";
import type { DepthModel } from "@hackbuild/vision";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import * as THREE from "three";
import { FIXTURE_ENV, draw, sampleCanvas, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { pixelsOf, sampleDepth, turntable } from "../../shared/see.js";

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
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
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">the relief</div><div data-out="facts"></div><p class="hb-note" data-out="note">drag to turn it.</p></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">shape</div><form data-shape>
            <label class="hb-field"><span class="hb-label">height from</span><select class="hb-select" name="source"><option value="depth">depth</option><option value="brightness">brightness</option><option value="inflate">puffed outline</option></select></label>
            <label class="hb-field"><span class="hb-label">tallest, mm</span><input class="hb-range" type="range" name="height" min="0.6" max="6" step="0.2" value="2.4"></label>
            <label class="hb-field"><span class="hb-label">base, mm</span><input class="hb-range" type="range" name="base" min="0.2" max="2" step="0.1" value="0.4"></label>
            <label class="hb-field"><span class="hb-label">width, mm</span><input class="hb-range" type="range" name="width" min="20" max="120" step="5" value="60"></label>
          </form></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">depth model</div><model-select job="depth"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: the sample is a drawing and its depth comes from a stand in that knows it. another photo uses brightness until a depth model is loaded.</p></div></details>
        </aside>
      </div>
    </div>`);

  // a real page passes weightsLoader(store) or a runtime loader that returns a DepthModel
  const pick = useModelPick("depth", { env: FIXTURE_ENV, loader: stubLoaderOf(sampleDepth) });
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let model: DepthModel | null = null;
  const off = pick.subscribe((s) => { if (s.row?.state === "loaded" && s.loaded) model = s.loaded as DepthModel; });

  const stage = turntable(root.querySelector('[data-out="stage"]')!);
  const shape = root.querySelector("[data-shape]") as HTMLFormElement;
  const val = (n: string) => (shape.elements.namedItem(n) as HTMLInputElement).value;
  const core = loadDepthMesh({ base64: DEPTH_MESH_WASM_BASE64 });
  let photo = sampleCanvas();
  let known = true;
  let mesh: Mesh | null = null;

  async function build(): Promise<void> {
    const dm = await core;
    const depth = model ?? (known ? sampleDepth : null);
    const source = (val("source") === "depth" && !depth ? "brightness" : val("source")) as HeightSourceName;
    const r = await photoRelief(dm, pixelsOf(photo), {
      source,
      ...(depth ? { depth: async (img: unknown) => depth.estimate(img) } : {}),
      height: Number(val("height")),
      base: Number(val("base")),
      width: Number(val("width")),
      cells: 160,
    });
    mesh = r.mesh;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(r.mesh.positions, 3));
    geo.setIndex(new THREE.BufferAttribute(r.mesh.indices, 1));
    geo.computeVertexNormals();
    stage.show(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xc8b89a, roughness: 0.7 })));
    const open = openEdges(r.mesh.indices);
    root.querySelector('[data-out="facts"]')!.innerHTML = [
      ["height from", r.source === "inflate" ? "puffed outline" : r.source],
      ["size", `${val("width")} mm across`],
      ["triangles", String(r.mesh.indices.length / 3)],
      ["solid", open ? `no, ${open} open edges` : "yes, ready to slice"],
    ].map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${k}</span><span class="hb-readout">${v}</span></div>`).join("");
    root.querySelector('[data-out="note"]')!.textContent = r.notes.map((n) => n[1]).join(" ") || "drag to turn it.";
  }
  const sample = async () => {
    photo = sampleCanvas();
    known = true;
    await build();
  };
  const file = root.querySelector('input[type="file"]') as HTMLInputElement;
  root.querySelector('[data-act="open"]')!.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    photo = document.createElement("canvas");
    photo.width = Math.round(bmp.width * k);
    photo.height = Math.round(bmp.height * k);
    photo.getContext("2d")!.drawImage(bmp, 0, 0, photo.width, photo.height);
    known = false;
    await build();
  });
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
  return { pick, sample, dispose: () => (off(), stage.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
