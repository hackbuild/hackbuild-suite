// a creature with drives: hunger, tiredness and boredom rise, each act is
// scored by how much it would ease them, and a chooser picks one and sticks
// with it a while. The bars show the scores and the needs as they move.
import { load, Chooser, Drives, seededRng } from "@hackbuild/drives";
import { drivesBars, drivesBarsState } from "@hackbuild/agents-views";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { draw, sleep, type Example } from "../../shared/fixtures.js";

type Need = "hunger" | "tired" | "bored";
type Act = "eat" | "rest" | "play" | "explore";
// what each act does to the needs, and where in the yard it happens (0 to 1)
const ACTS: Record<Act, { effect: Partial<Record<Need, number>>; at: [number, number] | null }> = {
  eat: { effect: { hunger: -0.7 }, at: [0.18, 0.72] },
  rest: { effect: { tired: -0.7 }, at: [0.82, 0.3] },
  play: { effect: { bored: -0.7, tired: 0.1 }, at: [0.55, 0.55] },
  explore: { effect: { bored: -0.2 }, at: null },
};
const GROW: Record<Need, number> = { hunger: 0.018, tired: 0.012, bored: 0.03 };

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-stage-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" aria-label="the yard"><canvas style="display:block;width:100%;height:100%"></canvas></div>
          <div class="hb-lay-verbs" role="toolbar" aria-label="the yard">
            <button type="button" class="hb-btn hb-btn-go" data-throw>throw the ball</button>
            <button type="button" class="hb-btn" data-hungry>skip a meal</button>
          </div>
        </section>
        <aside class="hb-rack" aria-label="the mind">
          <nav class="hb-tabs" role="tablist" aria-label="mind tabs">
            <button type="button" class="hb-tab" role="tab" aria-selected="true">mind</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">choices</button>
            <button type="button" class="hb-tab" role="tab" aria-selected="false">how</button>
          </nav>
          <section class="hb-rack-pane"><div data-bars></div></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">last switches</div><ol class="hb-flow" data-log></ol></section></section>
          <section class="hb-rack-pane" hidden><section class="hb-panel"><div class="hb-panel-hd-inst">how it chooses</div><p class="hb-note">each need grows on its own clock. an act's score is how far it would bring the needs down. the chooser draws from the scores, warmer for the best, and holds an act for a while before it looks again.</p></section></section>
        </aside>
      </div>
    </div>`);
  const $ = (s: string) => root.querySelector(s) as HTMLElement;
  const canvas = $("canvas") as HTMLCanvasElement;
  const g = canvas.getContext("2d")!;
  const bars = drivesBars($("[data-bars]"));
  const me = { x: 0.4, y: 0.4, roam: [0.4, 0.4] as [number, number] };
  let mind: { drives: Drives<Need>; chooser: Chooser<Act> } | null = null;
  let now = 0;
  let since = 0;
  let raf = 0;
  let last = performance.now();

  const tick = (t: number) => {
    const dt = Math.min(0.05, (t - last) / 1000);
    last = t;
    now += dt;
    if (mind) think(dt);
    paint();
    raf = requestAnimationFrame(tick);
  };
  const think = (dt: number) => {
    const { drives, chooser } = mind!;
    drives.grow(dt, GROW);
    const scores = Object.fromEntries((Object.keys(ACTS) as Act[]).map((a) => [a, drives.rewardOf(ACTS[a].effect)])) as Record<Act, number>;
    const d = chooser.update(now, scores);
    if (d.switched) {
      since = now;
      $("[data-log]").insertAdjacentHTML("afterbegin", `<li>${d.current}: ${d.why}</li>`);
      if ($("[data-log]").children.length > 8) $("[data-log]").lastElementChild!.remove();
    }
    // walk to the spot of the act; once there, the act eases its needs
    const act = ACTS[chooser.current];
    if (!act.at && Math.hypot(me.roam[0] - me.x, me.roam[1] - me.y) < 0.02) me.roam = [0.1 + Math.random() * 0.8, 0.15 + Math.random() * 0.7];
    const [tx, ty] = act.at ?? me.roam;
    const dist = Math.hypot(tx - me.x, ty - me.y);
    if (dist > 0.01) (me.x += ((tx - me.x) / dist) * Math.min(dist, 0.18 * dt)), (me.y += ((ty - me.y) / dist) * Math.min(dist, 0.18 * dt));
    else {
      const v = drives.values;
      drives.set(Object.fromEntries(Object.entries(act.effect).map(([k, e]) => [k, Math.max(0, Math.min(1, v[k as Need] + e * dt * 0.5))])));
      if (Object.entries(act.effect).every(([k, e]) => e > 0 || v[k as Need] < 0.08)) chooser.markDone();
    }
    bars.update(drivesBarsState(d, drives, { now, seconds: now - since }));
  };
  const paint = () => {
    const w = (canvas.width = canvas.clientWidth * devicePixelRatio);
    const h = (canvas.height = canvas.clientHeight * devicePixelRatio);
    g.fillStyle = "#e3ddc9";
    g.fillRect(0, 0, w, h);
    const spot = (at: [number, number], color: string, r: number) => (g.beginPath(), g.arc(at[0] * w, at[1] * h, r * h, 0, Math.PI * 2), (g.fillStyle = color), g.fill());
    spot(ACTS.eat.at!, "#c3251f", 0.035);
    spot(ACTS.rest.at!, "#8f877a", 0.07);
    spot(ACTS.play.at!, "#2f5fa7", 0.02);
    spot([me.x, me.y], "#1a1a1a", 0.03);
    spot([me.x + 0.012, me.y - 0.012], "#fe0386", 0.008);
  };

  void load().then(() => {
    const drives = new Drives<Need>({ hunger: 1, tired: 1, bored: 1 });
    drives.set({ hunger: 0.35, tired: 0.2, bored: 0.5 });
    mind = { drives, chooser: new Chooser<Act>({ rng: seededRng(7), options: Object.keys(ACTS) as Act[], start: "explore" }) };
  });
  raf = requestAnimationFrame(tick);
  const throwBall = () => {
    ACTS.play.at = [0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6];
    mind?.drives.set({ bored: Math.min(1, mind.drives.values.bored + 0.4) });
  };
  $("[data-throw]").addEventListener("click", throwBall);
  $("[data-hungry]").addEventListener("click", () => mind?.drives.set({ hunger: Math.min(1, mind.drives.values.hunger + 0.4) }));

  const lay = layout(root);
  // the built in sample: the ball flies and boredom jumps
  const sample = async () => {
    throwBall();
    await sleep(800);
  };
  return {
    sample,
    dispose: () => {
      cancelAnimationFrame(raf);
      if (mind) (mind.drives.free(), mind.chooser.free());
      mind = null;
      bars.dispose();
      lay.dispose();
      host.innerHTML = "";
    },
  };
}
