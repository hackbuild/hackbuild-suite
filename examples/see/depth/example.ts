// depth from a photo: a depth model turns a photo into a map of how near
// each pixel is, and the map lifts the photo into a surface you can turn.
// Until a model is loaded a stand in knows the drawn sample, so a first
// visit turns a surface with no download.
import { useModelPick } from "@hackbuild/ai-views";
import { define, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { depthHeight } from "@hackbuild/depth-mesh";
import { depthToRgba, rampDepth, type DepthMap, type DepthModel } from "@hackbuild/vision";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import * as THREE from "three";
import { FIXTURE_ENV, draw, sampleCanvas, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { sampleDepth, turntable } from "../../shared/see.js";

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" data-out="stage"></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions">
            <button type="button" class="hb-btn hb-btn-go" data-act="open">open a photo</button><input type="file" accept="image/*" hidden>
            <button type="button" class="hb-btn" data-act="sample">the sample</button>
          </div>
        </section>
        <aside class="hb-rack" aria-label="depth">
          <nav class="hb-tabs" role="tablist" aria-label="depth tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">depth</button><button type="button" class="hb-tab" role="tab" aria-selected="false">surface</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">the depth map</div><canvas data-out="map" style="width:100%"></canvas><p class="hb-note" data-out="note">white is near, black is far. drag the surface to turn it.</p></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">surface</div><label class="hb-field"><span class="hb-label">how deep</span><input class="hb-range" type="range" min="2" max="40" value="18" data-depth></label></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">depth model</div><model-select job="depth"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: the sample is a drawing and its depth comes from a stand in that knows it. another photo gets a plain ramp until a depth model is loaded.</p></div></details>
        </aside>
      </div>
    </div>`);

  // a real page passes weightsLoader(store) or a runtime loader that returns a DepthModel
  const pick = useModelPick("depth", { env: FIXTURE_ENV, loader: stubLoaderOf(sampleDepth) });
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let model: DepthModel | null = null;
  const off = pick.subscribe((s) => { if (s.row?.state === "loaded" && s.loaded) model = s.loaded as DepthModel; });

  const stage = turntable(root.querySelector('[data-out="stage"]')!);
  const map = root.querySelector('[data-out="map"]') as HTMLCanvasElement;
  const deep = root.querySelector("[data-depth]") as HTMLInputElement;
  let last: { photo: HTMLCanvasElement; depth: DepthMap } | null = null;

  // the photo on a grid, each vertex lifted by its depth
  function lift(photo: HTMLCanvasElement, depth: DepthMap): void {
    last = { photo, depth };
    const cols = 160;
    const rows = Math.round((cols * photo.height) / photo.width);
    const z = depthHeight(depth, cols, rows);
    const width = 80;
    const geo = new THREE.PlaneGeometry(width, (width * photo.height) / photo.width, cols - 1, rows - 1);
    const pos = geo.attributes.position!;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, z[i]! * Number(deep.value));
    geo.computeVertexNormals();
    stage.show(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: new THREE.CanvasTexture(photo), roughness: 0.9, side: THREE.DoubleSide })));
    map.width = depth.width;
    map.height = depth.height;
    map.getContext("2d")!.putImageData(new ImageData(depthToRgba(depth) as Uint8ClampedArray<ArrayBuffer>, depth.width, depth.height), 0, 0);
  }
  async function see(photo: HTMLCanvasElement, known: boolean): Promise<void> {
    const m = model ?? (known ? sampleDepth : rampDepth());
    lift(photo, await m.estimate(photo));
  }
  const sample = () => see(sampleCanvas(), true);
  root.querySelector('input[type="file"]')!.addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    await see(c, false);
  });
  root.querySelector('[data-act="open"]')!.addEventListener("click", () => (root.querySelector('input[type="file"]') as HTMLInputElement).click());
  root.querySelector('[data-act="sample"]')!.addEventListener("click", () => void sample());
  deep.addEventListener("input", () => last && lift(last.photo, last.depth));
  const lay = layout(root);
  void sample();
  return { pick, sample, dispose: () => (off(), stage.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
