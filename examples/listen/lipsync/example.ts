// speak with lip sync: a body on a lit stage says a line, and its mouth
// follows the audio level and the word timings the voice reports. The body
// is the stand in built in code; drop a .vrm, .glb or .fbx on the stage to
// change it. Until a voice model is loaded a hum written in code speaks.
import { useModelPick } from "@hackbuild/ai-views";
import { mountModelSelect } from "@hackbuild/ai-views/elements";
import { characterStage, speechEvents, type Speech } from "@hackbuild/motion-views/vanilla";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, stubLoaderOf, type Example } from "../../shared/fixtures.js";
import { codeVoice } from "../../shared/listen.js";

type Voice = typeof codeVoice;
const HELLO = "hello. watch my mouth, it moves with every word i say.";
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section data-part="stage"></section>
        <aside class="hb-rack" aria-label="lip sync">
          <nav class="hb-tabs" role="tablist" aria-label="lip sync tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">now</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">line</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">voice</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><p class="hb-marker" data-part="doing">idle</p><p class="hb-note" data-part="said">press say hello.</p><div data-part="mouth"></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel">
            <label class="hb-field"><span class="hb-label">what it says</span><textarea class="hb-input" rows="4" data-part="text"></textarea></label>
            <p><button type="button" class="hb-btn" data-part="say">say it</button></p>
          </section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel" data-part="voice"></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the body is a stand in with no mouth shapes, so its jaw and head carry the speech; a body with visemes moves its lips. the voice is a hum written in code until a voice model loads.</p></div></details>
        </aside>
      </div>
    </div>`);
  const part = <T extends HTMLElement = HTMLElement>(name: string) => root.querySelector(`[data-part="${name}"]`) as T;
  const text = part<HTMLTextAreaElement>("text");
  text.value = HELLO;

  // the pick: every voice the catalogue knows. a real page passes the speak engine's loader.
  const pick = useModelPick("voice", { env: FIXTURE_ENV, loader: stubLoaderOf(codeVoice) });
  const select = mountModelSelect(part("voice"), pick);

  // real audio with word timings, as a speech engine hands them over
  const speech = (line: string): Speech => ({ text: line, ...((pick.snapshot().loaded as Voice | undefined) ?? codeVoice)(line) });
  const view = characterStage(part("stage"), { hello: () => speech(text.value.trim() || HELLO) });

  // the mouth track the stage builds from the speech: where its timings come from and how many shapes
  const tell = (s: Speech) => {
    const seconds = s.audio && "duration" in s.audio ? s.audio.duration : 0;
    const { events, source } = speechEvents(s, 0, seconds);
    part("said").textContent = s.text ?? "";
    part("mouth").innerHTML = [["mouth from", source], ["mouth changes", String(events.length)], ["seconds", seconds.toFixed(1)]]
      .map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${esc(k!)}</span><span class="hb-readout">${esc(v!)}</span></div>`).join("");
  };
  const say = async () => {
    const s = speech(text.value.trim() || HELLO);
    tell(s);
    await view.say(s);
  };
  const off = view.on((e) => {
    if (e.type === "doing") part("doing").textContent = e.word;
    if (e.type === "verb" && e.id === "say") tell(speech(text.value.trim() || HELLO));
  });
  part("say").addEventListener("click", () => void say());
  const lay = layout(root);
  return { pick, sample: say, dispose: () => (off(), view.dispose(), select.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
