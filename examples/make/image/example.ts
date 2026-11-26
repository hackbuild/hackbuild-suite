// text to image: a form shaped by the chosen model (steps, guidance when it
// takes one, seed) beside the picture, and a model pick that loads a real
// image model in this tab (its size is on the load button). Until then the
// picture is a sample drawn in code from the seed, labelled as one; it does
// not read the words.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { define, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { IMAGEGEN_RECORDS, formOf, mulberry32, type FormOptions } from "@hackbuild/imagegen";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}
type Picture = { width: number; height: number; rgba: Uint8ClampedArray };
type ImageModel = { make(o: FormOptions): Promise<Picture> };

// the sample: hills and a sun placed by the seed, drawn in code
function drawn(seed: number): Picture {
  const rand = mulberry32(seed);
  const c = new OffscreenCanvas(512, 512);
  const g = c.getContext("2d")!;
  g.fillStyle = `hsl(${Math.round(rand() * 360)} 45% 82%)`;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = "#fe0386";
  g.beginPath();
  g.arc(80 + rand() * 350, 80 + rand() * 120, 30 + rand() * 40, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 4; i++) {
    g.fillStyle = `hsl(${90 + Math.round(rand() * 60)} 30% ${55 - i * 8}%)`;
    g.beginPath();
    g.moveTo(0, 512);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, 260 + i * 50 + Math.sin(x / (60 + rand() * 40) + rand() * 6) * 40);
    g.lineTo(512, 512);
    g.fill();
  }
  return { width: 512, height: 512, rgba: g.getImageData(0, 0, 512, 512).data };
}

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><canvas data-out="frame" width="512" height="512" aria-label="the picture" style="position:absolute;inset:0;margin:auto;max-width:92%;max-height:84%"></canvas></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-act="make">make it</button></div>
        </section>
        <aside class="hb-rack" aria-label="make an image">
          <nav class="hb-tabs" role="tablist" aria-label="image tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">make</button><button type="button" class="hb-tab" role="tab" aria-selected="false">made</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">make</div><p class="hb-note" data-out="label"></p><form data-form>
            <label class="hb-field"><span class="hb-label">what to draw</span><textarea class="hb-input" rows="3" name="prompt">a ceramic mug on a wooden shelf, soft light</textarea></label>
            <label class="hb-field"><span class="hb-label" data-out="steps-label">steps</span><input class="hb-range" type="range" name="steps"></label>
            <label class="hb-field" data-guide><span class="hb-label">follow the words</span><input class="hb-range" type="range" name="guidance"></label>
            <label class="hb-field"><span class="hb-label">seed</span><input class="hb-input" type="number" inputmode="numeric" name="seed" value="42"></label>
          </form></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">made</div><div class="hb-tiles is-small" data-out="made"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">image model</div><model-select job="image"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">a loaded model runs the image pipeline on your words in this tab; nothing is sent anywhere.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // every image model the catalogue knows, fitted to this machine; jobLoader
  // fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("image", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("image") ?? jobLoader("image") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let model: ImageModel | null = null;
  const form = root.querySelector("[data-form]") as HTMLFormElement;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const canvas = root.querySelector('[data-out="frame"]') as HTMLCanvasElement;
  const label = root.querySelector('[data-out="label"]')!;

  // the form follows the chosen model: its step range, and guidance only when it takes it
  const shape = () => {
    const f = formOf(pick.record(pick.snapshot().chosen)) ?? formOf(IMAGEGEN_RECORDS[0])!;
    Object.assign(field("steps"), { min: f.steps.min, max: f.steps.max, value: String(f.steps.default) });
    (root.querySelector("[data-guide]") as HTMLElement).hidden = !f.guidance;
    if (f.guidance) Object.assign(field("guidance"), { min: f.guidance.min, max: f.guidance.max, step: f.guidance.step, value: String(f.guidance.default) });
    root.querySelector('[data-out="steps-label"]')!.textContent = `steps, ${field("steps").value}`;
    return f;
  };
  let f = shape();
  const off = pick.subscribe((s) => {
    f = shape();
    if (s.row?.state === "loaded" && s.loaded) model = s.loaded as ImageModel;
  });
  field("steps").addEventListener("input", () => (root.querySelector('[data-out="steps-label"]')!.textContent = `steps, ${field("steps").value}`));

  async function run(): Promise<void> {
    const seed = Number(field("seed").value);
    label.textContent = model ? "" : "sample, no model loaded. this picture is drawn in code from the seed; load a model from the chip in the bar to draw your words.";
    const out = model
      ? await model.make({ prompt: field("prompt").value, steps: Number(field("steps").value), seed, ...(f.guidance ? { guidance: Number(field("guidance").value) } : {}) })
      : drawn(seed);
    canvas.width = out.width;
    canvas.height = out.height;
    canvas.getContext("2d")!.putImageData(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
    if (!model) return;
    const thumb = new Image();
    thumb.src = canvas.toDataURL();
    thumb.alt = field("prompt").value;
    root.querySelector('[data-out="made"]')!.prepend(thumb);
  }
  form.addEventListener("submit", (e) => (e.preventDefault(), void run()));
  root.querySelector('[data-act="make"]')!.addEventListener("click", () => void run());
  const lay = layout(root);
  void run();
  return { pick, sample: run, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
