// push to talk dictation: hold the button and talk, let go and the words
// land. A real speech model runs in this tab on what you said; the
// microphone opens only on the first press, and nothing is recorded before.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader, type Transcriber } from "@hackbuild/ai-views";
import { mountModelSelect } from "@hackbuild/ai-views/elements";
import { dictate, micBlocks, openMic } from "@hackbuild/listen";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** 16 khz mono samples as a wav file, the shape a speech model reads. */
function wav(pcm: Float32Array): Blob & { name: string } {
  const v = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const tag = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  tag(0, "RIFF"), v.setUint32(4, 36 + pcm.length * 2, true), tag(8, "WAVEfmt "), v.setUint32(16, 16, true), v.setUint16(20, 1, true), v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true), v.setUint32(28, 32000, true), v.setUint16(32, 2, true), v.setUint16(34, 16, true), tag(36, "data"), v.setUint32(40, pcm.length * 2, true);
  pcm.forEach((x, i) => v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x)) * 32767, true));
  return Object.assign(new Blob([v.buffer], { type: "audio/wav" }), { name: "said.wav" });
}

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  host.innerHTML = `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><div class="hb-lay-empty">
            <div data-part="sample"><p class="hb-note">sample, no model loaded</p><p class="hb-lay-empty-name">pick up some petg on the way home.</p></div>
            <figure class="hb-spoken" data-part="spoken" hidden><p class="hb-spoken-line"></p></figure>
          </div></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-part="hold" hidden>hold to talk</button><button type="button" class="hb-btn" data-part="clear" hidden>clear</button></div>
        </section>
        <aside class="hb-rack" aria-label="dictation">
          <nav class="hb-tabs" role="tablist" aria-label="dictation tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">words</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">mic</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">about</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div data-part="model"></div><div data-part="log"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><p class="hb-note" data-part="mic">the microphone opens on your first press. nothing is recorded until then.</p></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><p class="hb-note">load a speech model, then hold the pink button and talk. let go and the words land on the page.</p></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the sample line is written in this file. what you say goes to the loaded model only.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const part = (name: string) => root.querySelector(`[data-part="${name}"]`) as HTMLElement;

  // every speech to text model; jobLoader fetches it only when load is pressed
  const pick = useModelPick("transcribe", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("transcribe") ?? jobLoader("transcribe") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  const select = mountModelSelect(part("model"), pick);
  const offPick = pick.subscribe((s) => (part("hold").hidden = s.row?.state !== "loaded"));
  const ctl = new AbortController();
  const transcribe = async (pcm: Float32Array) => {
    const model = pick.snapshot().loaded as Transcriber;
    const r = await model(wav(pcm), { signal: ctl.signal, onProgress: () => undefined });
    return r.segments.map((s) => s.text).join(" ").trim();
  };

  // the words on the subject: dictate writes into the box and commits the final
  const box = { value: "" };
  const render = () => {
    part("sample").hidden = true;
    part("spoken").hidden = !box.value;
    part("clear").hidden = !box.value;
    part("spoken").firstElementChild!.innerHTML = `<span class="hb-spoken-w is-done">${esc(box.value)}</span>`;
  };
  const words = dictate({ get value() { return box.value; }, set value(v) { box.value = v; render(); } });
  const land = (text: string, seconds: number) => {
    words.final(text);
    part("log").insertAdjacentHTML("beforeend", `<p>${esc(text || "nothing heard.")} <span class="hb-note">${seconds.toFixed(1)} s of audio</span></p>`);
  };

  // hold: the mic streams blocks; let go: the utterance goes to the model
  let ac: AudioContext | null = null;
  let stop: (() => void) | null = null;
  let blocks: Float32Array[] = [];
  const down = async () => {
    try {
      ac ??= new AudioContext();
      const stream = await openMic();
      blocks = [];
      const end = await micBlocks(ac, stream, (b) => blocks.push(b));
      stop = () => (end(), stream.getTracks().forEach((t) => t.stop()));
      part("mic").textContent = "listening. let go to stop.";
    } catch (e) {
      part("mic").textContent = `no microphone: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  const up = async () => {
    if (!stop || !ac) return;
    stop();
    stop = null;
    const all = new Float32Array(blocks.reduce((n, b) => n + b.length, 0));
    blocks.reduce((at, b) => (all.set(b, at), at + b.length), 0);
    const step = ac.sampleRate / 16000;
    const pcm = Float32Array.from({ length: Math.floor(all.length / step) }, (_, i) => all[Math.floor(i * step)]!);
    part("mic").textContent = "microphone ready.";
    land(await transcribe(pcm), pcm.length / 16000);
  };
  const hold = part("hold");
  hold.addEventListener("pointerdown", () => void down());
  hold.addEventListener("pointerup", () => void up());
  hold.addEventListener("pointerleave", () => void up());
  part("clear").addEventListener("click", () => ((box.value = ""), render()));
  const lay = layout(root);
  return {
    pick,
    // what the gate runs: load the chosen model, then a second of quiet through it
    sample: async () => {
      await pick.load();
      land(await transcribe(new Float32Array(16000)), 1);
    },
    dispose: () => (ctl.abort(), stop?.(), void ac?.close(), offPick(), select.dispose(), lay.dispose(), (host.innerHTML = "")),
  };
}
