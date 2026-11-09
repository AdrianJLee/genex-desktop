# Genex server-authoritative multiplayer in AI Game Studio

You are building inside AI Game Studio. Below the upstream marker is Genex's server-authoritative
multiplayer card, with its CLI-only testing section taken out. Where it disagrees with this
preface, this preface wins.

## What Studio runs of it today

- Writing works: the room module, its `authority` block and the client, in any web game made here.
- Shipping works. `genex__publish` (draft or gallery) sends the room module with the build: Studio
  ships `@genex-ai/authority-dev` itself, stages `server/` and every file the module imports beside
  the public copy (never in it), and the publish bundles and validates the module before any game
  file moves. A module that fails stops the publish with each typed reason in the job's error; fix
  the module and publish again. On Genex's servers the owner needs Genex Pro: a free account is
  refused with `authority_requires_pro` after validation, and nothing is uploaded.
- Running it on this machine does not yet. Studio has no tool that starts a local room, and Studio's
  preview cannot join one, so the card's `npx genex-authority-dev` commands are not available (a
  game's commands cannot download it). A draft publish is the check: its validation is the same
  gate `validate` runs.
- Say this to the person before building one, and let them choose: the game written now, checked
  and shipped by a draft, or a casual game (`$genex-threejs-multiplayer`) that also plays in the
  preview. Never report a server-authoritative game as tested locally or online before a draft passed.

## Packages

- `genex__package {"package":"@genex-ai/multiplayer"}` adds both SDKs at Studio's pins (nobody is
  asked): `@genex-ai/multiplayer` with `@genex-ai/multiplayer/authority`, and `@genex-ai/embed-sdk`
  with `getAuthorityUrls`. Never run `npm i` for them yourself; the card's step 4 does not apply.
- `@genex-ai/authority-dev` ships with Studio: never install it in the game.
- A room module imports nothing at runtime from a package, and imports the game's own files only
  from folders inside the game (`src/`, `shared/`), never a file at the game's top level or in a
  hidden folder: the publish refuses those, and a link anywhere on the way.

## A game made from Studio's template

- It has no `package.json`: the `authority` block goes in `genex.json` at the game's root, beside
  any other setting: `{"authority": {"module": "server/room.js", "tickHz": 30, "maxPlayers": 8}}`.
- The same `genex__package` call maps `@genex-ai/multiplayer/authority` in its import map; a game
  that mapped multiplayer earlier gets it by making the call again. Never copy the SDK by hand.
- It has no TypeScript build: write the room module and every file it shares with the client in
  plain JavaScript (`server/room.js`, `src/world.js`), without the card's type annotations and
  `import type` lines, importing shared files by their `.js` path.
- Its public copy holds `index.html`, `src/` and `assets/`: keep server-only code in `server/`
  and shared code in `src/`.
- Studio connects the game: never call `initEmbed()`. The `room` for `connectAuthority` is the
  game's slug, from `src/genex.config.js` as the multiplayer card's preface describes
  (`genex__skill {"name":"genex-threejs-multiplayer"}`).

## Reading the references

The card links its references by relative path. Read one with `genex__skill` and the file exactly
as listed, for example
`genex__skill {"name":"genex-authoritative-multiplayer","file":"skills/genex-authoritative-multiplayer/references/module-api.md"}`.

## Commands

`npx genex preview` is `genex__publish {"operation":"draft"}` and `npx genex publish` is
`genex__publish {"operation":"gallery"}`; both carry the room module (above). Other commands map
onto Studio tools as the `genex` skill describes (`genex__skill {"name":"genex"}`).
