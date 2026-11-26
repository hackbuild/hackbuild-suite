// speak a line: a voice loaded in this tab turns text into audio with each
// word timed, and the line lights word by word as it plays. The system voice
// needs no download; the others name their size on the load button.
import { probe, type Env } from "@hackbuild/ai-env";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { mountModelSelect } from "@hackbuild/ai-views/elements";
import type { Engine, Timed } from "@hackbuild/speak";
import { layout, spokenIndex } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

const LINE = "hello. this line is read by a voice in this tab, and each word lights up as it is said.";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
type Span = { text: string; start: number; end: number };

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  host.innerHTML = `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><div class="hb-lay-empty">
            <p class="hb-note" data-part="label">sample, no model loaded</p>
            <figure class="hb-spoken" data-part="spoken"><p class="hb-spoken-line"></p></figure>
          </div></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="actions"><button type="button" class="hb-btn hb-btn-go" data-part="go" hidden>speak</button></div>
        </section>
        <aside class="hb-rack" aria-label="speak">
          <nav class="hb-tabs" role="tablist" aria-label="speak tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">say</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">words</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">about</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel">
            <div data-part="voice"></div>
            <label class="hb-field"><span class="hb-label">the line</span><textarea class="hb-input" rows="4" data-part="text"></textarea></label>
            <p class="hb-note" data-part="said">nothing said yet.</p>
          </section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><table class="hb-table"><thead><tr><th>word</th><th>from</th><th>to</th></tr></thead><tbody data-part="words"></tbody></table></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><p class="hb-note">load a voice, then press speak. the times in the words tab are the ones the voice reports.</p></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the system voice plays through the browser and reports word starts only; the others render audio here with each word timed.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const part = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector(`[data-part="${name}"]`) as T;
  const text = part<HTMLTextAreaElement>("text");
  text.value = LINE;

  // every voice the catalogue knows; jobLoader loads it only when load is pressed
  // it starts on the system voice, which needs no download
  const pick = useModelPick("voice", { ...(hooks.env ? { env: hooks.env } : {}), chosen: "web-speech", loader: hooks.loaderFor?.("voice") ?? jobLoader("voice") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  const select = mountModelSelect(part("voice"), pick);
  const offPick = pick.subscribe((s) => {
    const ready = s.row?.state === "loaded";
    part("go").hidden = !ready;
    part("label").hidden = ready;
  });

  // the line as word spans, the word at `at` lit
  const show = (line: string, spans: Span[], at: number) => {
    part("spoken").classList.toggle("is-live", at >= 0 && at < spans.length);
    part("spoken").firstElementChild!.innerHTML = spans.map((w, i) => `<span class="hb-spoken-w${i === at ? " is-on" : i < at ? " is-done" : ""}">${esc(w.text)}</span>`).join(" ") || esc(line);
  };
  const spansOf = (line: string, words: Timed[]): Span[] => words.map((w, i) => ({ text: line.slice(w.start, words[i + 1]?.start ?? line.length).trim(), start: w.t0, end: w.t1 }));

  let ac: AudioContext | null = null;
  let ctl = new AbortController();
  let frame = 0;
  async function speak(): Promise<void> {
    ctl.abort();
    ctl = new AbortController();
    const line = text.value.trim();
    const engine = pick.snapshot().loaded as Engine | undefined;
    if (!line || !engine) return;
    if (engine.kind === "native") {
      // the browser plays it and says where each word starts
      const starts = [...line.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index!, end: m.index! + m[0].length }));
      const spans = starts.map((w) => ({ text: w.text, start: 0, end: 0 }));
      show(line, spans, -1);
      await engine.speak(line, {}, { onBoundary: (c) => show(line, spans, starts.findIndex((w) => c < w.end)) }, ctl.signal);
      show(line, spans, spans.length);
      part("said").textContent = `${spans.length} words, timed by the browser.`;
      return;
    }
    // a voice that renders here: collect its audio and word times, then play
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
    void ac.resume().catch(() => undefined);
    const audio = ac.createBuffer(1, Math.max(1, Math.round(at * rate)), rate);
    chunks.reduce((o, c) => (audio.getChannelData(0).set(c, o), o + c.length), 0);
    const spans = spansOf(line, words);
    part("words").innerHTML = spans.map((w) => `<tr><td>${esc(w.text)}</td><td>${w.start.toFixed(2)} s</td><td>${w.end.toFixed(2)} s</td></tr>`).join("");
    part("said").textContent = `${spans.length} words, ${audio.duration.toFixed(1)} s.`;
    const src = ac.createBufferSource();
    src.buffer = audio;
    src.connect(ac.destination);
    src.start();
    const t0 = performance.now();
    const mine = ctl;
    cancelAnimationFrame(frame);
    const tick = () => {
      if (mine.signal.aborted) return;
      const t = (performance.now() - t0) / 1000;
      show(line, spans, spanAt(spans, t));
      if (t < audio.duration) frame = requestAnimationFrame(tick);
    };
    tick();
    await new Promise((r) => setTimeout(r, audio.duration * 1000 + 100));
  }
  const spanAt = (spans: Span[], t: number) => spokenIndex(spans, t);
  show(LINE, [], -1);
  part("go").addEventListener("click", () => void speak());
  const lay = layout(root);
  return {
    pick,
    // what the gate runs: load the chosen voice, then say the line
    sample: async () => {
      await pick.load();
      await speak();
    },
    dispose: () => (ctl.abort(), cancelAnimationFrame(frame), void ac?.close(), offPick(), select.dispose(), lay.dispose(), (host.innerHTML = "")),
  };
}
