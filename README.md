# hackbuild-suite

Browser AI and 3D character tools in one tab: chat, voice, image, character, rooms, motion and agents, built on the hackbuild libraries.

Use it: <https://hackbuild.github.io/hackbuild-suite/>. Single files to
download and open from disk: `files/hackbuild-suite.html` and one file per
group (`files/chat.html`, `files/voice.html`, `files/image.html`,
`files/character.html`, `files/rooms.html`, `files/motion.html`,
`files/agents.html`) on the same site.

Status, 2026-11-25: 22 tools in 7 groups, all running on stub
providers until you load a model. Nothing real has been downloaded or run in
the gates.

Built on:

- hackbuild-browser-ai, <https://github.com/hackbuild/hackbuild-browser-ai>, pages <https://hackbuild.github.io/hackbuild-browser-ai/>
- hackbuild-motion, <https://github.com/hackbuild/hackbuild-motion>, pages <https://hackbuild.github.io/hackbuild-motion/>
- hackbuild-agents, <https://github.com/hackbuild/hackbuild-agents>, pages <https://hackbuild.github.io/hackbuild-agents/>
- hackbuild-ui, <https://github.com/hackbuild/hackbuild-ui>, pages <https://hackbuild.github.io/hackbuild-ui/>
- dog-simulator, <https://hackbuild.github.io/dog-simulator/>

The libraries and hackbuild-ui are vendored as tarballs pinned by commit
under `tools/vendor/`.

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
