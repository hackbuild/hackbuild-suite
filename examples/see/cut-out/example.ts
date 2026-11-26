// cut out a subject with a click: the mask studio with its tool rail and
// rack, and a model pick that loads a real click segment model in this tab
// (its size is on the load button). Until then the dog in the photo is cut
// out by a mask drawn by hand, labelled as a sample; the hand tools work on
// any picture with no model.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { define, type MaskModels, type MaskStudio } from "@hackbuild/ai-views/elements";
import { layout, polygonFill } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

// a cc0 photo (examples/samples/CREDITS.md), 800 by 533, and the dog in it, outlined by hand
const PHOTO = new URL("../../samples/dog.jpg", import.meta.url).href;
const DOG = [
  [315, 112], [333, 79], [367, 71], [392, 79], [433, 58], [467, 67], [479, 83], [500, 138], [529, 146], [527, 171], [508, 188], [470, 203],
  [500, 167], [550, 162], [588, 208], [612, 238], [588, 250], [588, 275], [521, 279], [467, 342], [442, 392], [333, 467], [288, 482], [250, 479],
  [242, 462], [275, 450], [325, 408], [283, 400], [229, 467], [204, 471], [202, 450], [250, 392], [279, 350], [275, 275], [271, 208], [300, 183], [313, 142],
].map(([x, y]) => ({ x: x!, y: y! }));

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="tools"><mask-tools for="see-cut"></mask-tools></nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><mask-studio id="see-cut"></mask-studio></div>
          <div class="hb-lay-inset hb-panel" data-out="label"><p class="hb-note">sample, no model loaded. the mask is drawn by hand.</p></div>
        </section>
        <aside class="hb-rack" aria-label="cut out">
          <nav class="hb-tabs" role="tablist" aria-label="cut out tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">found</button><button type="button" class="hb-tab" role="tab" aria-selected="false">mask</button><button type="button" class="hb-tab" role="tab" aria-selected="false">saved</button><button type="button" class="hb-tab" role="tab" aria-selected="false">export</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">found</div><mask-rack for="see-cut" part="found"></mask-rack></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">mask</div><mask-rack for="see-cut" part="mask"></mask-rack><div class="hb-toolbar" role="toolbar" aria-label="undo and zoom"><mask-verbs for="see-cut"></mask-verbs></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">saved masks</div><mask-rack for="see-cut" part="saved"></mask-rack></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">export</div><mask-rack for="see-cut" part="export"></mask-rack></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the photo is cc0 from wikimedia commons. until a model is loaded a press on the dog gives the hand drawn mask; a loaded model cuts any picture you drop.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const el = root.querySelector("mask-studio") as unknown as HTMLElement & { studio: MaskStudio };
  const label = root.querySelector('[data-out="label"]') as HTMLElement;

  // before a model: a press on the sample photo gives the hand drawn dog, nothing else
  let onSample = true;
  const handDrawn: MaskModels = {
    segment: async (img) => (onSample ? polygonFill(img.width, img.height, DOG) : null),
    everything: async (img) => (onSample ? [{ label: "dog, drawn by hand", score: 1, mask: polygonFill(img.width, img.height, DOG) }] : []),
  };
  el.studio.setModels(handDrawn);

  // every mask model the catalogue knows, fitted to this machine; jobLoader
  // fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("masks", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("masks") ?? jobLoader("masks") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  const off = pick.subscribe((s) => {
    if (s.row?.state !== "loaded" || !s.loaded) return;
    el.studio.setModels(s.loaded as MaskModels);
    label.hidden = true;
  });
  // a picture of your own is never cut by the hand drawn mask
  const offState = el.studio.subscribe((s) => {
    if (s.width && (s.width !== 800 || s.height !== 533)) onSample = false;
  });

  const sample = async () => {
    onSample = true;
    await el.studio.setImage(PHOTO);
    await el.studio.cutAt(400, 300);
  };
  el.addEventListener("sample", () => void sample());
  const lay = layout(root);
  void sample();
  return { pick, sample, dispose: () => (off(), offState(), lay.dispose(), (host.innerHTML = "")) };
}
