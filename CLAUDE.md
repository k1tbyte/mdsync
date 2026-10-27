# MDSync

An Obsidian community plugin that syncs a vault between devices, end-to-end encrypted, over storage the user owns (S3-compatible, WebDAV, Google Drive), with an optional self-deployed Cloudflare relay for live editing, shared folders and share links. pnpm 10 workspace, Node 24, TypeScript strict, Biome.

| Package | Holds |
|---|---|
| `packages/plugin` | `mdsync`: the plugin, bundled to `main.js` and `styles.css` by esbuild. Feature slices under `src/features/`, shared infra in `src/core/`, composition root in `src/app/` |
| `packages/relay` | `mdsync-relay`: one Cloudflare worker (Durable Objects, no PartyServer): relay hub, share broker, link storage, Google OAuth proxy. The plugin deploys it from its own bundle |
| `packages/protocol` | `@mdsync/protocol`: wire formats shared by plugin, relay and viewer (hub frames, sealed link format) |
| `packages/viewer` | `mdsync-viewer`: the page a share link opens, built and served by the relay |
| `tests/e2e/` | end-to-end scenarios against real Obsidian, `wrangler dev` and in-memory S3/WebDAV: `tests/e2e/README.md` |

## Commands

- `pnpm install` - dependencies
- `pnpm dev` - esbuild watch of the plugin
- `pnpm build` - typecheck, then the production bundle (`main.js`, `styles.css`; the relay is bundled into it)
- `pnpm lint` / `pnpm lint:fix` - Biome over the repo
- `pnpm typecheck` - `tsc` in every package and in `tests/`
- `pnpm test` - every vitest suite (`pnpm --filter mdsync test:watch` while iterating)
- `pnpm arch` - plugin dependency boundaries (`packages/plugin/.dependency-cruiser.cjs`); the folder cap runs in `pnpm test`
- `pnpm e2e:<name>` - real-process scenarios (list and prerequisites in `tests/e2e/README.md`); on macOS set `OBSIDIAN_EXE=/Applications/Obsidian.app/Contents/MacOS/Obsidian`

## Rules

`.claude/rules/` holds the working rules; Claude Code loads each when you touch a file matching its `paths`. Other agents read the ones that match the files in their task. A rule holds constraints and mechanisms; explanations, flows and accepted limits live in the README next to the code (`packages/plugin/src/features/*/README.md`, `packages/viewer/README.md`, `tests/e2e/README.md`).

| Rule (`.claude/rules/<name>.md`) | Covers |
|---|---|
| `structure` | plugin layout, feature slices, imports, `pnpm arch`, styles, bundle and mobile constraints (`packages/plugin/src/**`, `tests/**`) |
| `sync-integrity` | engine invariants: baseline, manifest, push and pull, deletions, conflicts (`features/sync/**`) |
| `hunks` | hunk anchoring, diff, merge, change signs, partial operations |
| `history` | history log, pins, timeline, trash, restore, GC |
| `vault-io` | what Obsidian's adapter does on each platform: non-atomic writes, renames, case, symlinks |
| `spaces` | shared folders: records, owner and participant flows, broker, moves, pause |
| `realtime` | hub protocol, channels, grants, frames, relay worker |
| `live` | live documents: sessions, rooms, cold sync, drawings, authors |
| `presence` | who is where: announcements, header pill, follow, file tree marks |
| `links` | share links: snapshot, sealed format, broker, viewer |
| `security` | secrets, envelope, device key, privacy, listener cleanup |
| `settings-setup` | commands, settings and transfer, setup wizard, relay deploy and update |
| `ui` | `core/ui` primitives, copy, tooltips, tokens, phone behavior |
| `testing` | test placement, helpers, mocks, live hub harness, real-Obsidian driving |
| `releasing` | manifest, versioning, changelog, release workflow |

Rules describe the code as it is. A change that adds, renames or retires a mechanism, convention or path updates every rule, skill and README that names it, in the same commit: grep `.claude/` and `features/*/README.md` for the old name before finishing.

## Skills

- `new-feature` (`.claude/skills/new-feature/SKILL.md`) - before creating a slice under `packages/plugin/src/features/`
- `hunt-data-loss` - the brief for hunting silent data loss in the sync engine

## Comments

Explain only a non-obvious reason, invariant, compatibility constraint or platform quirk, in 1-2 lines. Never narrate names, types or the code below. Use `-`, not a long dash.
