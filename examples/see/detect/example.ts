// find objects on the webcam: a frame view with what a detector found drawn
// over it, a camera that opens only on a press, and a model pick that loads
// a real detector in this tab (its size is on the load button). Until then
// the photo shows boxes written by hand, labelled as a sample.
import { probe, type Env } from "@hackbuild/ai-env";
import { boxWords, jobLoader, labelColour, useModelPick, type FrameBox, type Job, type Loader } from "@hackbuild/ai-views";
import { define, mountCameraFeed, type FrameView, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import { INSTANCE_COLOURS, layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}
type Detect = (image: unknown) => Promise<FrameBox[]>;

// a cc0 photo (examples/samples/CREDITS.md), and what a detector finds in it, written by hand
const PHOTO = new URL("../../samples/cat.jpg", import.meta.url).href;
const SAMPLE: FrameBox[] = [{ label: "cat", score: 0.93, x: 208, y: 268, w: 326, h: 308 }];
const ICON = (d: string) => `<svg class="hb-icon is-stroke" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg>`;

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="where the frame comes from">
          <button type="button" class="hb-iconbtn" data-tool="picture" aria-label="the photo" title="the photo" aria-pressed="true">${ICON('<rect x="3" y="5" width="18" height="14"/><path d="M3 16l5-5 4 4 3-3 6 6"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="camera" aria-label="the camera" title="the camera" aria-pressed="false">${ICON('<rect x="3" y="7" width="13" height="10"/><path d="M16 11l5-3v8l-5-3"/>')}</button>
        </nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><frame-view empty="no frame yet."></frame-view><div data-cam hidden></div></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-act="find">find things</button></div>
        </section>
        <aside class="hb-rack" aria-label="find">
          <nav class="hb-tabs" role="tablist" aria-label="find tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">found</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button><button type="button" class="hb-tab" role="tab" aria-selected="false">camera</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">found</div><p class="hb-note" data-out="label"></p><div data-out="found"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">detector</div><model-select job="detect"></model-select></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">camera</div><p class="hb-lay-empty-note" data-out="cam">camera off. it opens only when you press the camera on the left.</p></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the photo is cc0 from wikimedia commons. its boxes are written by hand until a detector is loaded; then every frame goes to the model.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // every detector the catalogue knows, fitted to this machine; jobLoader
  // fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("detect", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("detect") ?? jobLoader("detect") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let detect: Detect | null = null;

  const view = (root.querySelector("frame-view") as unknown as { view: FrameView }).view;
  const feed = mountCameraFeed(root.querySelector("[data-cam]")!, { fps: 4, tile: false });
  const found = root.querySelector('[data-out="found"]')!;
  const label = root.querySelector('[data-out="label"]')!;
  const photo = new Image();
  photo.src = PHOTO;
  let source: "picture" | "camera" = "picture";

  function show(boxes: FrameBox[], tag: string): void {
    view.setResults({ boxes, tag });
    found.innerHTML = boxes.length
      ? `<div class="hb-inst"><ul class="hb-inst-list">${boxes.map((b) => `<li class="hb-inst-row" style="--hb-inst-c:${labelColour(b.label ?? "", INSTANCE_COLOURS)}"><span class="hb-inst-pick"><span class="hb-inst-sw"></span><span class="hb-inst-name">${boxWords(b)}</span></span></li>`).join("")}</ul></div>`
      : `<p class="hb-lay-empty-note">nothing found.</p>`;
  }
  async function find(): Promise<void> {
    if (!detect) {
      if (source === "camera") return void (label.textContent = "no model loaded. load a detector from the chip in the bar to look at the camera.");
      label.textContent = "sample, no model loaded";
      return show(SAMPLE, "sample");
    }
    label.textContent = "";
    if (source === "picture") await photo.decode();
    const boxes = await detect(source === "camera" ? feed.video : photo);
    show(boxes, `${boxes.length} found`);
  }
  async function showPicture(): Promise<void> {
    if (feed.live) feed.stop();
    source = "picture";
    await view.setSource(PHOTO);
    await find();
  }

  const offPick = pick.subscribe((s) => {
    if (s.row?.state === "loaded" && s.loaded && detect !== s.loaded) {
      detect = s.loaded as Detect;
      void find();
    }
  });
  const offFeed = feed.subscribe((s) => {
    if (s.live) void view.setSource(feed.video);
    root.querySelector('[data-out="cam"]')!.textContent = s.error || (s.live ? "camera on. press find things to look at this frame." : "camera off.");
  });
  const lay = layout(root, {
    onTool: (t) => {
      if (t === "camera") (source = "camera"), void feed.start();
      else void showPicture();
    },
  });
  root.querySelector('[data-act="find"]')!.addEventListener("click", () => void find());
  void showPicture();
  return { pick, sample: showPicture, dispose: () => (feed.stop(), offFeed(), feed.dispose(), offPick(), lay.dispose(), (host.innerHTML = "")) };
}
