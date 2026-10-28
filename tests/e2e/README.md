# End-to-end scenarios

Scenarios run real processes (Obsidian, `wrangler dev`, headless Chrome, in-memory S3 and WebDAV) and tear them down. Run from the repo root with `pnpm e2e:<name>`; the scripts that drive the plugin run `pnpm build` first (`tests/e2e/optimization-ui.ts` has no script: build by hand). Rules for writing tests: `.claude/rules/testing.md`.

## Prerequisites

- **Obsidian** at the default Windows path, or set `OBSIDIAN_EXE`. On macOS: `OBSIDIAN_EXE=/Applications/Obsidian.app/Contents/MacOS/Obsidian pnpm e2e:live`. Each scenario starts a throwaway Obsidian (own `--user-data-dir`, temp vault, the trust modal clicked) with the built `packages/plugin/main.js`, `packages/plugin/styles.css` and `manifest.json`.
- **Headless Chrome** for `links-obsidian` (`links` falls back to an installed Chrome): `pnpm exec playwright-core install chromium-headless-shell` once.
- Each Obsidian turns native menus off once the plugin loads: macOS defaults to them, and they never reach the DOM the scenarios read.
- **Ports** 8799 (relay), 8801 (WebDAV), 8802 (S3), 9223 and 9224 (CDP) must be free; a few scenarios use their own (listed below). A run killed midway can leave `wrangler dev` holding 8799 or an Obsidian holding its CDP port, and the next run attaches to the stale one: kill that tree.
- The relay keeps its storage in `packages/relay/.wrangler/e2e-state`, wiped when a run starts it first: tables an older build left would break the hub.
- Several Obsidians need distinct CDP ports. On Windows they run on a desktop of their own (`tests/e2e/hidden-desktop.ps1`) and never take focus; `E2E_VISIBLE=1` shows them. `E2E_SHOTS=1` saves screenshots under `artifacts/e2e-shots/`.

## Scenarios

| Command | Covers |
|---|---|
| `pnpm exec jiti tests/e2e/optimization-ui.ts` | a real Obsidian renders synthetic 20,000-file Timeline and Trash lists in 100-row pages; page navigation and full-list selection. Build first. Ports 8832, 9233 |
| `pnpm e2e:settings` | passphrase and toggle scroll retention, device-only ignore rules, phone layouts at 320, 390 and 600 px. Port 9235 |
| `pnpm e2e:setup` | fresh install opens the wizard; one device starts a vault (Other storage on in-memory S3, passphrase, relay skipped, Sync now), a second joins by its setup link. Ports 9241, 9242, 8841 |
| `pnpm e2e:links` | share links under `wrangler dev` and headless Chrome: the Link Durable Object (chunks, erase, expiry, a restart), the routes, the viewer page (passphrase, one view, reload costs none, a hostile note runs nothing, outline on desktop and phone, folds, anchors, wide text, code copy). Port 8799 |
| `pnpm e2e:links-obsidian` | shares a note from a real Obsidian through the file menu and opens the link in Chrome: properties, comments and embedded notes absent, math as MathML, callout, task and image kept, passphrase, view count, update, stop. Ports 8799, 9246; `E2E_SHOTS=1` saves `link-viewer.png` |
| `pnpm e2e:hub` | the relay hub under `wrangler dev` with scripted peers; ending a share cuts its channel for good, across a restart too; the last run sets `HUB_STALE_MS` low to watch the stale-socket sweep |
| `pnpm e2e:realtime` | the plugin in a throwaway Obsidian against the relay; a scripted peer reads and writes sealed presence under a handed-in key. `E2E_SOAK_MS=130000` adds an idle stretch past the link's silence timeout |
| `pnpm e2e:live` | two Obsidians type into one note through the relay; the shared key lives on an in-memory WebDAV. Undo (phone toolbar path and Edit menu) takes back only the device's own typing. A file written under the open note from outside joins the room; a rename of the open note is followed by the other device |
| `pnpm e2e:shares` | two Obsidians of one owner on an in-memory S3: one shares a folder through its menu, the other mounts, pauses and resumes it; a rename of the folder is followed |
| `pnpm e2e:invite` | an owner and a participant with separate vaults: invite through the broker, accept through the protocol handler; each edit reaches the other on the share channel's signal alone; a change or rename in the share pushes by itself |
| `pnpm e2e:guest` | a participant with no vault storage joins and syncs the share alone, then sets up a vault: the record goes there, the share's files do not |
| `pnpm e2e:people` | a read-only participant (editor locked, follows the owner live), a re-invite that kills the old link and takes over the folder in place, the owner's rotated S3 key (`s3.revoke`) reaching the broker, access and Revoke in the share's window |
| `pnpm e2e:live-share` | owner and participant type into one note of a share in its room; the cursor carries the invited name, authors tint the other's text, the sync after is clean; presence reaches a device with no note open, the tree and window show who is where, follow cursor jumps and scrolls until the owner's wheel ends it, a note the other changed shows as new until opened |
| `pnpm e2e:live-into-share` | two devices of one owner type into a live note while one shares its folder; both end in the share's room, every edit once |
| `pnpm e2e:live-drawing` | two Obsidians with the Excalidraw plugin (latest release, fetched once into `temp/e2e-plugins/`): shapes, concurrent edits and a deletion cross, the pointer shows, file sync of drawings with different zoom settles clean; with live off a saved drawing view takes what the sync writes under it |
| `pnpm e2e:history` | one Obsidian pushes six times to an in-memory S3 with History on and one version pinned, then opens Timeline in the right sidebar: activity calendar and its push count, Pinned and Last hour groups, a session card opened to its files and pushes, the path filter (keeps focus, empty state), a calendar day chip, and the Show activity in Timeline setting. Ports 8850, 9250; `E2E_SHOTS=1` saves PNGs under `E2E_SHOTS_DIR` (default `temp/e2e-shots`) |
| `pnpm e2e:note-switch` | one leaf switches between two live notes of a share with a slow disk read and a focus change mid-load: no change signs of one note on the other, the header's live mark never drops, each note keeps its text |

## Writing a scenario

- Reuse `launchObsidian` (`tests/e2e/obsidian.ts`), `startRelay` (`tests/e2e/relay.ts`), `startWebDav` (`tests/e2e/webdav.ts`), `startS3` (`tests/e2e/s3.ts`) and `connectPeer` (`tests/e2e/peer.ts`); `runScenario`, `check` and `poll` are in `tests/e2e/harness.ts`.
- `tests/e2e/device.ts` drives a device (sync, files, folder menus, modals), `tests/e2e/sharing.ts` holds the owner-and-participant setup and share steps, `tests/e2e/editor.ts` opens, types into and reads an editor.
- Obsidian 1.13 mounts modals in `activeDocument`, not `document`, and keeps protocol handlers in `app.workspace.protocolHandler.handlers`. Never open an `obsidian://` URL through the OS: it would reach the user's own Obsidian.
- Settings stay open under later modals, so helpers search the topmost first. Close buttons ignore synthetic clicks; `closeModals` sends Escape.
- Throw on the first broken expectation (`check`): later steps build on earlier ones.

## Manual install

Copy `main.js`, `styles.css` (both from `pnpm build` or `pnpm dev`, neither is in git) and `manifest.json` to `<Vault>/.obsidian/plugins/mdsync/`, reload Obsidian and enable the plugin in **Settings → Community plugins**. To drive that instance by hand, see the Real Obsidian section of `.claude/rules/testing.md`.

## Mobile

Test on iOS and Android where feasible; the plugin is not desktop-only. The e2e phone layouts (`pnpm e2e:settings`) emulate widths, not a device.
