// answer as json to a schema: the engine asks the model for json that fits
// a schema (grammar constrained where the runtime can, the schema in the
// prompt where it cannot), and @hackbuild/structured repairs what small
// models get wrong before the answer is checked against the schema.
import { scripted, type ChatEngine, type JsonSchema } from "@hackbuild/chat";
import { parseLooseJSON, sanitizeSchema } from "@hackbuild/structured";
import { useModelPick } from "@hackbuild/ai-views";
import { define } from "@hackbuild/ai-views/elements";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";
import { FIXTURE_ENV, draw, stubLoaderOf, type Example } from "../../shared/fixtures.js";

const SCHEMA = {
  type: "object",
  properties: { project: { type: "string" }, parts: { type: "array", items: { type: "string" } }, hours: { type: "number" } },
  required: ["project", "parts", "hours"],
};
// stands in for a small model: right shape, with the trailing comma they often leave
const script = scripted({
  schema: true,
  replies: (req) => {
    const ask = req.messages.at(-1)?.content.toLowerCase() ?? "";
    const lamp = ask.includes("lamp");
    return `{"project": "${lamp ? "desk lamp" : "plant sensor"}", "parts": ${lamp ? '["led strip", "switch", "usb cable",]' : '["soil probe", "esp32", "battery",]'}, "hours": ${lamp ? 3 : 5},}`;
  },
});

/** Problems with a value against the schema's required keys and their types; empty when it fits. */
function check(v: unknown, s: typeof SCHEMA): string[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return ["the answer is not an object"];
  const o = v as Record<string, unknown>;
  return s.required.flatMap((k) => {
    const want = s.properties[k as keyof typeof s.properties].type;
    const got = Array.isArray(o[k]) ? "array" : typeof o[k];
    return k in o ? (got === want ? [] : [`${k} is ${got}, the schema wants ${want}`]) : [`${k} is missing`];
  });
}

export default function mount(host: HTMLElement): Example {
  define();
  const root = draw(host, `
    <div class="hb-lay hb is-form-frame">
      <div class="hb-lay-body">
        <section class="hb-lay-stage"><div class="hb-lay-subject">
          <section class="hb-panel">
            <div class="hb-panel-hd-inst">the answer</div>
            <div class="hb-codeblock"><pre><code id="json-out">asking.</code></pre></div>
            <p class="hb-note" id="json-check"></p>
          </section>
        </div></section>
        <aside class="hb-rack" aria-label="json">
          <nav class="hb-tabs" role="tablist" aria-label="json tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">ask</button><button type="button" class="hb-tab" role="tab" aria-selected="false">schema</button><button type="button" class="hb-tab" role="tab" aria-selected="false">raw</button><button type="button" class="hb-tab" role="tab" aria-selected="false">model</button></nav>
          <section class="hb-rack-pane"><label class="hb-field"><span class="hb-label">what you want</span><textarea class="hb-input" rows="4" id="json-ask">a weekend project: a plant sensor that tells me when to water</textarea></label>
            <p><button type="button" class="hb-btn hb-btn-go" id="json-go">answer as json</button></p></section>
          <section class="hb-rack-pane" hidden><label class="hb-field"><span class="hb-label">json schema</span><textarea class="hb-input" rows="12" id="json-schema" spellcheck="false"></textarea></label></section>
          <section class="hb-rack-pane" hidden><p class="hb-note">what the model wrote, before repair:</p><div class="hb-codeblock"><pre><code id="json-raw">nothing yet.</code></pre></div></section>
          <section class="hb-rack-pane" hidden><model-select job="chat" id="json-model"></model-select></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-fixture">fixture: replies are scripted, with a trailing comma left in so the repair has work to do. no model runs here.</p></div></details>
        </aside>
      </div>
    </div>`);
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  $<HTMLTextAreaElement>("json-schema").value = JSON.stringify(SCHEMA, null, 2);

  // a real page passes weightsLoader(store) or its runtime's loader here
  const pick = useModelPick("chat", { env: FIXTURE_ENV, loader: stubLoaderOf(script) });
  ($("json-model") as HTMLElement & { pick: typeof pick }).pick = pick;
  let engine: ChatEngine = script;
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded") engine = s.loaded as ChatEngine;
  });

  async function ask(): Promise<void> {
    let schema: typeof SCHEMA;
    try {
      schema = JSON.parse($<HTMLTextAreaElement>("json-schema").value);
    } catch {
      $("json-check").textContent = "the schema is not valid json. fix it in the schema tab.";
      return;
    }
    $("json-out").textContent = "asking.";
    const r = await engine.complete(
      [{ role: "system", content: "answer with json only." }, { role: "user", content: $<HTMLTextAreaElement>("json-ask").value }],
      { schema: sanitizeSchema(schema as JsonSchema) },
    );
    $("json-raw").textContent = r.text;
    const value = parseLooseJSON(r.text);
    $("json-out").textContent = value === null ? r.text : JSON.stringify(value, null, 2);
    const problems = value === null ? ["nothing in the reply parses as json"] : check(value, schema);
    $("json-check").textContent = problems.length ? problems.join(". ") + "." : "fits the schema.";
  }
  $("json-go").addEventListener("click", () => void ask());
  const lay = layout(root);
  void ask();
  // the built in sample: a second request through the same schema
  const sample = async () => {
    $<HTMLTextAreaElement>("json-ask").value = "a desk lamp i can build in an evening";
    await ask();
  };
  return { pick, sample, dispose: () => (off(), lay.dispose(), (host.innerHTML = "")) };
}
