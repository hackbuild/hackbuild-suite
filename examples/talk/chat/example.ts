// chat with a small model: a chat pane and a composer on one thread, and a
// model pick that hands the thread its engine once a model is loaded. Until
// then a scripted engine answers, so the page replies on a first visit.
import { scripted, type ChatEngine } from "@hackbuild/chat";
import { chatList, useModelPick } from "@hackbuild/ai-views";
import { define } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, stubLoaderOf, type Example } from "../../shared/fixtures.js";

// stands in for a model: it answers from this list, in small pieces
const script = scripted({
  replies: [
    "hi. i run in this tab, so nothing you type leaves it. ask me to draft, plan or explain something.",
    "short version: the model is a file your browser keeps. once it is loaded, replies are written here, on your gpu.",
  ],
  chunk: 5,
});

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-conversation">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread"><chat-pane id="talk-chat" empty-name="what are we working on?" empty-note="say anything. a scripted reply answers until you load a model from the chip in the bar."></chat-pane></div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-chat" placeholder="say something"></chat-composer></div></div>
        </section>
      </div>
    </div>`);

  // the pick: every chat model the catalogue knows, fitted to this machine.
  // a real page passes weightsLoader(store) or its runtime's loader here.
  const pick = useModelPick("chat", { env: FIXTURE_ENV, loader: stubLoaderOf(script) });
  const list = chatList({ engine: script, system: "you are a short, plain helper." });
  const pane = root.querySelector("chat-pane") as HTMLElement & { list: typeof list };
  pane.list = list;
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded") list.setEngine(s.loaded as ChatEngine);
  });
  const lay = layout(root);
  // the built in sample: one message, answered by the script
  const sample = () => list.thread.send("what can you do?");
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
