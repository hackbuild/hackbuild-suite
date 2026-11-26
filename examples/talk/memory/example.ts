// remember facts across chats: a @hackbuild/memory store recalls what fits
// each message, the thread adds it to the prompt, and the reply shows what
// it used. the inspector says why each line was found. recall runs on a
// hashed embedder with no download; loading an embedding model re-embeds.
import { scripted } from "@hackbuild/chat";
import { hashedEmbedder, loadCore, memorySink, open, type Embedder, type Memory } from "@hackbuild/memory";
import { MEMORY_WASM_BASE64 } from "@hackbuild/memory/inline";
import { chatList, useModelPick, type MemoryUsed, type RecallLike } from "@hackbuild/ai-views";
import { define } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, stubLoaderOf, type Example } from "../../shared/fixtures.js";

const FACTS = ["you print in petg, not pla", "the laser cutter is booked on tuesdays", "the dog collar needs a buckle", "your bench is in the garage"];

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-conversation has-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread"><chat-pane id="talk-mem" empty-name="what do you remember?" empty-note="ask about your bench, or say remember that, and a fact. it stays for every chat in this tab."></chat-pane></div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-mem" placeholder="ask, or say remember that"></chat-composer></div></div>
        </section>
        <aside class="hb-rack" aria-label="memory">
          <nav class="hb-tabs" role="tablist" aria-label="memory tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">recalled</button><button type="button" class="hb-tab" role="tab" aria-selected="false">chats</button><button type="button" class="hb-tab" role="tab" aria-selected="false">remembered</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><memory-inspector id="mem-why"></memory-inspector></section>
          <section class="hb-rack-pane" hidden><chat-list for="talk-mem"></chat-list></section>
          <section class="hb-rack-pane" hidden><ul class="hb-list" id="mem-all"></ul></section>
          <section class="hb-rack-pane" hidden><model-select job="embed" id="mem-model"></model-select></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: replies are scripted. recall is real: the memory core in wasm, keyword and hashed vector search fused.</p></div></details>
        </aside>
      </div>
    </div>`);
  const why = root.querySelector("#mem-why") as HTMLElement & { recall: RecallLike | null };
  const all = root.querySelector("#mem-all") as HTMLUListElement;

  let mem: Memory | null = null;
  const sink = memorySink();
  const core = loadCore({ base64: MEMORY_WASM_BASE64 });
  const opened = (embed: Embedder) => core.then((c) => open("talk-memory", { core: c, embed, sink })).then((m) => (mem = m));
  const ready = opened(hashedEmbedder()).then(async (m) => {
    for (const f of FACTS) await m.add(f, { kind: "fact" });
    shown();
  });
  const shown = () => (all.innerHTML = (mem?.all() ?? []).map((i) => `<li>${i.text.replace(/</g, "&lt;")}</li>`).join(""));

  let used: MemoryUsed[] = [];
  const recall = async (q: string): Promise<MemoryUsed[]> => {
    await ready;
    const r = await mem!.recall(q, { k: 3 });
    why.recall = r;
    used = r.hits.map((h) => ({ label: h.item.text, score: Math.min(1, h.score) }));
    return used;
  };
  // stands in for a model: it saves "remember that" lines and answers from what was recalled
  const script = scripted({
    replies: (req) => {
      const said = req.messages.at(-1)?.content ?? "";
      const fact = /^remember( that)?\s+(.+)/i.exec(said.trim());
      if (fact) {
        void mem?.add(fact[2]!, { kind: "fact" }).then(shown);
        return "noted. ask me in any chat and i will find it.";
      }
      return used.length ? `from memory: ${used[0]!.label}.` : "nothing in memory fits that yet.";
    },
    chunk: 5,
  });
  const list = chatList({ engine: script, recall, system: "answer from memory when it fits." });
  (root.querySelector("chat-pane") as HTMLElement & { list: typeof list }).list = list;

  // the pick: embedding models. once one loads, the store re-embeds with it.
  const pick = useModelPick("embed", { env: FIXTURE_ENV, loader: stubLoaderOf(hashedEmbedder(512)) });
  (root.querySelector("#mem-model") as HTMLElement & { pick: typeof pick }).pick = pick;
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded" && s.loaded) void opened(s.loaded as Embedder).then(shown);
  });
  const lay = layout(root);
  // the conversation is the thread and its composer together, beside the rack
  root.querySelector<HTMLElement>(".hb-lay-subject")!.removeAttribute("data-ux");
  root.querySelector<HTMLElement>(".hb-lay-stage")!.dataset.ux = "subject";
  root.querySelector<HTMLElement>(".hb-lay-composer")!.dataset.ux = "verbs";
  // the built in sample: a question whose answer is in memory
  const sample = async () => (await ready, await list.thread.send("what filament do i print with?"));
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
