# Testing

- vitest covers core logic (diff, hunks, concurrency, ignore, etc.). Run with `pnpm test`, or `pnpm --filter obsync test:watch` while iterating.
- ALL domain logic (diffs, merging, concurrency, hunks matching, baseline cache) must have complete unit-test coverage.
- Tests mirror `src/`: `tests/<area>/<module>.test.ts`, helpers in `tests/helpers/`.
- Live sessions run against the relay's own hub logic and SQLite store in-process (`tests/helpers/live-hub.ts`, via the `obsync-relay` devDependency), with switches for lost frames and reconnects.

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
  its last run sets `HUB_STALE_MS` low to watch the stale-socket sweep.
- `pnpm e2e:realtime` - builds, then runs the plugin in a throwaway Obsidian
  (own `--user-data-dir` and temp vault, trust modal clicked) against the relay.
  `E2E_SOAK_MS=130000` adds an idle stretch past the link's silence timeout.
- `pnpm e2e:live` - two Obsidians type into one note through the relay; the
  shared key lives on an in-memory WebDAV (`startWebDav`).

Ports 8799 (relay), 8801 (WebDAV), 9223 and 9224 (CDP) must be free. A run
killed midway can leave `wrangler dev` holding 8799: kill that tree. New
scenarios reuse `launchObsidian`, `startRelay`, `startWebDav` and
`connectPeer`; several Obsidians need distinct CDP ports.

## Manual install for testing

Copy `main.js`, `manifest.json`, `styles.css` to
`<Vault>/.obsidian/plugins/<plugin-id>/`, reload Obsidian and enable the
plugin in **Settings → Community plugins**. Both `main.js` and `styles.css` are
build outputs, so run `pnpm build` (or `pnpm dev`) first - neither is in git.

## Mobile

- Where feasible, test on iOS and Android.
- Don't assume desktop-only behaviour unless `isDesktopOnly` is `true`.
