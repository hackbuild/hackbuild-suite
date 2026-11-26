// retarget a clip: walks written for another rig (other bone names, in
// centimeters, arms down) put onto the stand in body, picked from a clip
// strip. The clips are bvh text made in code; drop a .bvh to add your own.
import type { AnimationClip } from "three";
import { load, parseBvh, retargetClip } from "@hackbuild/retarget";
import { skeletonFromObject3D, toAnimationClip, type SceneSkeleton } from "@hackbuild/retarget/three";
import { characterStage, clipStrip, type StripItem, walkBvh } from "@hackbuild/motion-views/vanilla";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

// small page helpers, kept here so this file stands alone
const draw = (host: HTMLElement, markup: string) => ((host.innerHTML = markup.trim()), host.firstElementChild as HTMLElement);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const kv = (el: Element, rows: Record<string, string | number>) =>
  (el.innerHTML = Object.entries(rows).map(([k, v]) => `<div class="hb-kv"><span class="hb-label">${k}</span><span class="hb-readout">${v}</span></div>`).join(""));

const SOURCES = [
  { id: "walk", name: "walk", text: () => walkBvh({ seconds: 2.4, fps: 30, swing: 1 }) },
  { id: "stroll", name: "stroll", text: () => walkBvh({ seconds: 3.2, fps: 30, swing: 0.6 }) },
  { id: "march", name: "march", text: () => walkBvh({ seconds: 1.6, fps: 30, swing: 1.5 }) },
];

export default function mount(host: HTMLElement): { sample: () => Promise<void>; dispose: () => void } {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage"></section>
        <aside class="hb-rack" aria-label="retarget">
          <nav class="hb-tabs" role="tablist" aria-label="retarget tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">clips</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">mapping</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">add</button>
          </nav>
          <section class="hb-rack-pane"><section class="hb-panel"><div class="hb-panel-hd-inst">on the body</div><div data-strip></div><div data-now></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">source to body</div><div data-map></div></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">your clip</div><label class="hb-field"><span class="hb-label">a .bvh file</span><input class="hb-input" type="file" accept=".bvh" data-file></label></section></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the clips are bvh text written in code for a rig with other bone names, in centimeters. the retarget maps them by bone name, scales them to meters and binds them to the body's rest pose.</p></div></details>
        </aside>
      </div>
    </div>`);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const view = characterStage($(".hb-lay-stage"), { framing: "full", verbs: [] });
  const strip = clipStrip($("[data-strip]"), { label: "clips", thumbs: false });
  const clips = new Map<string, AnimationClip>();
  let dst: SceneSkeleton | null = null;

  // one source clip onto the body: parse, retarget by name and unit, bind
  const add = (id: string, name: string, text: string) => {
    const src = parseBvh(text);
    const bound = retargetClip(src.skeleton, src.clip, dst!.skeleton, { srcUnit: 0.01, dstUnit: 1 });
    const anim = toAnimationClip(bound, dst!, name);
    clips.set(id, anim);
    kv($("[data-map]"), { "source bones": src.skeleton.names.length, "body bones": dst!.skeleton.names.length, "source unit": "centimeters", "body unit": "meters" });
    return { id, name, seconds: anim.duration, loop: true, from: "retarget", tags: ["walk"] } satisfies StripItem;
  };
  const play = (id: string) => {
    const anim = clips.get(id);
    if (!anim) return;
    view.play(anim, { loop: true });
    strip.setPlaying(true);
    kv($("[data-now]"), { playing: anim.name, seconds: anim.duration.toFixed(1) });
  };
  const ready = Promise.all([load(), new Promise<void>((ok) => { const off = view.on((e) => { if (e.type === "loaded") (off(), ok()); }); if (view.body) ok(); })]).then(() => {
    dst = skeletonFromObject3D(view.body!.avatar.root);
    strip.setItems(SOURCES.map((s) => add(s.id, s.name, s.text())), "walk");
    play("walk");
  });
  const offStrip = strip.on((e) => {
    if (e.type === "play" || e.type === "pick") play(e.item.id);
    if (e.type === "stop") (view.stop(), strip.setPlaying(false));
  });
  const file = $("[data-file]") as HTMLInputElement;
  file.addEventListener("change", async () => {
    const f = file.files?.[0];
    if (!f || !dst) return;
    const item = add(`file-${clips.size}`, f.name.replace(/\.bvh$/i, ""), await f.text());
    strip.setItems([...SOURCES.map((s) => ({ id: s.id, name: s.name, seconds: clips.get(s.id)!.duration, loop: true, from: "retarget" as const })), item], item.id);
    play(item.id);
  });

  const lay = layout(root);
  // the built in sample: the march plays on the body
  const sample = async () => {
    await ready;
    strip.pick("march");
    play("march");
    await sleep(500);
  };
  return { sample, dispose: () => (offStrip(), strip.dispose(), view.dispose(), lay.dispose(), (host.innerHTML = "")) };
}
