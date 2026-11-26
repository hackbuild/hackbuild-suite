// a character card in and out: @hackbuild/character reads a card from a
// png, a charx archive or json (v1, v2 or v3), upgrades it to v3, checks it
// and writes it back into a png. the card becomes the system prompt of a
// chat: load a model from the chip in the bar and talk to the character.
import { probe, type Env } from "@hackbuild/ai-env";
import type { ChatEngine } from "@hackbuild/chat";
import { loadCharacterCore, type Card, type CharacterCore } from "@hackbuild/character";
import { CHARACTER_WASM_BASE64 } from "@hackbuild/character/inline";
import { chatList, jobLoader, useModelPick, type ChatList, type Job, type Loader } from "@hackbuild/ai-views";
import { define, turnHtml } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

const CARD = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "pip", description: "a small brass robot who keeps the workshop tidy.", personality: "patient, dry, fond of labels.", scenario: "", first_mes: "the bench is clear. what are we making?", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: ["workshop"], creator: "", character_version: "1", extensions: {} },
};
const FIELDS = { name: "name", description: "who they are", first_mes: "first line" } as const;
type Data = Record<string, string>;

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  define();
  host.innerHTML = `
    <div class="hb-lay hb is-conversation has-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread"><chat-pane id="talk-card" empty-name="pip"></chat-pane><div id="cc-sample"></div></div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><chat-composer for="talk-card" placeholder="say something to the character"></chat-composer></div></div>
        </section>
        <aside class="hb-rack" aria-label="card">
          <nav class="hb-tabs" role="tablist" aria-label="card tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">card</button><button type="button" class="hb-tab" role="tab" aria-selected="false">open</button><button type="button" class="hb-tab" role="tab" aria-selected="false">json</button></nav>
          <section class="hb-rack-pane">
            <p class="hb-note" id="cc-from">reading the sample card</p>
            ${Object.entries(FIELDS).map(([f, l]) => `<label class="hb-field"><span class="hb-label">${l}</span><textarea class="hb-input" rows="${f === "name" ? 1 : 3}" data-field="${f}"></textarea></label>`).join("")}
            <p class="hb-note" id="cc-check"></p>
            <p><img id="cc-img" alt="the card as a png" width="64" height="64" hidden /> <button type="button" class="hb-btn" id="cc-save">save as png</button></p>
          </section>
          <section class="hb-rack-pane" hidden><label class="hb-field"><span class="hb-label">a card file: png, charx or json</span><input class="hb-input" type="file" accept=".png,.charx,.json" id="cc-file" /></label></section>
          <section class="hb-rack-pane" hidden><p class="hb-note" id="cc-json"></p></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the card core is wasm in this page. saving writes the card into the png text chunks; nothing is sent anywhere.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const pane = root.querySelector("chat-pane") as HTMLElement & { list: ChatList };
  const fields = [...root.querySelectorAll<HTMLTextAreaElement>("[data-field]")];
  let cc: CharacterCore | null = null;
  let card: Card | null = null;
  let png: Uint8Array | null = null;
  let engine: ChatEngine | null = null;
  let list: ChatList | null = null;
  let offTurns = () => {};

  // the card is the system prompt; a new card starts a new chat
  function chatWith(d: Data): void {
    offTurns();
    list = chatList({ system: `you are ${d.name}. ${d.description} ${d.personality ?? ""} stay in character.`, noEngine: "no model loaded yet. load one from the chip in the bar, then say it again." });
    if (engine) list.setEngine(engine);
    pane.list = list;
    pane.setAttribute("empty-name", d.name || "a character");
    const first = { id: -1, role: "assistant" as const, text: d.first_mes || "hello.", think: "", at: 0, done: true };
    $("cc-sample").innerHTML = `<p class="hb-note">sample, no model loaded. the first line is the card's own.</p>${turnHtml(first, { name: d.name || "reply", last: false, busy: false })}`;
    offTurns = list.thread.subscribe((s) => ($("cc-sample").hidden = s.turns.length > 0));
  }
  // show a card: v3 after upgrade, its problems, and the png it would write
  function show(c: Card, from: string, restart = true): void {
    const v3 = cc!.upgrade(c);
    card = v3;
    const d = v3.data as unknown as Data;
    for (const f of fields) if (document.activeElement !== f) f.value = d[f.dataset.field!] ?? "";
    $("cc-from").textContent = from;
    const problems = cc!.validate(v3);
    $("cc-check").textContent = problems.length ? problems.join(". ") : "a valid v3 card.";
    $("cc-json").innerText = JSON.stringify(v3, null, 2);
    png = cc!.writePng(v3, { image: png ?? cc!.blankPng(96, 96, 0xfe0386) });
    const img = $<HTMLImageElement>("cc-img");
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    img.hidden = false;
    if (restart) chatWith(d);
  }
  const read = (bytes: Uint8Array, name: string) => {
    const r = cc!.read(bytes);
    show(r.card as unknown as Card, `${name}: ${r.format}, ${r.spec.replace(/_/g, " ")}`);
  };
  const ready = loadCharacterCore({ base64: CHARACTER_WASM_BASE64 }).then((core) => {
    cc = core;
    show(CARD as unknown as Card, "the sample card, read as json");
  });

  const pick = useModelPick("chat", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("chat") ?? jobLoader("chat") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  const offPick = pick.subscribe((s) => {
    if (s.row?.state !== "loaded") return;
    engine = s.loaded as ChatEngine;
    list?.setEngine(engine);
  });

  for (const f of fields)
    f.addEventListener("change", () => {
      if (!card) return;
      (card.data as unknown as Data)[f.dataset.field!] = f.value;
      show(card, "edited here");
    });
  $<HTMLInputElement>("cc-file").addEventListener("change", async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file || !cc) return;
    png = null;
    try {
      read(new Uint8Array(await file.arrayBuffer()), file.name);
    } catch (err) {
      $("cc-check").textContent = `${file.name} is not a card this core reads. ${err instanceof Error ? err.message : ""}`;
    }
  });
  $("cc-save").addEventListener("click", () => {
    if (!png || !card) return;
    const a = document.createElement("a");
    a.href = $<HTMLImageElement>("cc-img").src;
    a.download = `${(card.data as unknown as Data).name || "card"}.png`;
    a.click();
  });
  const lay = layout(root);
  // the conversation is the thread and its composer together, beside the rack
  root.querySelector<HTMLElement>(".hb-lay-subject")!.removeAttribute("data-ux");
  root.querySelector<HTMLElement>(".hb-lay-stage")!.dataset.ux = "subject";
  root.querySelector<HTMLElement>(".hb-lay-composer")!.dataset.ux = "verbs";
  return {
    pick,
    // what the gate runs: the png written here read back in, then a hello to the character
    sample: async () => (await ready, read(png!, "the png written here"), await list!.thread.send("hello")),
    dispose: () => (offTurns(), offPick(), lay.dispose(), (host.innerHTML = "")),
  };
}
