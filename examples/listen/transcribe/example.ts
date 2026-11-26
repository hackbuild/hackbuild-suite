// transcribe a file: the drop zone is the page until a file is in it, then
// the transcript is. Files queue and run one at a time; lines carry their
// time, edit in place with undo, and export once there is text. Until a
// model is loaded a script stands in, so the sample works on a first visit.
import { transcribeQueue, useModelPick, type Transcriber } from "@hackbuild/ai-views";
import { mountModelSelect, mountTranscribeDrop, mountTranscribeQueue, mountTranscriptExports } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, sleep, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { sampleRecording } from "../../shared/listen.js";

// stands in for a speech model: any file becomes these lines
const LINES = ["pixel, sit. good dog.", "now the red ball, the one under the bench.", "he goes left every time, so the gate is fine there.", "drop it. drop it. good."];
const script: Transcriber = async (_file, ctx) => {
  for (let f = 0.25; f <= 1; f += 0.25) {
    await sleep(150);
    ctx.onProgress(f);
  }
  return { segments: LINES.map((text, i) => ({ start: i * 4.2, end: i * 4.2 + 3.6, text })), duration: 17, language: "en" };
};

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-drop-first">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" data-part="drop"></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions" hidden><button type="button" class="hb-btn" data-part="add">add files</button></div>
        </section>
        <aside class="hb-rack" aria-label="transcribe">
          <nav class="hb-tabs" role="tablist" aria-label="transcribe tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">transcript</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">files</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">model</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><p class="hb-lay-empty-note" data-part="none">nothing yet. drop a recording or try the sample.</p><div data-part="exports"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="queue"></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="model"></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the sample is a second of quiet; the lines come from a script until you load a speech model.</p></div></details>
        </aside>
      </div>
    </div>`);
  const part = (name: string) => root.querySelector(`[data-part="${name}"]`) as HTMLElement;

  // the pick: every speech to text model, fitted to this machine.
  // a real page passes weightsLoader(store) and wires @hackbuild/transcribe as the transcriber.
  const pick = useModelPick("transcribe", { env: FIXTURE_ENV, loader: stubLoaderOf(script) });
  const queue = transcribeQueue({ run: (file, ctx) => ((pick.snapshot().loaded as Transcriber | undefined) ?? script)(file, ctx) });
  const sample = async () => {
    queue.add([sampleRecording("walk with pixel.wav")]);
    while (queue.snapshot().running || !queue.snapshot().channels.some((c) => c.segments.length)) await sleep(100);
  };
  const drop = mountTranscribeDrop(part("drop"), queue, { title: "drop a recording", sampleLabel: "try a sample", onSample: () => void sample() });
  const parts = [drop, mountTranscriptExports(part("exports"), queue, { go: true }), mountTranscribeQueue(part("queue"), queue), mountModelSelect(part("model"), pick)];
  part("add").addEventListener("click", () => drop.pick());
  const off = queue.subscribe((s) => {
    (part("add").parentElement as HTMLElement).hidden = !s.channels.length;
    part("none").hidden = s.channels.some((c) => c.segments.length);
  });
  const lay = layout(root);
  return { pick, sample, dispose: () => (off(), parts.forEach((p) => p.dispose()), lay.dispose(), (host.innerHTML = "")) };
}
