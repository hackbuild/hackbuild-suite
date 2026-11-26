// answer as json to a schema: the engine asks the model for json that fits
// a schema (grammar constrained where the runtime can, the schema in the
// prompt where it cannot), and @hackbuild/structured repairs what small
// models get wrong before the answer is checked against the schema. load a
// model from the chip in the bar; until then a written sample shows the shape.
import { probe, type Env } from "@hackbuild/ai-env";
import type { ChatEngine, JsonSchema } from "@hackbuild/chat";
import { parseLooseJSON, sanitizeSchema } from "@hackbuild/structured";
import { jobLoader, useModelPick, type Job, type Loader } from "@hackbuild/ai-views";
import { layout } from "@virgilvox/hackbuild-ui/vanilla";

/** Stand ins a test may pass for this machine and the network. A page passes nothing. */
export interface Hooks {
  env?: Env;
  loaderFor?: (job: Job) => Loader;
}

const SCHEMA = {
  type: "object",
  properties: { project: { type: "string" }, parts: { type: "array", items: { type: "string" } }, hours: { type: "number" } },
  required: ["project", "parts", "hours"],
};
const SAMPLE_ASK = "a weekend project: a plant sensor that tells me when to water";
const SAMPLE_JSON = { project: "plant sensor", parts: ["soil probe", "esp32", "battery"], hours: 5 };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
// json as light text on paper: one line per line, indents kept
const lines = (s: string) => `<p>${esc(s).replace(/^( +)/gm, (m) => "&nbsp;".repeat(m.length)).replace(/\n/g, "<br>")}</p>`;
const turn = (who: "you" | "json", body: string) =>
  `<div class="hb-msg${who === "you" ? " is-user" : ""}"><span class="hb-msg-who"><span class="hb-msg-name">${who}</span></span><div class="hb-msg-parts">${body}</div></div>`;

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

export default function mount(host: HTMLElement, hooks: Hooks = {}) {
  host.innerHTML = `
    <div class="hb-lay hb is-conversation has-rack">
      <div class="hb-lay-body">
        <section class="hb-lay-stage">
          <div class="hb-lay-subject" role="log" aria-live="polite">
            <div class="hb-lay-thread" id="json-thread"><p class="hb-note">sample, no model loaded</p>${turn("you", `<p>${esc(SAMPLE_ASK)}</p>`)}${turn("json", lines(JSON.stringify(SAMPLE_JSON, null, 2)))}</div>
          </div>
          <div class="hb-lay-composer"><div class="hb-lay-thread"><form class="hb-convbox" id="json-form"><textarea rows="1" aria-label="what you want as json" placeholder="ask for a project as json" id="json-ask"></textarea><button type="submit" class="hb-btn hb-btn-go">send</button></form></div></div>
        </section>
        <aside class="hb-rack" aria-label="json">
          <nav class="hb-tabs" role="tablist" aria-label="json tabs"><button type="button" class="hb-tab" role="tab" aria-selected="true">check</button><button type="button" class="hb-tab" role="tab" aria-selected="false">schema</button><button type="button" class="hb-tab" role="tab" aria-selected="false">raw</button></nav>
          <section class="hb-rack-pane"><p class="hb-note" id="json-check">the sample fits the schema.</p></section>
          <section class="hb-rack-pane" hidden><label class="hb-field"><span class="hb-label">json schema</span><textarea class="hb-input" rows="12" id="json-schema" spellcheck="false"></textarea></label></section>
          <section class="hb-rack-pane" hidden><p class="hb-note">what the model wrote, before repair:</p><p class="hb-note" id="json-raw">nothing yet.</p></section>
          <details class="hb-rack-detail" data-ux="detail"><summary>detail</summary><div><p class="hb-note">the schema goes to the runtime as a grammar where it takes one, and into the prompt where it does not. the repair fixes trailing commas, quotes and fences.</p></div></details>
        </aside>
      </div>
    </div>`;
  const root = host.firstElementChild as HTMLElement;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector(`#${id}`) as T;
  const thread = $("json-thread");
  $<HTMLTextAreaElement>("json-schema").value = JSON.stringify(SCHEMA, null, 2);

  // every chat model the catalogue knows; jobLoader fetches the runtime and weights on load
  const pick = useModelPick("chat", { ...(hooks.env ? { env: hooks.env } : {}), loader: hooks.loaderFor?.("chat") ?? jobLoader("chat") });
  if (!hooks.env) void probe().then((env) => pick.update({ env }));
  let engine: ChatEngine | null = null;
  const off = pick.subscribe((s) => {
    if (s.row?.state === "loaded") engine = s.loaded as ChatEngine;
  });

  let fresh = true;
  async function ask(text: string): Promise<void> {
    if (!text.trim()) return;
    if (fresh) (thread.innerHTML = ""), (fresh = false);
    thread.insertAdjacentHTML("beforeend", turn("you", `<p>${esc(text)}</p>`));
    if (!engine) {
      thread.insertAdjacentHTML("beforeend", turn("json", "<p>no model loaded yet. load one from the chip in the bar, then send again.</p>"));
      $("json-check").textContent = "nothing to check: no model answered.";
      return;
    }
    let schema: typeof SCHEMA;
    try {
      schema = JSON.parse($<HTMLTextAreaElement>("json-schema").value);
    } catch {
      $("json-check").textContent = "the schema is not valid json. fix it in the schema tab.";
      return;
    }
    const r = await engine.complete(
      [{ role: "system", content: "answer with json only." }, { role: "user", content: text }],
      { schema: sanitizeSchema(schema as JsonSchema) },
    );
    $("json-raw").textContent = r.text;
    const value = parseLooseJSON(r.text);
    thread.insertAdjacentHTML("beforeend", turn("json", lines(value === null ? r.text : JSON.stringify(value, null, 2))));
    const problems = value === null ? ["nothing in the reply parses as json"] : check(value, schema);
    $("json-check").textContent = problems.length ? problems.join(". ") + "." : "fits the schema.";
  }
  const box = $<HTMLTextAreaElement>("json-ask");
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) (e.preventDefault(), $<HTMLFormElement>("json-form").requestSubmit());
  });
  $("json-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const t = box.value;
    box.value = "";
    void ask(t);
  });
  const lay = layout(root);
  // the conversation is the thread and its composer together, beside the rack
  root.querySelector<HTMLElement>(".hb-lay-subject")!.removeAttribute("data-ux");
  root.querySelector<HTMLElement>(".hb-lay-stage")!.dataset.ux = "subject";
  root.querySelector<HTMLElement>(".hb-lay-composer")!.dataset.ux = "verbs";
  return {
    pick,
    // what the gate runs: one request, answered by whatever is loaded
    sample: () => ask("a desk lamp i can build in an evening"),
    dispose: () => (off(), lay.dispose(), (host.innerHTML = "")),
  };
}
