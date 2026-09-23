# Architecture

## Layout (`packages/plugin/src/`)

- `main.ts` - lifecycle only: onload/onunload, saveSettings, scheduleScopeRefresh
- `plugin/` - composition root: host.ts, bootstrap, one register*() per concern
- `core/` - long-lived services: LogService, PassphraseManager, StatePersister, DeviceName
- `sync/` - the engine: manifest, diff, operations, history, projection. No UI.
- `hub/` - the relay hub: socket link, the vault connection and its listeners, presence
- `storage/` - remote backends behind StorageAdapter, plus the registry
- `vault/` - Obsidian filesystem access, scanning, ignore rules
- `settings/` - settings model, transfer, and the settings tab sections
- `ui/` - views, modals, indicators, notices
- `editor/` - CodeMirror gutter signs
- `shared/`, `utils/` - app-aware helpers vs. generic algorithms
- `styles/` - the stylesheet, one slice per feature (see Styles)

## PluginHost over the plugin class

Feature modules take `PluginHost` (`plugin/host.ts`), never
`import ObsyncPlugin from "@/main"` - that import direction is what turned
`main.ts` into a proxy dump. A module that also registers something with
Obsidian takes `Plugin & PluginHost`; `ObsyncPlugin` satisfies both.

## Styles

`src/styles/` is bundled to `packages/plugin/styles.css` by the same esbuild
config that builds `main.js`. The generated file is gitignored; edit the slices.

- Slices mirror `ui/`: one file per feature, imported by `index.css`. Import
  order is the cascade, so append within a slice rather than reordering imports.
- Phone overrides live next to the component they override; only `mobile.css`
  (the cross-cutting touch-target pass) is loaded last.
- Spacing uses Obsidian's 4px grid (`--size-4-*`, `--size-2-*`) directly. Do not
  add a parallel scale. `tokens.css` holds only what Obsidian has no variable
  for: `--obsync-icon`, `--obsync-touch`, `--obsync-bar`, the pill radius.
- `--obsync-bar` is a tone-coloured change bar, `--obsync-bar-strong` the
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
- Tests reach source through `@/` and their own helpers through `@tests/`.
- Cross-area behaviour goes through the area barrel (`@/ui`, `@/storage`); leaf
  type modules (`@/storage/types`, `@/sync/types`) are imported directly so a
  type never drags in an adapter graph.

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
