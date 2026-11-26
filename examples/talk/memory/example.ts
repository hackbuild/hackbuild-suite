// remember facts across chats: a @hackbuild/memory store recalls what fits
// each message, the thread adds it to the prompt, and the reply shows what
// it used. the inspector says why each line was found. recall starts on the
// hashed embedder (no download); an embedding model from the chip in the bar
// re-embeds the store, and a chat model from the rack writes the replies.
import { probe, type Env } from "@hackbuild/ai-env";
import type { ChatEngine } from "@hackbuild/chat";
import { hashedEmbedder, loadCore, memorySink, open, type Embedder, type Memory } from "@hackbuild/memory";
import { MEMORY_WASM_BASE64 } from "@hackbuild/memory/inline";
import { chatList, jobLoader, useModelPick, type Job, type Loader, type MemoryUsed, type RecallLike, type Turn } from "@hackbuild/ai-views";
import { define, turnHtml } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

const FACTS = ["you print in petg, not pla", "the laser cutter is booked on tuesdays", "the dog collar needs a buckle", "your bench is in the garage"];
// a sample exchange, written here, shown until a chat model answers for real
const SAMPLE: Turn[] = [
  { id: -2, role: "user", text: "what filament do i print with?", think: "", at: 0, done: true },
  { id: -1, role: "assistant", text: "petg. you said you print in petg, not pla.", think: "", at: 0, done: true, mem: [{ label: FACTS[0]!, score: 0.82 }] },
];

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-conversation has-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread">
              <chat-pane id="talk-mem" empty-name="what do you remember?"></chat-pane>
              <div id="talk-mem-sample"><p class="hb-note">sample, no model loaded</p>${SAMPLE.map((t) => turnHtml(t, { name: "reply", last: false, busy: false })).join("")}</div>
            </div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-mem" placeholder="ask, or say remember that"></chat-composer></div></div>
        </section>
        <aside class="hb-rack" aria-label="memory">
          <nav class="hb-tabs" role="tablist" aria-label="memory tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">recalled</button><button type="button" class="hb-tab" role="tab" aria-selected="false">remembered</button><button type="button" class="hb-tab" role="tab" aria-selected="false">replies</button></nav>
          <section class="hb-rack-pane"><memory-inspector id="mem-why"></memory-inspector><p class="hb-note" id="mem-none">ask something and the lines memory found show here, with why.</p></section>
          <section class="hb-rack-pane" hidden><ul class="hb-list" id="mem-all"></ul></section>
          <section class="hb-rack-pane" hidden><p class="hb-note">the chat model that writes the replies.</p><model-select job="chat" id="mem-chat"></model-select></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">recall runs the memory core in wasm: keyword and vector search fused. the hashed embedder needs no download.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const why = root.querySelector("#mem-why") as HTMLElement & { recall: RecallLike | null };
  const all = root.querySelector("#mem-all") as HTMLUListElement;

  let mem: Memory | null = null;
  const sink = memorySink();
  const core = loadCore({ base64: MEMORY_WASM_BASE64 });
  const shown = () => (all.innerHTML = (mem?.all() ?? []).map((i) => `<li>${i.text.replace(/</g, "&lt;")}</li>`).join(""));
  const opened = (embed: Embedder) => core.then((c) => open("talk-memory", { core: c, embed, sink })).then((m) => (mem = m));
  const ready = opened(hashedEmbedder()).then(async (m) => {
    for (const f of FACTS) await m.add(f, { kind: "fact" });
    shown();
  });

  // "remember that ..." is stored before the reply; every message recalls
  const recall = async (q: string): Promise<MemoryUsed[]> => {
    await ready;
    const fact = /^remember( that)?\s+(.+)/i.exec(q.trim());
    if (fact) await mem!.add(fact[2]!, { kind: "fact" }).then(shown);
    const r = await mem!.recall(q, { k: 3 });
    why.recall = r;
    root.querySelector<HTMLElement>("#mem-none")!.hidden = true;
    return r.hits.map((h) => ({ label: h.item.text, score: Math.min(1, h.score) }));
  };
  const list = chatList({ recall, system: "answer from memory when it fits. when told to remember, say it is noted.", noEngine: "no chat model loaded yet. load one in the replies tab. memory still found the lines under this." });
  (root.querySelector("chat-pane") as HTMLElement & { list: typeof list }).list = list;
  const sampleEl = root.querySelector("#talk-mem-sample") as HTMLElement;
  const offTurns = list.thread.subscribe((s) => (sampleEl.hidden = s.turns.length > 0));

  // the chip: embedding models; once one loads, the store re-embeds with it
  const env = hooks.env ? { env: hooks.env } : {};
  const pick = useModelPick("embed", { ...env, loader: hooks.loaderFor?.("embed") ?? jobLoader("embed") });
  const chat = useModelPick("chat", { ...env, loader: hooks.loaderFor?.("chat") ?? jobLoader("chat") });
  if (!hooks.env) void probe().then((e) => (pick.update({ env: e }), chat.update({ env: e })));
  (root.querySelector("#mem-chat") as HTMLElement & { pick: typeof chat }).pick = chat;
  const offPick = pick.subscribe((s) => {
    if (s.row?.state === "loaded" && s.loaded) void opened(s.loaded as Embedder).then(shown);
  });
  const offChat = chat.subscribe((s) => {
    if (s.row?.state === "loaded") list.setEngine(s.loaded as ChatEngine);
  });
  const lay = layout(root);
  // the conversation is the thread and its composer together, beside the rack
  root.querySelector<HTMLElement>(".hb-lay-subject")!.removeAttribute("data-ux");
  root.querySelector<HTMLElement>(".hb-lay-stage")!.dataset.ux = "subject";
  root.querySelector<HTMLElement>(".hb-lay-composer")!.dataset.ux = "verbs";
  return {
    pick,
    // what the gate runs: a question whose answer is in memory
    sample: async () => (await ready, await list.thread.send("what filament do i print with?")),
    dispose: () => (offTurns(), offPick(), offChat(), lay.dispose(), (host.innerHTML = "")),
  };
}
