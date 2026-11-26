// a reply with its thinking folded: a model that reasons first writes its
// thinking between think tags. the engine streams it apart from the answer,
// and the chat pane keeps it in a fold above the reply. a scripted engine
// that thinks out loud answers until a model is loaded.
import { scripted, type ChatEngine } from "@hackbuild/chat";
import { chatList, useModelPick } from "@hackbuild/ai-views";
import { define } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, stubLoaderOf, type Example } from "../../shared/fixtures.js";

// stands in for a reasoning model: the think block streams first, then the answer
const script = scripted({
  replies: [
    "<think>they want a plan for a weekend build. keep it to three steps, name the part that takes longest, and say what to buy first.</think>three steps. order the parts first, since shipping is the slow part. print the case while you wait. wire and test on sunday.",
    "<think>a follow up. answer in one line and keep the same plain tone.</think>start with the part list. everything else waits on it.",
  ],
  chunk: 4,
});

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-conversation">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread"><chat-pane id="talk-think" empty-name="think it through." empty-note="ask for a plan. the thinking streams into a fold above the answer, so you can open it or leave it shut."></chat-pane></div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-think" placeholder="ask for a plan"></chat-composer></div></div>
        </section>
      </div>
    </div>`);

  // reasoning models are chat models; the pick lists them with the rest.
  // a real page passes weightsLoader(store) or its runtime's loader here.
  const pick = useModelPick("chat", { env: FIXTURE_ENV, loader: stubLoaderOf(script) });
  const list = chatList({ engine: script, system: "think first, then answer in plain words." });
  (root.querySelector("chat-pane") as HTMLElement & { list: typeof list }).list = list;
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded") list.setEngine(s.loaded as ChatEngine);
  });
  const lay = layout(root);
  // the built in sample: one question, answered with its thinking in the fold
  const sample = () => list.thread.send("plan a weekend build of a small robot");
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
