// a reply with its thinking folded: a model that reasons first writes its
// thinking between think tags. the engine streams it apart from the answer,
// and the chat pane keeps it in a fold above the reply. load a reasoning
// model from the chip in the bar; until then a written sample shows the
// shape, labelled as one.
import { probe, type Env } from "@hackbuild/ai-env";
import type { ChatEngine } from "@hackbuild/chat";
import { chatList, jobLoader, useModelPick, type Job, type Loader, type Turn } from "@hackbuild/ai-views";
import { define, turnHtml } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

// a sample exchange, written here, shown until a model answers for real
const SAMPLE: Turn[] = [
  { id: -2, role: "user", text: "plan a weekend build of a small robot", think: "", at: 0, done: true },
  {
    id: -1,
    role: "assistant",
    think: "they want a plan for a weekend. three steps, name the slow part, say what to buy first.",
    text: "three steps. order the parts first, since shipping is the slow part. print the case while you wait. wire and test on sunday.",
    at: 0,
    done: true,
  },
];

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-conversation">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread">
              <chat-pane id="talk-think" empty-name="think it through."></chat-pane>
              <div id="talk-think-sample"><p class="hb-note">sample, no model loaded</p>${SAMPLE.map((t) => turnHtml(t, { name: "reply", last: false, busy: false })).join("")}</div>
            </div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-think" placeholder="ask for a plan"></chat-composer></div></div>
        </section>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // reasoning models are chat models; jobLoader fetches the runtime and the
  // weights only when load is pressed
  const pick = useModelPick("chat", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("chat") ?? jobLoader("chat") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));

  const list = chatList({ system: "think first, then answer in plain words.", noEngine: "no model loaded yet. load a reasoning model from the chip in the bar, then ask again." });
  (root.querySelector("chat-pane") as HTMLElement & { list: typeof list }).list = list;
  const sample = root.querySelector("#talk-think-sample") as HTMLElement;
  const offTurns = list.thread.subscribe((s) => (sample.hidden = s.turns.length > 0));
  const offPick = pick.subscribe((s) => {
    if (s.row?.state === "loaded") list.setEngine(s.loaded as ChatEngine);
  });
  const lay = layout(root);
  return {
    pick,
    // what the gate runs: one question, answered by whatever is loaded
    sample: () => list.thread.send("plan a weekend build of a small robot"),
    dispose: () => (offTurns(), offPick(), lay.dispose(), (host.innerHTML = "")),
  };
}
