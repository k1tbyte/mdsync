---
name: new-feature
description: Place and scaffold a new feature slice in packages/plugin (a domain area or Obsidian surface no existing slice owns). Use before creating a slice under packages/plugin/src/features/. Not for changes inside an existing slice.
---

# New feature

The rules in `.claude/rules/` (structure, ui, testing) load as you touch files; this skill is the order of work. Paths are relative to `packages/plugin/src/`.

## 1. Find an owner

- List `features/*/index.ts` and read the README of the closest slice. Extending an existing slice beats a new one: a new slice needs a domain or a surface nobody owns.
- Name it after the domain term the code uses (`spaces`, not "shared folders"), not after the screen.

## 2. Pick the tier and its place

- **Domain** (owns state, logic, its own flows and modals) or **surface** (a place in Obsidian where domains meet: a view, the gutter, the file tree, a header, the status bar, the wizard, the settings tab).
- Domain order, lowest first: `storage < sync < live < presence < spaces < links < relay < transfer`. A slice imports only downward, types included (`pnpm arch` checks it; a new domain also joins `DOMAINS` in `packages/plugin/.dependency-cruiser.cjs`); a domain never imports a surface. Surface -> surface only along the allow list in the structure rule and `packages/plugin/.dependency-cruiser.cjs`; extending that list is a design decision, not part of this task.
- Anything the slice needs from another slice comes through that slice's facade (`@/features/<name>`) or `@/core/<area>`. If two slices need code and it knows no feature, it belongs in `core/`.
- Do not take `PluginHost` (`app/host.ts`): declare what the slice reads from the plugin in `host.ts` as `<Name>Host`, export it from the facade; `MdsyncPlugin` satisfies it structurally. A way into another surface is a callback in it.

## 3. Create only the files it needs

1. Logic `*.ts` at the slice root, `obsidian` as `import type` where possible so it tests without a DOM. Group by sub-area past 12 modules, never by kind.
2. `features/<name>/register.ts` - Obsidian wiring for the plugin lifetime (commands with stable ids, events, menus, views), called from `app/` (`app/commands.ts`, `app/views.ts`, `app/events.ts`, or `main.ts` for services). Only `app/` and `main.ts` call it.
3. `ui/` - DOM, modals, menus, settings sections, built from `core/ui` primitives (the ui rule). A settings section is exported through the facade and ordered by `features/settings/tab.ts`.
4. `*.css` next to what it styles, imported from `styles.css` at its place in the cascade (lowest feature first, `core/ui/styles/mobile.css` stays last).
5. `features/<name>/index.ts` - the facade: export only what other slices or `app/` import; never import it from inside the slice.
6. `README.md` - what it does, flows, rationale, accepted limits. Constraints that must hold go to a rule in `.claude/rules/` with `paths:` for the slice.

## 4. Tests

Mirror the tree under `packages/plugin/tests/features/<name>/` (the testing rule): never colocated. All domain logic gets unit tests; reuse `tests/helpers/` before adding a helper.

## 5. Finish

- `pnpm lint && pnpm typecheck && pnpm test && pnpm arch`, all green, and no folder over 12 modules.
- Grep `.claude/` and `features/*/README.md` for what the change renames or retires and update every mention in the same commit (`CLAUDE.md` rules table when a rule is added).
- Report the files created and anything left out on purpose.
