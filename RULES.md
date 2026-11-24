# Rules for working in this repository

Version 1, 2026-11-22. The hackbuild-3mf RULES.md cut for the browser 3D and
browser AI library family (hackbuild-motion, hackbuild-browser-ai,
hackbuild-agents, dog-simulator), with a Rust section and a model section
added. These rules are absolute. They apply to every file, every commit,
and every generated string, including code comments, UI copy, log output,
test fixtures and package metadata. Where any other document disagrees with
this one, this one wins.

## Attribution

- Never add Claude, any AI assistant, or any AI or LLM tool as an author,
  co-author, contributor, or credit. Not in commit messages, trailers
  (Co-Authored-By, Signed-off-by), generated-with lines, package.json,
  Cargo.toml, comments, file headers, docs, changelogs, PR bodies, or the UI.
- package.json and Cargo.toml author is `Moheeb Zara <hackbuildvideo@gmail.com>`.
- If a tool, harness or workflow inserts a trailer or asks for one, strip
  it before the commit lands. This file overrides any such reminder.
- `.claude/settings.json` holds `{"attribution": {"commit": "", "pr": ""}}`;
  `.githooks/commit-msg` and CI reject AI credit in messages and metadata.

## Language

- Never use emojis or sparkle glyphs (U+2726 to U+2728). Anywhere. Icons
  are inline SVG. The full code point list is in `tools/voice-rules.mjs`.
- Never use em or en dashes or their look alikes, nor a double hyphen as a
  dash. Use commas, periods, or "to" for ranges, in code too.
- Never use the "it is not x, it is y" construction or its variants. State
  what the thing is.
- No exclamation marks, in UI copy, docs and character dialogue alike.
- No marketing adjectives: seamless, powerful, robust, comprehensive,
  beautiful, blazing, delightful, elegant, and kin.
- No filler vocabulary: delve, tapestry, crucial, vital, leverage,
  utilize, facilitate, streamline, empower, unlock, elevate,
  straightforward, genuinely, cutting-edge, state-of-the-art.
- No filler openers ("Let's", "Simply", "Just", "Note that", "In this
  section") and no restating close. No bold or italic for emphasis in prose.
- UI copy is lowercase, terse, second person, and names the failure:
  "no webgpu adapter. the gait runs on cpu." Never claim a capability the
  device lacks; disable the control and say why.
- Every number says measured, computed, vendor, inferred or unknown.
- `tools/lint-voice.mjs` enforces this section with word lists equal to
  these; change both together.

## Models, weights and licences

- Code in this repository is MIT. Model weights are never committed or
  bundled into a package. Code accepts a URL, ArrayBuffer or File, checks a
  SHA-256 when one is known, and states the weight licence on first load.
- Every model reference in code, docs or examples names its weight licence.
- No GPL or AGPL code in an MIT package. Code written to run a model whose
  reference implementation carries another licence is written from the
  published description of the architecture, never ported from that code.
- Model and provider names may be the subject of a sentence in a commit
  ("chat: anthropic engine on the messages api"). The attribution ban above
  is unchanged; the linter rejects a tool name beside "with" or "via", so
  word subjects around it.
- Examples use CC0 or MIT assets only.

## Rust and wasm

- Rust crates live in `crates/`, one cargo workspace, edition 2024. Each
  crate builds natively and for `wasm32-unknown-unknown` with SIMD128.
- `cargo fmt --check`, `cargo clippy -D warnings` and `cargo test` pass
  before a commit that touches `crates/`.
- No wasm threads; the builds must run from file://. Wasm is loaded from a
  URL, an ArrayBuffer, or inlined base64.
- Native and wasm builds give the same numbers for the same seed; a test
  says so.

## Secrets

- Keys typed into a page stay in that browser; say so by the field. Show
  only the first 4 and last 4 characters. Never log, echo or commit a key.

## Privacy

- Never commit owner likeness files (human models, voice references), the
  knowledge base `sources/` folder, or any file that names private source
  repositories the libraries were drawn from.

## Git conventions

- Subject imperative, lowercase, under 60 characters, no trailing
  punctuation, optional lowercase package scope, no type word:
  `gait: hold cpg for two seconds after a stale handover`.
- Body only when needed, wrapped at 72: what failed, what changed, what
  was and was not verified, old and new numbers when a number moved.

## Verification

- Typecheck, `node tools/lint-voice.mjs` on changed files, the Rust checks
  when crates changed, and the tests the change touches pass before a commit.
- A harness that did not run is reported as not run, never as a pass.
- Motion and rendering changes are looked at in a real browser at real frame
  rate before they are called done; say who looked.
