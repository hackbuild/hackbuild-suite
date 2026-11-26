// speak a line: a voice turns text into audio with each word timed, and the
// line lights word by word as it plays. Until a voice model is loaded a hum
// written in code stands in, with the timings a speech engine reports.
import { useModelPick } from "@hackbuild/ai-views";
import { mountModelSelect } from "@hackbuild/ai-views/elements";
import { layout, spokenIndex } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, sleep, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { codeVoice } from "../../shared/listen.js";

type Voice = typeof codeVoice;
const LINE = "hello. this line was written in code, and each word lights up as it is said.";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-form-frame">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject"><figure class="hb-spoken" data-part="spoken"><p class="hb-spoken-line"></p></figure></div>
        </section>
        <aside class="hb-rack" aria-label="speak">
          <nav class="hb-tabs" role="tablist" aria-label="speak tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">say</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">words</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">voice</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel">
            <label class="hb-field"><span class="hb-label">the line</span><textarea class="hb-input" rows="5" data-part="text"></textarea></label>
            <p><button type="button" class="hb-btn hb-btn-go" data-part="go">speak</button></p>
            <p class="hb-note" data-part="said">nothing said yet.</p>
          </section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><table class="hb-table"><thead><tr><th>word</th><th>from</th><th>to</th></tr></thead><tbody data-part="words"></tbody></table></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="voice"></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the voice is a hum written in code until you load a voice model; its word times are the ones it was written with.</p></div></details>
        </aside>
      </div>
    </div>`);
  const part = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector(`[data-part="${name}"]`) as T;
  const text = part<HTMLTextAreaElement>("text");
  text.value = LINE;

  // the pick: every voice the catalogue knows. a real page passes the speak engine's loader.
  const pick = useModelPick("voice", { env: FIXTURE_ENV, loader: stubLoaderOf(codeVoice) });
  const select = mountModelSelect(part("voice"), pick);
  let ctx: AudioContext | null = null;
  let frame = 0;
  let run = 0;

  // shows the line as word spans, the word at `t` seconds lit
  const show = (line: string, words: { text: string; start: number; end: number }[], t: number | null) => {
    const at = spokenIndex(words, t);
    part("spoken").classList.toggle("is-live", at >= 0 && at < words.length);
    part("spoken").firstElementChild!.innerHTML = words.map((w, i) => `<span class="hb-spoken-w${i === at ? " is-on" : i < at ? " is-done" : ""}">${esc(w.text)}</span>`).join(" ") || esc(line);
  };

  async function speak(): Promise<void> {
    const mine = ++run;
    const line = text.value.trim();
    if (!line) return;
    const voice = (pick.snapshot().loaded as Voice | undefined) ?? codeVoice;
    const { audio, words } = voice(line);
    // each word keeps the punctuation after it, so the line reads as written
    const spans = words.map((w, i) => ({ text: line.slice(w.start, words[i + 1]?.start ?? line.length).trim(), start: w.t0, end: w.t1 }));
    part("words").innerHTML = spans.map((w) => `<tr><td>${esc(w.text)}</td><td>${w.start.toFixed(2)} s</td><td>${w.end.toFixed(2)} s</td></tr>`).join("");
    part("said").textContent = `${spans.length} words, ${audio.duration.toFixed(1)} s.`;
    ctx ??= new AudioContext();
    void ctx.resume().catch(() => undefined);
    const src = ctx.createBufferSource();
    src.buffer = audio;
    src.connect(ctx.destination);
    src.start();
    const t0 = performance.now();
    cancelAnimationFrame(frame);
    const tick = () => {
      if (mine !== run) return;
      const t = (performance.now() - t0) / 1000;
      show(line, spans, t);
      if (t < audio.duration) frame = requestAnimationFrame(tick);
    };
    tick();
    await sleep(audio.duration * 1000 + 100);
  }
  show(LINE, [], null);
  part("go").addEventListener("click", () => void speak());
  const lay = layout(root);
  return {
    pick,
    sample: speak,
    dispose: () => (run++, cancelAnimationFrame(frame), void ctx?.close(), select.dispose(), lay.dispose(), (host.innerHTML = "")),
  };
}
