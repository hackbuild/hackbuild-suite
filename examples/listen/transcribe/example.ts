// transcribe a file: the drop zone is the page until a file is in it, then
// the transcript is. Files queue and run one at a time on a real speech
// model loaded in this tab (its size is on the load button); lines carry
// their time, edit in place with undo, and export once there is text.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, transcribeQueue, useModelPick, type Job, type Loader, type Transcriber } from "@hackbuild/ai-views";
import { mountModelSelect, mountTranscribeDrop, mountTranscribeQueue, mountTranscriptExports } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

// a sample transcript, written here, shown until a model has run on a file
const SAMPLE = [
  ["0:00", "pixel, sit. good dog."],
  ["0:04", "now the red ball, the one under the bench."],
  ["0:08", "he goes left every time, so the gate is fine there."],
];

/** A second of quiet as a wav file, for the gate's run through the queue. */
function quietWav(name: string): Blob & { name: string } {
  const n = 16000;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF"), v.setUint32(4, 36 + n * 2, true), tag(8, "WAVEfmt "), v.setUint32(16, 16, true), v.setUint16(20, 1, true), v.setUint16(22, 1, true);
  v.setUint32(24, n, true), v.setUint32(28, n * 2, true), v.setUint16(32, 2, true), v.setUint16(34, 16, true), tag(36, "data"), v.setUint32(40, n * 2, true);
  return Object.assign(new Blob([v.buffer], { type: "audio/wav" }), { name });
}

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  host.innerHTML = `
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
          <section class="hb-rack-pane"><section class="hb-panel">
            <div data-part="sample"><p class="hb-note">sample, no model loaded</p>${SAMPLE.map(([t, s]) => `<p><span class="hb-readout">${t}</span> ${s}</p>`).join("")}</div>
            <div data-part="exports"></div>
          </section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="queue"></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div data-part="model"></div><p class="hb-note">a speech model runs on this machine; files never leave the tab.</p></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the sample lines are written in this file. a dropped file goes to the loaded model only.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const part = (name: string) => root.querySelector(`[data-part="${name}"]`) as HTMLElement;

  // every speech to text model, fitted to this machine; jobLoader fetches
  // the runtime and the weights only when load is pressed
  const pick = useModelPick("transcribe", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("transcribe") ?? jobLoader("transcribe") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  const run: Transcriber = (file, ctx) => {
    const model = pick.snapshot().loaded as Transcriber | undefined;
    if (!model) throw new Error("no speech model loaded. load one in the model tab, then run the file again.");
    return model(file, ctx);
  };
  const queue = transcribeQueue({ run });
  const drop = mountTranscribeDrop(part("drop"), queue, { title: "drop a recording" });
  const parts = [drop, mountModelSelect(part("model"), pick), mountTranscriptExports(part("exports"), queue, { go: true }), mountTranscribeQueue(part("queue"), queue)];
  part("add").addEventListener("click", () => drop.pick());
  const off = queue.subscribe((s) => {
    (part("add").parentElement as HTMLElement).hidden = !s.channels.length;
    part("sample").hidden = s.channels.some((c) => c.segments.length);
  });
  const lay = layout(root);
  return {
    pick,
    // what the gate runs: load the chosen model, then a second of quiet through the queue
    sample: async () => {
      await pick.load();
      queue.add([quietWav("quiet.wav")]);
      while (queue.snapshot().running || !queue.snapshot().channels.some((c) => c.segments.length || c.error)) await new Promise((r) => setTimeout(r, 100));
    },
    dispose: () => (off(), parts.forEach((p) => p.dispose()), lay.dispose(), (host.innerHTML = "")),
  };
}
