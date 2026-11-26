// push to talk dictation: hold the button and talk, let go and the words
// land. Interim words show while they come in and commit on the final. The
// microphone opens only on the first press. Until a speech model is loaded a
// script stands in for it, and the sample runs with no microphone at all.
import { dictate, micBlocks, openMic, type Transcriber } from "@hackbuild/listen";
import { useModelPick } from "@hackbuild/ai-views";
import { mountModelSelect } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, sleep, stubLoaderOf, type Example } from "../../shared/fixtures.js";

// stands in for a speech model: each utterance is the next of these lines
const SAID = ["pick up some petg on the way home.", "and book the laser cutter for tuesday.", "remind me to sand the dog collar."];
let said = 0;
const script: Transcriber = async () => SAID[said++ % SAID.length]!;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><div class="hb-lay-empty"><p class="hb-lay-empty-name" data-part="hint">hold to talk</p><figure class="hb-spoken" data-part="spoken" hidden><p class="hb-spoken-line"></p></figure></div></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-part="hold">hold to talk</button><button type="button" class="hb-btn" data-part="clear" hidden>clear</button></div>
        </section>
        <aside class="hb-rack" aria-label="dictation">
          <nav class="hb-tabs" role="tablist" aria-label="dictation tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">words</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">mic</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">model</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div data-part="log"></div><p class="hb-note" data-part="none">nothing said yet. hold the button and talk.</p></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><p class="hb-note" data-part="mic">the microphone opens on your first press. nothing is recorded until then.</p></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="model"></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the words come from a script until you load a speech model; the sample plays them with no microphone.</p></div></details>
        </aside>
      </div>
    </div>`);
  const part = (name: string) => root.querySelector(`[data-part="${name}"]`) as HTMLElement;

  // the pick: every speech to text model. a real page passes weightsLoader(store) and a whisper transcriber.
  const pick = useModelPick("transcribe", { env: FIXTURE_ENV, loader: stubLoaderOf(script) });
  const select = mountModelSelect(part("model"), pick);
  const transcribe: Transcriber = (pcm, signal) => ((pick.snapshot().loaded as Transcriber | undefined) ?? script)(pcm, signal);

  // the words on the subject: dictate writes interim words, then commits the final
  const box = { value: "", interim: false };
  const render = () => {
    part("hint").hidden = !!box.value;
    part("spoken").hidden = !box.value;
    part("clear").hidden = !box.value || box.interim;
    part("spoken").firstElementChild!.innerHTML = `<span class="hb-spoken-w${box.interim ? "" : " is-done"}">${esc(box.value)}</span>`;
  };
  const words = dictate({ get value() { return box.value; }, set value(v) { box.value = v; render(); } });
  const land = async (text: string, seconds: number) => {
    const parts = text.split(" ");
    for (let i = 1; i <= parts.length; i++) {
      box.interim = true;
      words.interim({ text: parts.slice(0, i).join(" "), stable: parts.slice(0, i - 1).join(" "), t: i * 0.3 });
      await sleep(90);
    }
    box.interim = false;
    words.final(text);
    part("none").hidden = true;
    part("log").insertAdjacentHTML("beforeend", `<p>${esc(text)} <span class="hb-note">${seconds.toFixed(1)} s</span></p>`);
  };

  // hold: the mic streams blocks; let go: the utterance goes to the transcriber
  let ctx: AudioContext | null = null;
  let stop: (() => void) | null = null;
  let blocks: Float32Array[] = [];
  const down = async () => {
    try {
      ctx ??= new AudioContext();
      const stream = await openMic();
      blocks = [];
      stop = await micBlocks(ctx, stream, (b) => blocks.push(b));
      stop = ((s, st) => () => (s(), st.getTracks().forEach((t) => t.stop())))(stop, stream);
      part("mic").textContent = "listening. let go to stop.";
    } catch (e) {
      part("mic").textContent = `no microphone: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  const up = async () => {
    if (!stop || !ctx) return;
    stop();
    stop = null;
    const all = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
    blocks.reduce((at, b) => (all.set(b, at), at + b.length), 0);
    const step = ctx.sampleRate / 16000;
    const pcm = Float32Array.from({ length: Math.floor(all.length / step) }, (_, i) => all[Math.floor(i * step)]!);
    part("mic").textContent = "microphone ready.";
    await land(await transcribe(pcm), pcm.length / 16000);
  };
  const hold = part("hold");
  hold.addEventListener("pointerdown", () => void down());
  hold.addEventListener("pointerup", () => void up());
  hold.addEventListener("pointerleave", () => void up());
  part("clear").addEventListener("click", () => ((box.value = ""), render()));
  const sample = async () => land(await script(new Float32Array(0)), 2.4);
  const lay = layout(root);
  return { pick, sample, dispose: () => (stop?.(), void ctx?.close(), select.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
