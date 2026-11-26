# Building on the suite

This page is for developers: how the suite is put together, how to add an explorer or an example, and the gates a change passes.

## The layers

The suite only consumes; it owns no shared code of its own beyond the shell.

| layer | where | what it holds |
|---|---|---|
| libraries | hackbuild-browser-ai, hackbuild-motion, hackbuild-agents | the work: models, runtimes, meshes, rigs, agents. No UI. |
| view packages | @hackbuild/ai-views, @hackbuild/motion-views, @hackbuild/agents-views | parts that bind a library to the screen, vanilla with a Vue wrapper |
| design system | @virgilvox/hackbuild-ui | tokens, classes, the six layouts, every reusable part |
| suite | this repository | the shell (bar, switcher, model chip), the explorers, the examples |

A page imports layouts, views and libraries by their published names, plus a short stylesheet of its own. A part two pages could share goes into a view package or hackbuild-ui, never into the suite. The libraries and hackbuild-ui are vendored as tarballs pinned by commit under `tools/vendor/` (SHA256SUMS lists each one).

## The six layouts

Every screen uses one of the six hackbuild-ui layouts: conversation, stage and rack, canvas and rail, drop first, gate, and form in a frame; the home page has its own shape. Each marks its parts with `data-ux` (bar, subject, rack, verbs, inset, detail), and the screen gate reads those markers. The subject fills the screen; the rack is one column of three to five tabs; there is one pink action in view.

## Add an explorer

1. Make `src/explorers/<name>/` with one Vue file for the screen. Use a layout from hackbuild-ui and parts from the view packages.
2. Load real models through a model pick (`useModelPick(job, { loader: jobLoader(job) })` from @hackbuild/ai-views). Set `chipPick` from `src/shell/chip` on mount and clear it on unmount, so the bar's model chip drives it.
3. Put stand ins in `src/explorers/<name>/stubs.ts`, imported only when the page has `?stub`. A visitor's page never loads them.
4. Add the route `/x/<name>` to `src/router.ts` and set `route` on its tile in `src/shell/explorers.ts`.
5. Write `tools/smoke-x-<name>.mjs` on `?stub` with model hosts blocked, add `smoke:x-<name>` to package.json, and add `?stub#/x/<name>` to `tools/ux-routes.json` (with a `setup` that loads the sample, and `loadedLayout` if the loaded screen uses another layout) and its original's shots to `tools/ux-originals.json`.
6. Run `node tools/llms.mjs`: it rewrites `public/llms.txt` and the explorers table in README.md.

Page keys listen on `document` and call `preventDefault`; the shell owns m, ctrl+s and ctrl+o. Wrap every `localStorage` call in try and catch.

## Add an example

1. Write `examples/<job>/<id>/example.ts`. It exports `mount(host, hooks?)` and returns its model pick, a `sample` and `dispose`.
2. Add its row to `examples/index.json` and its `?stub` route to `tools/ux-routes.json`.
3. Run `node tools/example-packages.mjs` (the install line comes from the file's imports) and `node tools/llms.mjs`.
4. Run `npm run smoke:examples <job>` and the screen gate.

The library repositories copy the same example files into their own examples folders.

## The gates

| gate | command | what it checks |
|---|---|---|
| types | `npm run typecheck` | the whole suite under vue-tsc |
| tests | `npm test` | likeness, llms.txt and the README are current, unit tests |
| size | `npm run build:all && npm run size` | first load, every lazy chunk and the single files against `tools/size-budget.json` |
| smokes | `npm run smoke:<name>` | each tool, example job and explorer on `?stub`, in headless Chrome |
| screens | `node tools/ux-gate.mjs --dir dist/hosted --routes "<routes>" --out <dir>` | each screen at desktop and phone widths: one bar, one pink action, the subject's share, the rack, no sideways scroll, no internal words |
| beside the original | `node tools/contact-sheet.mjs --gate <dir> --out <dir> [--loaded]` | the screen next to the original it ports |
| voice | `npm run lint:voice` | lowercase terse copy, no emoji, no dashes |

Gates never download weights: smokes and screens run on stand ins behind `?stub`. Rules for every change are in [RULES.md](../RULES.md) and [CONTRIBUTING.md](../CONTRIBUTING.md).

## Builds

`npm run build` makes `dist/hosted` for any http host, with lazy chunks per tool. `npm run build:single` makes one HTML file that opens from `file://`; `npm run build:groups` makes one file per group. `npm run smoke:file` opens the single file in headless Chrome and checks the routes and the IndexedDB workspace.
