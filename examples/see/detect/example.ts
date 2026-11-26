// find objects on the webcam: a frame view with what a detector found drawn
// over it, a camera feed that opens only on a press, and a model pick for
// the detector. Until a model is loaded a stand in finds the two things in
// the drawn sample, so the first visit shows boxes with no download.
import { boxWords, labelColour, useModelPick, type FrameBox } from "@hackbuild/ai-views";
import { define, mountCameraFeed, type FrameView, type ModelSelectElement } from "@hackbuild/ai-views/elements";
import type { Detector } from "@hackbuild/vision";
import { INSTANCE_COLOURS, layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, sampleCanvas, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { sampleDetector } from "../../shared/see.js";

const ICON = (d: string) => `<svg class="hb-icon is-stroke" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${d}</svg>`;

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-canvas-rail">
      <div class="hb-lay-body">
        <nav class="hb-lay-tools" aria-label="where the frame comes from">
          <button type="button" class="hb-iconbtn" data-tool="picture" aria-label="the sample picture" title="the sample picture" aria-pressed="true">${ICON('<rect x="3" y="5" width="18" height="14"/><path d="M3 16l5-5 4 4 3-3 6 6"/>')}</button>
          <button type="button" class="hb-iconbtn" data-tool="camera" aria-label="the camera" title="the camera" aria-pressed="false">${ICON('<rect x="3" y="7" width="13" height="10"/><path d="M16 11l5-3v8l-5-3"/>')}</button>
        </nav>
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><frame-view empty="no frame yet."></frame-view><div data-cam hidden></div></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-act="find">find things</button></div>
        </section>
        <aside class="hb-rack" aria-label="find">
          <nav class="hb-tabs" role="tablist" aria-label="find tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">found</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button><button type="button" class="hb-tab" role="tab" aria-selected="false">camera</button></nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">found</div><div data-out="found"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">detector</div><model-select job="detect"></model-select></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">camera</div><p class="hb-lay-empty-note" data-out="cam">camera off. it opens only when you press the camera on the left.</p></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: the sample is a drawing and the stand in detector knows only its cup and ball. a loaded model finds things in camera frames too.</p></div></details>
        </aside>
      </div>
    </div>`);

  const sample = sampleCanvas();
  // a real page passes weightsLoader(store) or a runtime loader that returns a Detector
  const pick = useModelPick("detect", { env: FIXTURE_ENV, loader: stubLoaderOf(sampleDetector(sample)) });
  (root.querySelector("model-select") as ModelSelectElement).pick = pick;
  let detector: Detector = sampleDetector(sample);
  const offPick = pick.subscribe((s) => { if (s.row?.state === "loaded" && s.loaded) detector = s.loaded as Detector; });

  const view = (root.querySelector("frame-view") as unknown as { view: FrameView }).view;
  // the camera opens only on a press; its video goes into the frame view
  const feed = mountCameraFeed(root.querySelector("[data-cam]")!, { fps: 4, tile: false });
  const found = root.querySelector('[data-out="found"]')!;
  let source: "picture" | "camera" = "picture";

  async function find(): Promise<void> {
    const frame = source === "camera" ? feed.video : sample;
    const hits = await detector.detect(frame, { scoreThreshold: 0.3 });
    const boxes: FrameBox[] = hits.map((d) => ({ label: d.label, score: d.score, ...d.box }));
    view.setResults({ boxes, tag: `${boxes.length} found` });
    found.innerHTML = boxes.length
      ? `<div class="hb-inst"><ul class="hb-inst-list">${boxes.map((b) => `<li class="hb-inst-row" style="--hb-inst-c:${labelColour(b.label, INSTANCE_COLOURS)}"><span class="hb-inst-pick"><span class="hb-inst-sw"></span><span class="hb-inst-name">${boxWords(b)}</span></span></li>`).join("")}</ul></div>`
      : `<p class="hb-lay-empty-note">nothing found. the stand in only knows the sample; load a detector from the chip to look at the camera.</p>`;
  }
  async function showPicture(): Promise<void> {
    if (feed.live) feed.stop();
    source = "picture";
    await view.setSource(sample);
    await find();
  }

  const offFeed = feed.subscribe((s) => {
    if (s.live) void view.setSource(feed.video);
    root.querySelector('[data-out="cam"]')!.textContent = s.error || (s.live ? "camera on. press find things to look at this frame." : "camera off.");
  });
  const lay = layout(root, {
    onTool: (t) => {
      if (t === "camera") { source = "camera"; void feed.start(); }
      else void showPicture();
    },
  });
  root.querySelector('[data-act="find"]')!.addEventListener("click", () => void find());
  void showPicture();
  return { pick, sample: showPicture, dispose: () => (feed.stop(), offFeed(), feed.dispose(), offPick(), lay.dispose(), (host.innerHTML = "")) };
}
