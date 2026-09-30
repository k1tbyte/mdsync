# Testing

- vitest covers core logic (diff, hunks, concurrency, ignore, etc.). Run with `pnpm test`, or `pnpm --filter obsync test:watch` while iterating.
- ALL domain logic (diffs, merging, concurrency, hunks matching, baseline cache) must have complete unit-test coverage.
- Tests mirror `src/`: `tests/<area>/<module>.test.ts`, helpers in `tests/helpers/`.
- Live sessions run against the relay's own hub logic and SQLite store in-process (`tests/helpers/live-hub.ts`, via the `obsync-relay` devDependency), with switches for lost frames and reconnects. `packages/relay/tests/hub/worker.test.ts` runs the real worker and Hub Durable Object under miniflare (admission, presence, fan-out, read-only, signal, stale sweep). `tests/live/chaos.test.ts` runs three devices through seeded edits, drops and half-open sockets and demands one text with every edit in it.

## Driving a real Obsidian

`tools/obsidian.mjs` attaches to a running instance over CDP, so plugin UI can
be exercised without a human clicking. Obsidian must be started with the port
open (`node tools/obsidian.mjs launch`) - a normally launched instance exposes
nothing. Then `shot`, `click`, `text`, `cmd <command-id>` and `eval` drive it;
`eval` runs in the renderer, where `app` and `app.plugins.plugins.obsync` are
reachable. After copying a new build in, reload with
`app.plugins.disablePlugin('obsync')` then `enablePlugin` - `styles.css` is
re-injected only on reload.

## End to end

`tools/e2e/` runs scenarios against real processes and tears them down:

- `pnpm e2e:hub` - the relay hub under `wrangler dev`, driven by scripted peers;
  ending a share cuts its channel for good (across a restart too); its last run
  sets `HUB_STALE_MS` low to watch the stale-socket sweep.
- `pnpm e2e:realtime` - builds, then runs the plugin in a throwaway Obsidian
  (own `--user-data-dir` and temp vault, trust modal clicked) against the relay;
  a scripted peer reads and writes its sealed presence under a handed-in key.
  `E2E_SOAK_MS=130000` adds an idle stretch past the link's silence timeout.
- `pnpm e2e:live` - two Obsidians type into one note through the relay; the
  shared key lives on an in-memory WebDAV (`startWebDav`). Undo through the
  phone toolbar's path and the Edit menu's takes back only the device's own
  typing. A file written under the open note from outside Obsidian joins the
  room; ends with a rename of the open note that the other device follows.
- `pnpm e2e:shares` - two Obsidians of one owner on an in-memory S3
  (`startS3`): one shares a folder through its menu, the other mounts it,
  pauses and resumes it; the first renames the folder and the other follows.
- `pnpm e2e:invite` - an owner and a participant with separate vaults: invite
  through the relay's broker, accept through the protocol handler; each
  side's edit reaches the other on the share channel's signal alone.
- `pnpm e2e:people` - a read-only participant (its editor locked, following
  the owner's typing live), a re-invite
  that kills the old link and whose new one takes over the folder in place,
  the owner's rotated S3 key (`s3.revoke`) reaching the broker, who has
  access and Revoke in the share's window.
- `pnpm e2e:live-share` - an owner and a participant type into one note of a
  share, in the share's room on the owner's relay; the cursor carries the
  invited name, authors tint the other's text, and the sync after is clean;
  presence reaches a device with no note open, the tree and the share's window
  show who is where (a collapsed folder too), the header shows the other person
  live, its cursor marks the scrollbar, "follow cursor" jumps there and
  scrolls down a long insert until the owner's own wheel ends it, and
  closing the note leaves it; a note the other changed shows as new until
  opened.
- `pnpm e2e:live-into-share` - two devices of one owner type into a live note
  while one shares its folder; both end in the share's room, every edit once.
- `pnpm e2e:live-drawing` - two Obsidians with the Excalidraw plugin (latest
  release, fetched once into `temp/e2e-plugins/`) draw into one drawing: shapes,
  concurrent edits and a deletion reach the other, the pointer shows, and the
  file sync of drawings saved with different zoom settles clean; with live
  off, a drawing view that saved takes what the sync writes under it.
  `E2E_SHOTS=1` saves screenshots of these under `artifacts/e2e-shots/`.

`tools/e2e/device.ts` drives a device: sync, files, folder menus, modals.
`tools/e2e/sharing.ts` holds the owner-and-participant setup and share steps.
`tools/e2e/editor.ts` opens, types into and reads a device's editor.
Obsidian 1.13 mounts modals in `activeDocument`, not `document`, and keeps
protocol handlers in `app.workspace.protocolHandler.handlers`; never open an
`obsidian://` URL through the OS, it would reach the user's own Obsidian.
Settings stay open under later modals, so helpers search the topmost first;
close buttons ignore synthetic clicks, `closeModals` sends Escape.

Ports 8799 (relay), 8801 (WebDAV), 8802 (S3), 9223 and 9224 (CDP) must be free. A run
killed midway can leave `wrangler dev` holding 8799: kill that tree. The relay
keeps its storage in `packages/relay/.wrangler/e2e-state`, wiped when a run
starts it first: tables an older build left would break the hub. New
scenarios reuse `launchObsidian`, `startRelay`, `startWebDav`, `startS3` and
`connectPeer`; several Obsidians need distinct CDP ports.

`pnpm bench:share-pull` (`tools/bench/`) times a participant's first pull through
the real broker adapter and relay against direct S3, with modelled round trips;
results in `docs/share-pull-measurements.md`. It starts `wrangler dev` and two
delay proxies on ports 8899-8903.

## Manual install for testing

Copy `main.js`, `manifest.json`, `styles.css` to
`<Vault>/.obsidian/plugins/<plugin-id>/`, reload Obsidian and enable the
plugin in **Settings → Community plugins**. Both `main.js` and `styles.css` are
build outputs, so run `pnpm build` (or `pnpm dev`) first - neither is in git.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behaviour unless `isDesktopOnly` is `true`.
