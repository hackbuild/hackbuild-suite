// text to image: a form shaped by the chosen model (steps, guidance when it
// takes one, seed) beside the frame. A loaded model runs the
// @hackbuild/imagegen pipeline; until then a stand in draws hills and a sun
// from the seed in code, so a first visit sees a picture with no download.
import { useModelPick } from "@hackbuild/ai-views";
import { define, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { IMAGEGEN_RECORDS, formOf, generate, mulberry32, sessionsOf, stubImagegenModel, type GenerateOptions, type ImagegenModel } from "@hackbuild/imagegen";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, stubLoaderOf, type Example } from "../../shared/fixtures.js";

// stands in for the clip tokenizer: one id per character
const tokenize = async (p: string) => Array.from(p.slice(0, 75), (c) => c.charCodeAt(0));
type Picture = { width: number; height: number; rgba: Uint8ClampedArray; seed: number };
type Make = (o: GenerateOptions) => Promise<Picture>;

// the stand in: hills and a sun placed by the seed, drawn in code
const standIn: Make = async (o) => {
  const rand = mulberry32(o.seed ?? 0);
  const c = new OffscreenCanvas(512, 512);
  const g = c.getContext("2d")!;
  g.fillStyle = `hsl(${Math.round(rand() * 360)} 45% 82%)`;
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = "#fe0386";
  g.beginPath();
  g.arc(80 + rand() * 350, 80 + rand() * 120, 30 + rand() * 40, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 3 + (o.steps ?? 1); i++) {
    g.fillStyle = `hsl(${90 + Math.round(rand() * 60)} 30% ${55 - i * 8}%)`;
    g.beginPath();
    g.moveTo(0, 512);
    for (let x = 0; x <= 512; x += 32) g.lineTo(x, 260 + i * 50 + Math.sin(x / (60 + rand() * 40) + rand() * 6) * 40);
    g.lineTo(512, 512);
    g.fill();
  }
  return { width: 512, height: 512, rgba: g.getImageData(0, 0, 512, 512).data, seed: o.seed ?? 0 };
};

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-form-frame">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><canvas data-out="frame" width="512" height="512" aria-label="the picture" style="max-width:100%;max-height:100%"></canvas></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-act="make">make it</button></div>
        </section>
        <aside class="hb-rack" aria-label="make an image">
          <nav class="hb-tabs" role="tablist" aria-label="image tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">make</button><button type="button" class="hb-tab" role="tab" aria-selected="false">made</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">make</div><form data-form>
            <label class="hb-field"><span class="hb-label">what to draw</span><textarea class="hb-input" rows="3" name="prompt">a ceramic mug on a wooden shelf, soft light</textarea></label>
            <label class="hb-field"><span class="hb-label" data-out="steps-label">steps</span><input class="hb-range" type="range" name="steps"></label>
            <label class="hb-field" data-guide><span class="hb-label">follow the words</span><input class="hb-range" type="range" name="guidance"></label>
            <label class="hb-field"><span class="hb-label">seed</span><input class="hb-input" type="number" inputmode="numeric" name="seed" value="42"></label>
            <p class="hb-note" data-out="took"></p>
          </form></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">made</div><div class="hb-tiles is-small" data-out="made"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">image model</div><model-select job="image"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: until a model is loaded the picture is drawn in code from the seed and the words are not read. a loaded model runs the real pipeline on the prompt.</p></div></details>
        </aside>
      </div>
    </div>`);

  // a real page passes a loader that downloads the graphs and returns an ImagegenModel
  const pick = useModelPick("image", { env: FIXTURE_ENV, loader: stubLoaderOf(stubImagegenModel()) });
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let make: Make = standIn;
  const form = root.querySelector("[data-form]") as HTMLFormElement;
  const field = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
  const canvas = root.querySelector('[data-out="frame"]') as HTMLCanvasElement;

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
    const m = s.row?.state === "loaded" ? (s.loaded as ImagegenModel | undefined) : undefined;
    if (m) make = (o) => generate(m.ort, sessionsOf(m, f), tokenize, o);
  });
  field("steps").addEventListener("input", () => (root.querySelector('[data-out="steps-label"]')!.textContent = `steps, ${field("steps").value}`));

  async function run(): Promise<void> {
    const t = performance.now();
    const out = await make({
      prompt: field("prompt").value,
      steps: Number(field("steps").value),
      seed: Number(field("seed").value),
      ...(f.guidance ? { guidance: Number(field("guidance").value) } : {}),
    });
    canvas.width = out.width;
    canvas.height = out.height;
    canvas.getContext("2d")!.putImageData(new ImageData(out.rgba as Uint8ClampedArray<ArrayBuffer>, out.width, out.height), 0, 0);
    root.querySelector('[data-out="took"]')!.textContent = `seed ${out.seed}, ${Math.round(performance.now() - t)} ms.`;
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
