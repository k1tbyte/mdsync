# Architecture

## Layout (`packages/plugin/src/`)

- `main.ts` - lifecycle only: onload/onunload, saveSettings, scheduleScopeRefresh
- `plugin/` - composition root: host.ts, bootstrap, one register*() per concern
- `core/` - long-lived services: LogService, PassphraseManager, StatePersister, DeviceName
- `sync/` - the engine: manifest, diff, operations, history, projection. No UI.
- `crypto/` - the vault key and blobs (`index.ts`), live keys, and `seal.ts`: everything the relay carries (live frames, cursors, presence), sealed with its space's key
- `hub/` - the relay hub: socket link, one socket per relay (`channels.ts`: the vault and owned shares on the own relay, joined shares on their owner's), a per-space facade (`space(id)`) routing frames by slot; `HubConnection.statusOf` is the relay status every display reads (`status.ts`)
- `presence/` - who is where: each device announces its open file on every space channel it holds, sealed with that space's key (`people.ts`, `channel.ts`, `announcement.ts`); `here.ts` tracks the active file and idleness; `unseen.ts` the files others changed that this device has not opened. Keys and identity per space come from `plugin/space-access.ts`, shared with live editing
- `spaces/` - space records (`settings.spaces`, one object each under `spaces/` in the vault storage), the partition (`spacesOf`, `mountError`), the owner's share (`owner.ts`), invites (`invite.ts`), how a device reaches a share (`access.ts`). No network and no settings: the relay broker client is `storage/adapters/share-broker.ts`, the flows are `ui/shares/share-action.ts` and `ui/shares/invite-action.ts`. `sync/` never imports it; `core/session-factory.ts` opens a share's session from its record
- `live/` - live documents: `session/` (one file's Y.Doc in its space's room: the outbox, the room log, who else is in it, the rotation it asked for), `workspace/` (which open notes are live: `sessions.ts` and each note's `noteState`, `room.ts`, `space.ts`, the join patience, renames, and `editors.ts` pairing each model with the view that edits it), `cold/` (the file sync's `LiveNotes` port, declared in `sync/live-notes.ts` so `sync/` never imports `live/`, and the agreed texts), `doc-id.ts` (a room's id), `doc-types.ts` (what goes live, in which view), and a model per kind (`text/`, `drawing/`, each with the binding that attaches its view)
- `drawing/` - Excalidraw files without Obsidian: reading the scene, its fingerprint, the merge by element. Pure; used by `sync/`, `vault/` and `live/`
- `storage/` - remote backends behind StorageAdapter, plus the registry
- `vault/` - Obsidian filesystem access, scanning, ignore rules
- `settings/` - settings model, transfer, and the settings tab sections
- `ui/` - views and modals at the top; `live/` (note header in `header/`, relay and live status in `status/`, the states both show in `live-state.ts`), `shares/` (share window, share and invite flows), `explorer/` (file tree indicators and presence), `actions/` (menu actions), `common/` (notices, icon buttons, avatars, relay text and fixes, menus, helpers: whatever two of these use)
- `editor/` - CodeMirror gutter signs, the read-only share lock
- `shared/`, `utils/` - app-aware helpers vs. generic algorithms
- `styles/` - the stylesheet, one slice per feature (see Styles)

## PluginHost over the plugin class

Feature modules take `PluginHost` (`plugin/host.ts`), never
`import MdsyncPlugin from "@/main"` - that import direction is what turned
`main.ts` into a proxy dump. A module that also registers something with
Obsidian takes `Plugin & PluginHost`; `MdsyncPlugin` satisfies both.

## Styles

`src/styles/` is bundled to `packages/plugin/styles.css` by the same esbuild
config that builds `main.js`. The generated file is gitignored; edit the slices.

- Slices mirror `ui/`: one file per feature, imported by `index.css`. Import
  order is the cascade, so append within a slice rather than reordering imports.
- Phone overrides live next to the component they override; only `mobile.css`
  (the cross-cutting touch-target pass) is loaded last.
- Spacing uses Obsidian's 4px grid (`--size-4-*`, `--size-2-*`) directly. Do not
  add a parallel scale. `tokens.css` holds only what Obsidian has no variable
  for: `--mdsync-icon`, `--mdsync-touch`, `--mdsync-bar`, the pill radius.
- `--mdsync-bar` is a tone-coloured change bar, `--mdsync-bar-strong` the
  heavier accent bar for a chosen side. Keep that distinction.
- Raw px is for hairlines (1px borders, outlines) and the few off-grid values
  with no token. Row metrics (`min-height` on rows) are a contract with
  `virtual-list.ts`, which measures them - don't round them casually.

## Layering

`sync/`, `storage/` and `vault/` must not import from `ui/`,
`settings/` (beyond `settings/model`) or `editor/`. An adapter that needs to
tell the user something returns a result for the caller to surface - see
`StorageAuthOutcome`.

## Imports

- `@/` for anything outside the file's own directory, relative `./` inside it.
- Tests reach source through `@/` and their own helpers through `@tests/`; a
  test imports the module it tests directly.
- Cross-area behaviour goes through the area barrel: `@/ui`, `@/ui/common`,
  `@/storage`, `@/live`, `@/hub`, `@/presence`, `@/spaces`, `@/shared`,
  `@/utils`; inside `live/`, `@/live/session`. A slice never imports its own
  barrel; `ui/index.ts` reaches its folders relatively. Leaf type modules
  (`@/storage/types`, `@/sync/types`, `@/hub/status`, `@/spaces/record`,
  `@/live/model`, `@/live/session/session-deps`) are imported directly so a
  type never drags in its slice. `@/spaces/access` (drags `@/storage`) stays out of its barrel.
- No barrel for `sync/`: `sync` and `vault` import each other, and a barrel
  would risk their init order.

## Conventions

- TypeScript strict; Node.js current LTS; obsidian type definitions.
- esbuild (`esbuild.config.mjs`) bundles everything into `main.js` - no
  unbundled runtime deps, no Node/Electron APIs (mobile compatibility;
  `isDesktopOnly` is set accordingly). Mind mobile memory limits.
- Keep the bundled plugin small; prefer browser-compatible packages.
- Split files that exceed ~200-300 lines; one well-defined responsibility per
  module; prefer `async/await` over promise chains; handle errors gracefully.
- Constants live with their consumer: a value used by one module is a
  module-level `const` there; only genuinely cross-area values belong in
  `src/constants.ts`.
- Never commit generated files (`node_modules/`, `main.js`, `styles.css`).

## Scope rules

- Vault scanning prunes denied, ignored and disabled config directories via
  `ScopePolicy.canDescend()` before listing descendants. Keep that pruning
  path in sync with `ScopePolicy.includes()` when changing sync scope rules.
- Symlink skipping lives in `vault/symlinks.ts` and plugs into `ScopePolicy`
  through the optional `symlinks` option, so the scanner and the diff filter
  both honour it from one place. It is the only part of the
  plugin that touches Node (`require("node:fs")`, lazily - mobile gets a
  no-op detector).

## Performance

- Keep startup light: defer heavy work, lazy-initialise, nothing long-running
  in `onload`.
- Batch disk access, avoid excessive vault scans, debounce/throttle expensive
  reactions to file system events.
