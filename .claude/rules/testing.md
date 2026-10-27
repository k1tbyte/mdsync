---
paths:
  - 'packages/plugin/tests/**'
  - 'packages/*/tests/**'
  - 'tests/**'
  - 'packages/*/vitest.config.ts'
---

# Testing

Plugin source paths are relative to `packages/plugin/src/`. Run `pnpm test` (all packages) or `pnpm --filter mdsync test:watch`. Scenarios against real processes: `tests/e2e/README.md`.

## Placement

- Tests mirror the source tree under `packages/plugin/tests/` and are never colocated: `features/sync/remote/baseline.ts` is tested by `packages/plugin/tests/features/sync/remote/baseline.test.ts`, `core/crypto/seal.ts` by `packages/plugin/tests/core/crypto/seal.test.ts`, `app/` by `packages/plugin/tests/app/`. The Obsidian linter skips `tests/`, not `src/`.
- Other packages keep their tests in their own `tests/` (`packages/{relay,viewer,protocol}/tests`); relay and viewer have their own `packages/relay/vitest.config.ts` and `packages/viewer/vitest.config.ts` (the viewer runs in jsdom). e2e code is `tests/e2e/`, typechecked by `tests/tsconfig.json`.
- Shared helpers in `packages/plugin/tests/helpers/`, the Obsidian runtime stub in `packages/plugin/tests/stubs/obsidian.ts` (`obsidian` resolves to it), the relay bundle stub in `packages/plugin/tests/stubs/relay-bundle.ts`, global setup in `packages/plugin/tests/setup.ts` (window, crypto, localStorage, `navigator.onLine`). A needed Obsidian API is added to the stub, not mocked per test file.
- A file that needs a DOM starts with `// @vitest-environment jsdom` and installs Obsidian's element helpers (`packages/plugin/tests/helpers/obsidian-dom.ts`, `packages/plugin/tests/helpers/element-methods.ts`); the default environment is node.
- Imports: the code under test through `@/`, helpers through `@tests/`, a test imports the module it tests directly (a test may reach slice internals, `pnpm arch` covers `src/` only).

## What must be covered

- All domain logic needs unit tests: diffs, merging, concurrency, hunk matching, baseline cache, history, scope, crypto and wire formats. A bug fix lands with the test that fails without it.
- Test behavior through the module's public function, not private helpers. Randomized tests are seeded (`seeded` in `packages/plugin/tests/helpers/seeded.ts`) so a failure replays.
- Data-safety paths are tested by killing them part way: `packages/plugin/tests/helpers/faults.ts` (`killNextWrite`) and `packages/plugin/tests/helpers/cut-short.ts` cut a write at a prefix or at nothing, `packages/plugin/tests/features/sync/recovery/cut-short.test.ts` shows the shape.

## Harnesses

- Two devices: `pairedSessions()` and `TestSession` (`packages/plugin/tests/helpers/session.ts`) over `InMemoryAdapter` and `FakeStorage`; `createTestControllerHost` (`packages/plugin/tests/helpers/controller.ts`) for a controller. `useEncryptionKey()` derives the key once.
- Live sessions run against the relay's own hub logic and SQLite store in-process: `LiveHub` (`packages/plugin/tests/helpers/live-hub.ts`, via the `mdsync-relay` devDependency, `memorySql` from the relay's test helpers) with switches for lost frames (`dropIncoming`, `dropUpdates`, `dropOutgoing` on a `connection()`), a stranded socket (`strand`) and wiped logs (`LiveHub.wipe`). `packages/plugin/tests/core/crypto/chaos.test.ts` runs three devices through seeded edits, drops and half-open sockets and demands one text with every edit. A new live behavior gets a case here, not a mock of the hub.
- Cloudflare: `packages/plugin/tests/helpers/fake-cloudflare.ts` routes. Relay and link tests in `packages/relay/tests` use `tests/helpers/` there (`cloudflare:workers` is aliased to a stub).

## Mocking

- Mock the module that defines the thing, by its file path: `vi.mock("@/core/ui/notices")`. A mock of a facade (`@/features/spaces`) misses same-slice leaf imports that bypass it; a mock of the leaf also covers every facade that re-exports it.
- Keep what the test does not replace: `vi.mock("obsidian", async (importOriginal) => ({ ...(await importOriginal()), ... }))`.
- Prefer a fake that implements the real interface (`FakeStorage`, `InMemoryAdapter`, `LiveHub`) over `vi.fn` returning canned data.

## Real Obsidian

- `tools/obsidian.mjs` (`pnpm obsidian <action>`) drives a running instance over CDP: `launch`, `shot`, `click`, `fill`, `text`, `cmd <command-id>`, `commands`, `eval` (runs in the renderer, where `app.plugins.plugins.mdsync` is reachable). Obsidian must be started with the port open (`launch`); a normally launched instance exposes nothing.
- After copying a new build in, reload with `app.plugins.disablePlugin('mdsync')` then `enablePlugin`: `styles.css` is re-injected only on reload. Both `main.js` and `styles.css` are build outputs; run `pnpm build` first.
- Test on iOS and Android where feasible; do not assume desktop-only behavior.
