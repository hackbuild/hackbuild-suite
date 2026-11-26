// cut out a subject with a click: the mask studio with its tool rail and
// rack, and a model pick for the click segment model. Undo and zoom sit in
// the mask tab so the canvas stays calm. Until a model is loaded stand ins
// that know the drawn sample answer, and the cup is cut out already, so a
// first visit sees a mask with no download.
import { useModelPick } from "@hackbuild/ai-views";
import { define, type MaskModels, type MaskStudio } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, SAMPLE_THINGS, draw, insideThing, maskOf, sampleCanvas, sleep, stubLoaderOf, type Example } from "../../shared/fixtures.js";

// press inside a thing of the sample and get its mask; find every object gives both
const stand: MaskModels = {
  segment: async (img, p) => {
    await sleep(120);
    const t = SAMPLE_THINGS.find((s) => insideThing(s, p.x, p.y));
    return t ? maskOf(img.width, img.height, (x, y) => insideThing(t, x, y)) : null;
  },
  everything: async (img) => SAMPLE_THINGS.map((t) => ({ label: t.label, score: t.score, mask: maskOf(img.width, img.height, (x, y) => insideThing(t, x, y)) })),
};

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="tools"><mask-tools for="see-cut"></mask-tools></nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><mask-studio id="see-cut" sample-label="try the sample"></mask-studio></div>
        </section>
        <aside class="hb-rack" aria-label="cut out">
          <nav class="hb-tabs" role="tablist" aria-label="cut out tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">found</button><button type="button" class="hb-tab" role="tab" aria-selected="false">mask</button><button type="button" class="hb-tab" role="tab" aria-selected="false">saved</button><button type="button" class="hb-tab" role="tab" aria-selected="false">export</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">found</div><mask-rack for="see-cut" part="found"></mask-rack></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">mask</div><mask-rack for="see-cut" part="mask"></mask-rack><div class="hb-toolbar" role="toolbar" aria-label="undo and zoom"><mask-verbs for="see-cut"></mask-verbs></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">saved masks</div><mask-rack for="see-cut" part="saved"></mask-rack></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">export</div><mask-rack for="see-cut" part="export"></mask-rack></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: the sample is a drawing and the cut and find models are stand ins that know its two shapes. a loaded model cuts any picture you drop.</p></div></details>
        </aside>
      </div>
    </div>`);

  const el = root.querySelector("mask-studio") as unknown as HTMLElement & { studio: MaskStudio; models: MaskModels };
  el.models = stand;
  // a real page passes weightsLoader(store) or a runtime loader that returns MaskModels
  const pick = useModelPick("masks", { env: FIXTURE_ENV, loader: stubLoaderOf(stand) });
  const off = pick.subscribe((s) => { if (s.row?.state === "loaded" && s.loaded) el.studio.setModels(s.loaded as MaskModels); });

  // the sample, with the cup already cut out: a press in its middle
  const sample = async () => {
    await el.studio.setImage(sampleCanvas());
    await el.studio.cutAt(400, 335);
  };
  el.addEventListener("sample", () => void sample());
  const lay = layout(root);
  void sample();
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
