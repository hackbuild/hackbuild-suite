// ask about a picture: a frame view with the answer as its caption, a rail
// of ready questions, a question field, and a model pick that loads a real
// vision language model in this tab (its size is on the load button). Until
// then the photo carries an answer written by hand, labelled as a sample.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { define, type FrameView, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}
type Ask = (image: unknown, question?: string) => Promise<string>;

// a cc0 photo (examples/samples/CREDITS.md), and an answer about it, written by hand
const PHOTO = new URL("../../samples/cat.jpg", import.meta.url).href;
const SAMPLE = "an orange cat lies on a stone wall beside a garden path and looks at you.";
const ICON = (d: string) => `<svg class="hb-icon is-stroke" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg>`;
const READY: Record<string, string> = {
  describe: "what is in this picture?",
  colours: "what colours do you see?",
  count: "how many animals are there?",
  where: "where is the cat?",
};

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="ready questions">
          <button type="button" class="hb-iconbtn" data-tool="describe" aria-label="say what is in it" title="say what is in it" aria-pressed="true">${ICON('<path d="M4 5h16v11H9l-5 4z"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="colours" aria-label="ask the colours" title="ask the colours" aria-pressed="false">${ICON('<circle cx="8" cy="9" r="4"/><circle cx="16" cy="9" r="4"/><circle cx="12" cy="16" r="4"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="count" aria-label="count the animals" title="count the animals" aria-pressed="false">${ICON('<path d="M5 6v12M10 6v12M15 6v12M3 15l16-6"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="where" aria-label="ask where the cat is" title="ask where the cat is" aria-pressed="false">${ICON('<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/>')}</button>
        </nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><frame-view empty="no picture yet."></frame-view></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="submit" form="see-ask" class="hb-btn hb-btn-go">ask</button></div>
        </section>
        <aside class="hb-rack" aria-label="ask">
          <nav class="hb-tabs" role="tablist" aria-label="ask tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">ask</button><button type="button" class="hb-tab" role="tab" aria-selected="false">asked</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">ask</div><p class="hb-note" data-out="label"></p>
            <form data-ask id="see-ask"><label class="hb-field"><span class="hb-label">your question</span><textarea class="hb-input" rows="3">what is in this picture?</textarea></label></form></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">asked</div><ol class="hb-list" data-out="asked"></ol></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">model</div><model-select job="vision"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the photo is cc0 from wikimedia commons. its answer is written by hand until a model is loaded; then every question goes to the model.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // every vision language model the catalogue knows, fitted to this machine;
  // jobLoader fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("vision", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("vision") ?? jobLoader("vision") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let ask: Ask | null = null;
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded" && s.loaded) ask = s.loaded as Ask;
  });

  const view = (root.querySelector("frame-view") as unknown as { view: FrameView }).view;
  const field = root.querySelector("textarea")!;
  const asked = root.querySelector('[data-out="asked"]')!;
  const label = root.querySelector('[data-out="label"]')!;
  const photo = new Image();
  photo.src = PHOTO;

  async function run(question: string): Promise<void> {
    field.value = question;
    let said: string;
    if (ask) {
      label.textContent = "";
      view.setResults({ caption: "looking." });
      await photo.decode();
      said = await ask(photo, question);
    } else {
      label.textContent = "sample, no model loaded. load one from the chip in the bar to ask your own question.";
      said = SAMPLE;
    }
    view.setResults({ caption: said });
    const li = document.createElement("li");
    li.textContent = `${question} ${said}`;
    asked.prepend(li);
  }
  root.querySelector("[data-ask]")!.addEventListener("submit", (e) => {
    e.preventDefault();
    if (field.value.trim()) void run(field.value.trim());
  });
  const lay = layout(root, { onTool: (t) => void run(READY[t] ?? READY.describe!) });
  const sample = async () => {
    await view.setSource(PHOTO);
    await run(READY.describe!);
  };
  void sample();
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
