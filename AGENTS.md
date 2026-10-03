# MDSync

An Obsidian community plugin that syncs a vault between devices over
user-configured remote storage (S3-compatible, WebDAV, Google Drive).
TypeScript, bundled to `main.js` by esbuild.

pnpm workspace: `packages/plugin` (the plugin), `packages/relay` (one
Cloudflare worker: realtime relay over PartyServer Durable Objects, share
broker, Google OAuth proxy; deployed by the Deploy Relay workflow).

## Commands

- `pnpm install` - dependencies
- `pnpm dev` - esbuild watch
- `pnpm build` - production bundle
- `pnpm lint` / `pnpm lint:fix` - Biome over the whole repo
- `pnpm typecheck` - `tsc -noEmit` in every package
- `pnpm test` - all vitest suites (`pnpm --filter mdsync test:watch` while iterating)

## Read before touching sync code

Breaking an engine invariant silently corrupts user data or publishes remote
deletions. Read [sync invariants](.claude/sync-invariants.md) before changing
diff, hunk, baseline, history or GC code.

## Guidelines

- [Architecture](.claude/architecture.md) - layout, layering, imports, conventions
- [Sync invariants](.claude/sync-invariants.md) - data-integrity rules of the engine
- [Spaces, shares and live](.claude/shares.md) - the model, relay hub, protocol and live layer, and why
- [Commands & settings](.claude/commands-and-settings.md) - commands, settings, transfer, UI copy
- [Testing](.claude/testing.md) - vitest, CDP driver, manual install
- [Releasing](.claude/releasing.md) - manifest, versioning, release assets
- [Security](.claude/security.md) - privacy, compliance, listener cleanup
