# End-to-end scenarios

Scenarios start and tear down real Obsidian, `wrangler dev`, headless Chrome and in-memory S3/WebDAV. Run from the repo root; plugin scripts build first. Constraints: `.claude/rules/testing.md`.

## Prerequisites

- Obsidian at the default Windows path, or set `OBSIDIAN_EXE`. macOS: `OBSIDIAN_EXE=/Applications/Obsidian.app/Contents/MacOS/Obsidian pnpm e2e:live`.
- Chrome for links: `pnpm exec playwright-core install chromium-headless-shell` once (`links` can use installed Chrome).
- Free ports: 8799 relay, 8801 WebDAV, 8802 S3, 9223/9224 CDP; overrides below. Each Obsidian needs a distinct CDP port. If startup reports a taken port, kill the leftover process tree; helpers refuse to drive stale processes.
- Windows runs hidden via `hidden-desktop.ps1`; `E2E_VISIBLE=1` shows windows. `E2E_SHOTS=1` saves shots under artifacts/e2e-shots/ (history override below).

Each Obsidian gets its own user-data dir and temp vault, trusts it and loads the built plugin. Native menus are disabled because they never reach the DOM. Relay storage is fresh per run, survives restarts within it, then is removed. Failures print the error stack and last 50 output lines per `spawnLogged` child.

## Scenarios

| Command | Covers |
|---|---|
| `pnpm exec jiti tests/e2e/optimization-ui.ts` | Build manually first; 20,000-file Timeline/Trash pagination and full-list selection. Ports 8832, 9233 |
| `pnpm e2e:settings` | Scroll retention, device-only ignores, 320/390/600 px layouts. Port 9235 |
| `pnpm e2e:setup` | Fresh-install wizard, S3/passphrase/features, skipped relay, first sync/guide; second device joins by link. Ports 9241, 9242, 8841 |
| `pnpm e2e:links` | Link chunks/erase/expiry/restart, routes, passphrase/view counts, hostile note, desktop/phone outline and viewer interactions. Port 8799 |
| `pnpm e2e:links-obsidian` | File-menu share -> Chrome; sanitization, math/callout/task/image, passphrase, count, update/stop. Ports 8799, 9246; shots include link-viewer.png |
| `pnpm e2e:hub` | Share channel stays closed across restart; low `HUB_STALE_MS` exercises stale sockets |
| `pnpm e2e:realtime` | Plugin/scripted peer exchange sealed presence; `E2E_SOAK_MS=130000` crosses silence timeout |
| `pnpm e2e:live` | Two devices/WebDAV: typing, device-local undo via phone toolbar/Edit menu, external write, rename |
| `pnpm e2e:shares` | Same owner's devices/S3: mount, pause/resume, folder rename |
| `pnpm e2e:invite` | Broker invite/protocol acceptance; edits and renames propagate via share signal and auto-push |
| `pnpm e2e:guest` | Storage-less participant syncs share, then creates vault storage: record moves, share files do not |
| `pnpm e2e:people` | Read-only editor/follow, re-invite replaces old link in place, rotated S3 key, access/revoke |
| `pnpm e2e:live-share` | Shared-note typing, named cursors/authors, clean sync, presence without an open note, follow/scroll cancellation, unread marks |
| `pnpm e2e:live-into-share` | Sharing a live note's folder migrates both devices' rooms without duplicate edits |
| `pnpm e2e:live-drawing` | Excalidraw (latest release cached in temp/e2e-plugins): concurrent shapes/deletion, pointer, zoom differences, disk sync with live off |
| `pnpm e2e:history` | Six S3 pushes, pin, Timeline calendar/groups/session/filter, history settings and Activity card. Ports 8850, 9250; shots use `E2E_SHOTS_DIR` (default temp/e2e-shots) |
| `pnpm e2e:note-switch` | Slow read/focus change while switching shared live notes: text, change signs and live header stay with their note |

## Writing a scenario

- Reuse `launchObsidian` (`obsidian.ts`), `startRelay` (`relay.ts`), `startWebDav` (`webdav.ts`), `startS3` (`s3.ts`), `connectPeer` (`peer.ts`). Give S3 a clock for history's `LastModified` dates.
- Wrap in `runScenario`; use `check` (fail immediately), `poll`, `spawnLogged` from `harness.ts`. Drive sync/files/menus/modals via `device.ts`, owner/participant setup via `sharing.ts`, editors via `editor.ts`.
- Obsidian 1.13 uses `activeDocument` for modals and `app.workspace.protocolHandler.handlers` for protocol dispatch. Never send `obsidian://` through the OS: it reaches the user's instance.
- Search topmost modals before underlying settings. Use `closeModals` (Escape); close buttons ignore synthetic clicks.

## Manual install

Copy the plugin bundle (main.js, styles.css) and manifest.json into <Vault>/.obsidian/plugins/mdsync/, reload and enable it in **Settings → Community plugins**.

## Accepted limits

- Phone layouts emulate widths, not iOS/Android devices.
