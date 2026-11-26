// a character card in and out: @hackbuild/character reads a card from a
// png, a charx archive or json (v1, v2 or v3), upgrades it to v3, checks it,
// and writes it back into a png. a sample card is read on first view.
import { loadCharacterCore, type Card, type CharacterCore } from "@hackbuild/character";
import { CHARACTER_WASM_BASE64 } from "@hackbuild/character/inline";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { draw, type Example } from "../../shared/fixtures.js";

const SAMPLE = {
  spec: "chara_card_v2",
  spec_version: "2.0",
  data: { name: "pip", description: "a small brass robot who keeps the workshop tidy.", personality: "patient, dry, fond of labels.", scenario: "", first_mes: "the bench is clear. what are we making?", mes_example: "", creator_notes: "", system_prompt: "", post_history_instructions: "", alternate_greetings: [], tags: ["workshop"], creator: "", character_version: "1", extensions: {} },
};
const FIELDS = ["name", "description", "first_mes"] as const;
const LABELS = { name: "name", description: "who they are", first_mes: "first line" };

export default function mount(host: HTMLElement): Example {
  const root = draw(host, `
    <div class="hb-lay hb is-form-frame">
      <div class="hb-lay-body">
        <section class="hb-lay-stage"><div class="hb-lay-subject">
          <section class="hb-panel">
            <div class="hb-panel-hd-inst" id="cc-from">reading the sample</div>
            <img id="cc-img" alt="" width="96" height="96" hidden />
            <p class="hb-marker" id="cc-name"></p>
            <p id="cc-desc"></p>
            <p class="hb-note" id="cc-first"></p>
            <p class="hb-note" id="cc-check"></p>
          </section>
        </div></section>
        <aside class="hb-rack" aria-label="card">
          <nav class="hb-tabs" role="tablist" aria-label="card tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">card</button><button type="button" class="hb-tab" role="tab" aria-selected="false">open</button><button type="button" class="hb-tab" role="tab" aria-selected="false">json</button></nav>
          <section class="hb-rack-pane">
            ${FIELDS.map((f) => `<label class="hb-field"><span class="hb-label">${LABELS[f]}</span><textarea class="hb-input" rows="${f === "name" ? 1 : 3}" data-field="${f}"></textarea></label>`).join("")}
            <p><button type="button" class="hb-btn hb-btn-go" id="cc-save">save as png</button></p>
          </section>
          <section class="hb-rack-pane" hidden><label class="hb-field"><span class="hb-label">a card file: png, charx or json</span><input class="hb-input" type="file" accept=".png,.charx,.json" id="cc-file" /></label></section>
          <section class="hb-rack-pane" hidden><div class="hb-codeblock"><pre><code id="cc-json"></code></pre></div></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">the card core is wasm in this page. nothing is sent anywhere; saving writes the card into the png's text chunks.</p></div></details>
        </aside>
      </div>
    </div>`);
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const fields = [...root.querySelectorAll<HTMLTextAreaElement>("[data-field]")];
  let cc: CharacterCore | null = null;
  let card: Card | null = null;
  let png: Uint8Array | null = null;

  // show a card: v3 after upgrade, its problems, and the png it would write
  function show(c: Card, from: string): void {
    const v3 = cc!.upgrade(c);
    card = v3;
    const d = v3.data as unknown as Record<string, string>;
    for (const f of fields) f.value = d[f.dataset.field!] ?? "";
    $("cc-from").textContent = from;
    $("cc-name").textContent = d.name ?? "";
    $("cc-desc").textContent = d.description ?? "";
    $("cc-first").textContent = d.first_mes ? `first line: ${d.first_mes}` : "";
    const problems = cc!.validate(v3);
    $("cc-check").textContent = problems.length ? problems.join(". ") : "a valid v3 card.";
    $("cc-json").textContent = JSON.stringify(v3, null, 2);
    png = cc!.writePng(v3, { image: png ?? cc!.blankPng(96, 96, 0xfe0386) });
    const img = $<HTMLImageElement>("cc-img");
    URL.revokeObjectURL(img.src);
    img.src = URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
    img.hidden = false;
  }
  // read bytes in: the format is found from the bytes
  function read(bytes: Uint8Array, name: string): void {
    const r = cc!.read(bytes);
    show(r.card as unknown as Card, `${name}: ${r.format}, ${r.spec.replace(/_/g, " ")}`);
  }
  const ready = loadCharacterCore({ base64: CHARACTER_WASM_BASE64 }).then((core) => {
    cc = core;
    show(SAMPLE as unknown as Card, "the sample card, read as json");
  });

  for (const f of fields)
    f.addEventListener("input", () => {
      if (!card) return;
      (card.data as unknown as Record<string, string>)[f.dataset.field!] = f.value;
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
    a.download = `${(card.data as unknown as Record<string, string>).name || "card"}.png`;
    a.click();
  });
  const lay = layout(root);
  // the built in sample: the png this page wrote, read back in
  const sample = async () => (await ready, read(png!, "the png written here"));
  return { sample, dispose: () => (lay.dispose(), (host.innerHTML = "")) };
}
