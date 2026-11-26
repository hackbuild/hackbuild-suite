// speak with lip sync: a body on a lit stage says a line in a voice loaded
// in this tab, and its mouth follows the audio and the word times the voice
// reports. The body is the stand in built in code; drop a .vrm, .glb or .fbx
// on the stage to change it.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { mountModelSelect } from "@hackbuild/ai-views/elements";
import { characterStage, speechEvents, type Speech } from "@hackbuild/motion-views/vanilla";
import type { Engine, Timed } from "@hackbuild/speak";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

const HELLO = "hello. watch my mouth, it moves with every word i say.";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  host.innerHTML = `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section data-part="stage"></section>
        <aside class="hb-rack" aria-label="lip sync">
          <nav class="hb-tabs" role="tablist" aria-label="lip sync tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">now</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">line</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">voice</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><p class="hb-marker" data-part="doing">idle</p><p class="hb-note" data-part="said">sample, no model loaded. say hello moves the mouth on estimated word times, with no sound; load a voice in the voice tab to hear it.</p><div data-part="mouth"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel">
            <label class="hb-field"><span class="hb-label">what it says</span><textarea class="hb-input" rows="4" data-part="text"></textarea></label>
            <p><button type="button" class="hb-btn" data-part="say">say it</button></p>
          </section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="voice"></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the stand in body has no mouth shapes, so its jaw and head carry the speech; a body with visemes moves its lips.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const part = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector(`[data-part="${name}"]`) as T;
  const text = part<HTMLTextAreaElement>("text");
  text.value = HELLO;

  // every voice the catalogue knows; jobLoader loads it only when load is pressed
  // it starts on the system voice, which needs no download
  const pick = useModelPick("voice", { ...(hooks.env ? { env: hooks.env } : {}), chosen: "web-speech", loader: hooks.loaderFor?.("voice") ?? jobLoader("voice") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  const select = mountModelSelect(part("voice"), pick);
  let ac: AudioContext | null = null;
  const ctl = new AbortController();

  // what the stage says: audio with word times from a voice that renders here,
  // or the text alone (estimated times) when the voice plays itself or none is loaded
  const speechOf = async (line: string): Promise<Speech> => {
    const engine = pick.snapshot().loaded as Engine | undefined;
    if (!engine) return { text: line };
    if (engine.kind === "native") {
      void engine.speak(line, {}, { onBoundary: () => undefined }, ctl.signal);
      return { text: line };
    }
    const chunks: Float32Array[] = [];
    const words: Timed[] = [];
    let rate = 24000;
    let at = 0;
    for await (const c of engine.synth(line, {}, ctl.signal)) {
      rate = c.sampleRate;
      for (const w of c.words ?? []) words.push({ ...w, t0: w.t0 + at, t1: w.t1 + at });
      chunks.push(c.samples);
      at += c.samples.length / rate;
    }
    ac ??= new AudioContext();
    const audio = ac.createBuffer(1, Math.max(1, Math.round(at * rate)), rate);
    chunks.reduce((o, c) => (audio.getChannelData(0).set(c, o), o + c.length), 0);
    return { text: line, audio, words };
  };

  // the mouth track the stage builds from the speech: where its times come from
  const tell = (s: Speech) => {
    const seconds = s.audio && "duration" in s.audio ? s.audio.duration : 0;
    const { events, source } = speechEvents(s, 0, seconds);
    part("said").textContent = s.text ?? "";
    part("mouth").innerHTML = [["mouth from", source], ["mouth changes", String(events.length)], ["seconds", seconds ? seconds.toFixed(1) : "no audio"]]
      .map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${esc(k!)}</span><span class="hb-readout">${esc(v!)}</span></div>`).join("");
  };
  const say = async () => {
    const s = await speechOf(text.value.trim() || HELLO);
    tell(s);
    await view.say(s);
  };
  // say hello, the stage's pink verb, says the line in the loaded voice
  const view = characterStage(part("stage"), { hello: () => ({ text: text.value.trim() || HELLO }) });
  const off = view.on((e) => {
    if (e.type === "doing") part("doing").textContent = e.word;
  });
  // the stage's own say hello speaks text alone; with a voice loaded, route it through the voice
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest('[data-verb="say"]');
    if (b && pick.snapshot().loaded) (e.stopPropagation(), void say());
  }, true);
  part("say").addEventListener("click", () => void say());
  const lay = layout(root);
  return {
    pick,
    // what the gate runs: load the chosen voice, then say the line
    sample: async () => {
      await pick.load();
      await say();
    },
    dispose: () => (ctl.abort(), off(), view.dispose(), void ac?.close(), select.dispose(), lay.dispose(), (host.innerHTML = "")),
  };
}
