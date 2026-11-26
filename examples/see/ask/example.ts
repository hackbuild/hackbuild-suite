// ask about a picture: a frame view with the answer as its caption, a rail
// of ready questions, a question field, and a model pick for the vision
// language model. Until a model is loaded a stand in answers about the
// drawn sample, so a first visit reads an answer with no download. The
// answer is the caption under the picture.
import { useModelPick } from "@hackbuild/ai-views";
import { define, type FrameView, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import type { Vlm } from "@hackbuild/vision";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, sampleCanvas, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { sampleVlm } from "../../shared/see.js";

const ICON = (d: string) => `<svg class="hb-icon is-stroke" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg>`;
const READY: Record<string, string> = {
  describe: "what is in this picture?",
  colours: "what colours are the things?",
  count: "how many things are there?",
  where: "where is the ball?",
};

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="ready questions">
          <button type="button" class="hb-iconbtn" data-tool="describe" aria-label="say what is in it" title="say what is in it" aria-pressed="true">${ICON('<path d="M4 5h16v11H9l-5 4z"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="colours" aria-label="ask the colours" title="ask the colours" aria-pressed="false">${ICON('<circle cx="8" cy="9" r="4"/><circle cx="16" cy="9" r="4"/><circle cx="12" cy="16" r="4"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="count" aria-label="count the things" title="count the things" aria-pressed="false">${ICON('<path d="M5 6v12M10 6v12M15 6v12M3 15l16-6"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="where" aria-label="ask where the ball is" title="ask where the ball is" aria-pressed="false">${ICON('<circle cx="12" cy="10" r="3"/><path d="M12 21s-7-6-7-11a7 7 0 0 1 14 0c0 5-7 11-7 11z"/>')}</button>
        </nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><frame-view empty="no picture yet."></frame-view></div>
        </section>
        <aside class="hb-rack" aria-label="ask">
          <nav class="hb-tabs" role="tablist" aria-label="ask tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">ask</button><button type="button" class="hb-tab" role="tab" aria-selected="false">asked</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">ask</div>
            <form data-ask class="hb-stack"><label class="hb-field"><span class="hb-label">your question</span><textarea class="hb-input" rows="3">what is in this picture?</textarea></label><button type="submit" class="hb-btn hb-btn-go">ask</button></form></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">asked</div><ol class="hb-list" data-out="asked"></ol></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">model</div><model-select job="vision"></model-select></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: the sample is a drawing and the stand in answers a few questions about it. a loaded model answers about any picture.</p></div></details>
        </aside>
      </div>
    </div>`);

  const picture = sampleCanvas();
  // a real page passes weightsLoader(store) or a runtime loader that returns a Vlm
  const pick = useModelPick("vision", { env: FIXTURE_ENV, loader: stubLoaderOf(sampleVlm) });
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let vlm: Vlm = sampleVlm;
  const off = pick.subscribe((s) => { if (s.row?.state === "loaded" && s.loaded) vlm = s.loaded as Vlm; });

  const view = (root.querySelector("frame-view") as unknown as { view: FrameView }).view;
  const field = root.querySelector("textarea")!;
  const asked = root.querySelector('[data-out="asked"]')!;
  async function ask(question: string): Promise<void> {
    field.value = question;
    view.setResults({ caption: "looking." });
    const said = await vlm.ask(picture, question, { maxTokens: 64 });
    view.setResults({ caption: said });
    const li = document.createElement("li");
    li.textContent = `${question} ${said}`;
    asked.prepend(li);
  }
  root.querySelector("[data-ask]")!.addEventListener("submit", (e) => {
    e.preventDefault();
    if (field.value.trim()) void ask(field.value.trim());
  });
  const lay = layout(root, { onTool: (t) => void ask(READY[t] ?? READY.describe!) });
  const sample = async () => {
    await view.setSource(picture);
    await ask(READY.describe!);
  };
  void sample();
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
