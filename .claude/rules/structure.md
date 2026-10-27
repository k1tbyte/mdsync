---
paths:
  - 'packages/plugin/src/**'
  - 'packages/plugin/tests/**'
---

# Plugin structure

Paths in this file are relative to `packages/plugin/src/`.

## Layout

- `main.ts` - lifecycle only (onload, onunload, `saveSettings`, `scheduleScopeRefresh`). `styles.css` - the cascade order of every stylesheet.
- `app/` - composition root: the host container (`app/host.ts`), bootstrap, commands, events, protocol handlers, realtime coordinator, session factory, settings envelope, views. Only `app/` and `main.ts` call a feature's `register*()`.
- `core/` - infra that knows no feature: `cloudflare crypto drawing hub logs settings shared ui utils vault`, plus `core/constants.ts`. Code moves here when a second feature needs it and it knows no feature.
- `features/` - one slice per feature. **Domain** (state, logic, own flows and modals), lowest first: `storage < sync < live < presence < spaces < links < relay < transfer`. **Surface** (where domains meet in Obsidian): `diff editor-signs explorer note-header settings setup source-control status`.
- Domain order is not enforced by `pnpm arch` (`no-circular` is): import downward. Upward edges that exist are debt, never add one: `live` and `presence` -> `relay` types, `live` -> `spaces` type.

## Slice shape (`features/<name>/`)

- `features/<name>/index.ts` - facade, exports only what other slices import. A slice never imports its own facade.
- `features/<name>/register.ts` - Obsidian wiring for the plugin lifetime (commands, events, menus, views), called from `app/`. Teardown goes through `register*` helpers.
- `*.ts` logic: `obsidian` as `import type` where possible, testable without DOM. Obsidian adapters sit in a named sub-area (`links/snapshot/`, `live/text/`).
- `ui/` DOM, modals, menus, settings sections. `*.css` next to what it styles. `README.md` flows, rationale, accepted limits.
- Create a file only when the slice needs it. Past 12 modules in a folder, group by sub-area, never by kind.

## Imports

- Another slice only through its facade `@/features/<name>`, another core area through `@/core/<area>`; `@/core/constants` directly. Inside a slice and inside a core area, relative paths.
- Deep imports into another slice (mostly `features/sync/**`) are baselined debt. New code adds none: export what is needed from the facade.
- esbuild emits CJS: a facade must not create a runtime cycle. `import type` edges are ignored by the cycle rule.
- Modules still take `PluginHost` (`app/host.ts`) and `core/settings/model.ts` still imports features. These are baselined, being removed. New code declares the narrow members it needs as its own interface (`SpaceAccessHost` in `features/spaces/space-access.ts`, `SettingsTransferDeps` in `features/transfer/transfer-controller.ts`); `MdsyncPlugin` satisfies it structurally. Navigation into another surface is a callback in those deps, not an import.
- A per-slice deps file and a per-slice settings module do not exist yet: do not cite or create them as if they did.

## `pnpm arch` (`packages/plugin/.dependency-cruiser.cjs`)

- Rules: `no-circular` (runtime), `slice-via-facade`, `root-via-facade` (`app/`, `main.ts`), `core-independent` (core imports no feature or app), `features-not-app`, `domain-not-surface`, `surface-<name>`.
- Surface -> surface only: `setup` -> `settings`; `source-control` -> `diff`, `setup`; `status` -> `diff`, `note-header`, `source-control`. `diff`, `editor-signs`, `explorer`, `note-header`, `settings` reach no other surface.
- `packages/plugin/.dependency-cruiser-known-violations.json` is a baseline that only shrinks. Remove a violation, then regenerate: `npx depcruise src --config .dependency-cruiser.cjs --output-type baseline > .dependency-cruiser-known-violations.json` (in `packages/plugin`, file `packages/plugin/.dependency-cruiser-known-violations.json`). A change that adds an entry is wrong; fix the import.
- Remaining baselined groups: `slice-via-facade` (deep imports, mostly into `sync`), `features-not-app` (`PluginHost`), `core-independent` (`core/settings/{model,fields}.ts`), `domain-not-surface` (`features/sync/ui` -> `features/source-control/view.ts`, `features/links/ui` and `features/relay/ui` -> `features/setup/step-state.ts`), one each in `surface-diff`, `surface-setup`.
- Folder cap: at most 12 `.ts` modules per source folder, css excluded (`packages/plugin/tests/arch/folders.test.ts`, runs in `pnpm test`).

## Styles

`styles.css` is bundled to `packages/plugin/styles.css` by `packages/plugin/esbuild.config.mjs`; the output is gitignored, edit the slices.

- A stylesheet sits in its feature (`features/<name>/styles/` or `ui/`), shared ones in `core/ui/styles/`. Each is imported from `styles.css`: core first, features lowest first, `core/ui/styles/mobile.css` last. Import order is the cascade: append within a slice, never reorder.
- Phone overrides live next to the component they override; `core/ui/styles/mobile.css` is only the cross-cutting touch-target pass.
- Spacing is Obsidian's 4px grid (`--size-4-*`, `--size-2-*`), never a parallel scale. `core/ui/styles/tokens.css` holds only what Obsidian lacks (`--mdsync-icon`, `--mdsync-touch`, `--mdsync-bar`, `--mdsync-bar-strong`, `--mdsync-radius-pill`). The bar is the tone change bar, the strong one the accent bar of a chosen side.
- Raw px only for hairlines and off-grid values with no token. Row `min-height` is a contract with `features/source-control/virtual-list.ts`, which measures it and sets `--mdsync-row-height`: do not round it.

## Conventions

- TypeScript strict. esbuild bundles everything into `main.js`: no unbundled runtime deps, no Node or Electron APIs (mobile, `isDesktopOnly` is false). The one exception is the symlink detector `core/vault/symlinks.ts`: lazy `import("node:fs")` in `loadNodeFs`, desktop only, a no-op detector on mobile.
- Keep the bundle small, prefer browser-compatible packages, mind mobile memory. Never commit `node_modules/`, `main.js`, `styles.css`.
- One responsibility per module, split past ~200-300 lines, `async/await` over chains, handle errors gracefully.
- A constant lives with its one consumer; only cross-area values go in `core/constants.ts`.
- Scope: the scanner prunes denied, ignored and disabled config directories through `ScopePolicy.canDescend()` before listing. Keep it in step with `includes()` (`features/sync/scope/scope.ts`). Symlinks plug in through the `symlinks` option of `ScopePolicy`, so scanner and diff filter share one place.
- Startup stays light: nothing long-running in `onload`, lazy-initialise heavy work. Batch disk access, avoid vault scans, debounce reactions to file events.
