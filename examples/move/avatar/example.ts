// load a vrm, glb or fbx and pose it: a character stage that stands, looks
// and waves, and a drop card that checks a file before the stage wears it.
// The stand in body is built in code, so the stage is alive before any file.
import { avatarDrop, characterStage, type CharacterStageEvent } from "@hackbuild/motion-views/vanilla";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { draw, sleep, type Example } from "../../shared/fixtures.js";
import { kv } from "../../shared/move.js";

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage"></section>
        <aside class="hb-rack" aria-label="the character">
          <nav class="hb-tabs" role="tablist" aria-label="character tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">now</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">body</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">wear</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">what it is doing</div><p class="hb-marker" data-doing>idle</p><div data-now></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">this body</div><div data-body></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">wear another</div><div data-drop></div></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the stand in is a body of capsules on a humanoid skeleton, built in code. a file you drop is read in this tab and never uploaded.</p></div></details>
        </aside>
      </div>
    </div>`);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;

  // a vrm file needs the vrm loader; it loads only when a vrm arrives
  const vrm = () => import("@hackbuild/avatar/vrm").then((m) => m.vrmHook());
  const view = characterStage($(".hb-lay-stage"), {
    vrm,
    framing: "full",
    verbs: [{ id: "wave", label: "wave", go: true }, { id: "nod", label: "nod" }, { id: "look", label: "look around" }],
  });
  const drop = avatarDrop($("[data-drop]"), { vrm, label: "pick a file", hint: "drop a .vrm, .glb or .fbx here" });
  const offDrop = drop.on((e) => {
    if (e.type === "picked" || e.type === "use") void view.show(e.files);
  });

  const offView = view.on((e: CharacterStageEvent) => {
    if (e.type === "doing") $("[data-doing]").textContent = e.word;
    if (e.type === "loaded") {
      kv($("[data-body]"), {
        name: e.placeholder ? "the stand in" : e.name,
        bones: e.caps.bones,
        "lips move": e.caps.mouth ? "yes" : "no",
        blinks: e.caps.blink ? "yes" : "no",
        "clips inside": e.caps.clips.length,
      });
    }
    if (e.type === "failed") $("[data-doing]").textContent = e.message;
  });
  let fps = 0;
  const offStats = view.stage.on("stats", (e) => {
    fps = Math.round(e.stats.fps);
    kv($("[data-now]"), { "frames a second": fps, framing: view.framing === "full" ? "full body" : "head and shoulders", "turn the view": "drag the stage" });
  });

  const lay = layout(root);
  // the built in sample: the stand in waves
  const sample = async () => {
    view.gesture("wave");
    await sleep(700);
  };
  return {
    sample,
    dispose: () => (offDrop(), offView(), offStats(), drop.dispose(), view.dispose(), lay.dispose(), (host.innerHTML = "")),
  };
}
