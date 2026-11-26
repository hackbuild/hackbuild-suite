// chat with a small model: a chat pane and a composer on one thread, and a
// model pick that loads a real chat model in this tab (its size is on the
// load button) and hands the thread its engine. Until then a written sample
// shows what a reply looks like, labelled as one.
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
  { id: -2, role: "user", text: "what can you do for me?", think: "", at: 0, done: true },
  { id: -1, role: "assistant", text: "draft, plan and explain, in this tab. load a model from the chip in the bar and ask me anything.", think: "", at: 0, done: true },
];

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-conversation">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread">
              <chat-pane id="talk-chat" empty-name="what are we working on?"></chat-pane>
              <div id="talk-chat-sample"><p class="hb-note">sample, no model loaded</p>${SAMPLE.map((t) => turnHtml(t, { name: "reply", last: false, busy: false })).join("")}</div>
            </div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-chat" placeholder="say something"></chat-composer></div></div>
        </section>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;

  // every chat model the catalogue knows, fitted to this machine; jobLoader
  // fetches the runtime and the weights only when load is pressed
  const pick = useModelPick("chat", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("chat") ?? jobLoader("chat") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));

  const list = chatList({ system: "you are a short, plain helper.", noEngine: "no model loaded yet. load one from the chip in the bar, then ask again." });
  (root.querySelector("chat-pane") as HTMLElement & { list: typeof list }).list = list;
  const sample = root.querySelector("#talk-chat-sample") as HTMLElement;
  const offTurns = list.thread.subscribe((s) => (sample.hidden = s.turns.length > 0));
  const offPick = pick.subscribe((s) => {
    if (s.row?.state === "loaded") list.setEngine(s.loaded as ChatEngine);
  });
  const lay = layout(root);
  return {
    pick,
    // what the gate runs: one message, answered by whatever is loaded
    sample: () => list.thread.send("what can you do?"),
    dispose: () => (offTurns(), offPick(), lay.dispose(), (host.innerHTML = "")),
  };
}
