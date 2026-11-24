# hackbuild-suite

Browser AI and 3D character tools in one tab: chat, voice, image, character, rooms, motion and agents, built on the hackbuild libraries.

Status: skeleton, 2026-11-24. The shell, hash routes and the tool registry
are in place; each tool lands in its build phase and shows what it will use
until then. The tools consume the hackbuild libraries and hackbuild-ui,
vendored as tarballs pinned by commit under `tools/vendor/`.

Two builds: `npm run build` for any http host (lazy chunks per tool), and
`npm run build:single` for one HTML file that also opens from `file://`.
`npm run smoke:file` opens that file in headless Chrome and checks the
routes and the IndexedDB workspace.

## Develop

    source ~/.nvm/nvm.sh && nvm use
    npm ci
    npm test

`npm ci` sets `core.hooksPath` to `.githooks`. Rules for every change are
in RULES.md and CONTRIBUTING.md.

## What is verified, and what is not

### Not verified by anything

- every tool; none is built yet.

### Verified

- the single file build opens from file:// in headless system Chrome (puppeteer-core 25.18.1), changes route and writes and reads IndexedDB (`tools/smoke-file.mjs`).

## Licence

| path | licence |
|---|---|
| code | MIT (LICENSE) |
| README, CHANGELOG, docs | CC-BY-4.0 (LICENSES/CC-BY-4.0.txt), code samples also MIT |
