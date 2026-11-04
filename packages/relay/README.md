# Relay

`mdsync-relay`: a user-owned Cloudflare Worker for live editing, sync signals, shared folders, links and Google Drive sign-in. Direct Durable Objects, no PartyServer; fits Workers Free.

Constraints: `.claude/rules/realtime.md`, `.claude/rules/spaces.md`, `.claude/rules/links.md`, `.claude/rules/security.md`, `.claude/rules/settings-setup.md`, `.claude/rules/live.md`, `.claude/rules/releasing.md`. Wire formats: `packages/protocol/README.md`.

## Service map

`src/index.ts` tries handlers in turn; CORS preflight on every path.

| Route | Entry | Service |
|---|---|---|
| `/hub` (WebSocket), `/hub/signal` (POST) | `src/hub/access.ts` | `Hub`: document logs, presence fan-out, revoked grants |
| `/share/*` | `src/share/broker.ts`, `src/share/admin.ts` | token broker and storage registration |
| `/link/*`, `/s/<id>` | `src/link/routes.ts`, `src/link/shell.ts` | one `Link` object per link; viewer shell |
| `/auth`, `/refresh` | `src/google-oauth.ts` | public OAuth proxy; no storage |
| `/status` | `src/index.ts` | secret-authenticated version; wrong URL: no answer; wrong secret: 401 |

Broker bytes go straight to S3. `src/share/sigv4.ts` uses shared WebCrypto SigV4; the AWS SDK is too heavy.

## Persistence layout

- KV `SHARE_TOKENS` (`src/share/kv.ts`): `tok:<token>` holds `shareId`, `participantId`, role `rw`/`ro`, label; `pt:<shareId>:<participantId>` names the current token; `storage:<shareId>` holds the registered S3 location and credentials. Negative answers are cached.
- Hub SQLite (`src/hub/store.ts`, `src/hub/revoked.ts`): `docs` holds snapshot, pointer and log name per `(channel, doc)`; `chunks` holds consecutive deltas with 4-byte lengths; `revoked` holds fingerprint/expiry; `closed` holds ended channels. Socket attachments hold slot/channel, fingerprint, `who`, `name` and subscriptions; tags allow only 10 entries.
- Link SQLite (`src/link/store.ts`): `link` holds views, limits, expiry, gate hash, salt and size; `chunks` holds the blob; `throttle` holds per-client state. An alarm erases expired links.
- Viewer assets: `packages/viewer/dist`, served under `/viewer/`.

## Hub model

One `Hub` (`hubStub`) saves sockets, handshakes and wake-ups.

- `src/hub/limits.ts`: 32 frames/s, burst 256; read-only awareness 20/s, burst 40, at most 4 KB. The burst accommodates an update and cursor for all 64 followed documents; sustained bulk edits can exceed it.
- Newcomers receive existing sockets' `HERE` before channel `JOIN`. Labels are cut to 64 UTF-16 units.
- Stale window 75 s, swept by an alarm every 37 s; each alarm costs a request and a row, and a lone ghost misleads nobody (the next arrival sweeps first). The client drops a link silent 90 s; a network change leaves a socket half-open, so `online`, turning visible and a send after 10 s of quiet ping first and drop it after 5 s without an answer.
- Append to the last chunk up to 4 KB, then start another: about 1.03 rows/update including compaction, versus about 2 per-delta. Head = last chunk's last seq, else snapshot seq; reads skip covered deltas in retained partial chunks.
- Recreated room rows get a fresh log name in `STATE`. Markdown up to 256 KB fits a snapshot in one frame and row; drawings may reach 1 MiB. Beyond a frame the leader rebuilds the room; beyond that the note returns to file sync. A refused note stays cold until closed.

## Google OAuth

`GDRIVE_CLIENT_SECRET` stays off devices. `/auth` signs timestamp/plugin nonce with it and sets an `HttpOnly` cookie before Google consent. The callback needs signed state and cookie: origin plus same-browser proof prevents sign-in to an attacker's Drive. It exchanges the code and redirects tokens/nonce to `obsidian://mdsync-auth`.

POST `/refresh` returns access/rotated refresh tokens; revoked tokens: 401 `invalid_grant`, not an outage. Missing Google secrets: 503 (`not_configured` on refresh).

## Deploy

`wrangler.toml` carries KV, `Hub`/`Link`, viewer assets and migrations. Secrets: `RELAY_SECRET`; optional `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET`.

- Plugin: `bundle.mjs` runs `wrangler deploy --dry-run`, emitting `dist/relay-bundle.json` (gitignored, text assets). `packages/plugin/esbuild.relay-bundle.mjs` exposes it. In `packages/plugin/src/features/relay/deploy/`, `relay-deploy.ts` provisions subdomain, KV and assets; uploads worker bindings/version/secret/migrations; calls `onUploaded`; enables the route. `keep_bindings: ["secret_text"]` preserves external Google secrets. First deploy finds KV by wrangler title, including workflow namespaces. `pendingMigrations` sends subsequent tags, refusing unknown tags to avoid destructive replays. New binding kinds must pass through `bundle.mjs`, `bundle.ts` (`RelayBundle`) and `uploadForm`.
- `.github/workflows/deploy-relay.yml`: tests, viewer build, `wrangler deploy --secrets-file`; missing `RELAY_SECRET` fails the run. Wrangler creates KV and objects on first deploy. No `RELAY_VERSION` means `/status` returns `null`, `relayBehind` is false and no update is offered.
- `HUB_STALE_MS` is a test-only stale-window override.

## Migrations and compatibility

`wrangler.toml`: `v1` created `SyncRelay`, `v2` replaced it with `Hub`, `v3` added `Link`.

## Accepted limits

- Grants ride in the hub URL (a browser WebSocket cannot send `Authorization`, `Sec-WebSocket-Protocol` is logged unredacted) and rely on Cloudflare's heuristic redaction of ids; a leaked owner grant admits for up to a day.
- Unauthenticated upgrades can cost 2 KV reads/slot; a Cloudflare rate-limiting rule on `/hub` is the remedy.
- Writable tokens can fill tails (2,000 deltas or 8 MiB since snapshot) and open unlimited documents; no channel-wide document cap.
- A relay can withhold, replay or reorder frames; additional data binds place, not time.
- Exhausting Free's 100k daily writes makes `Hub.dropGrant` / `purgeChannel` throw before cutting sockets. The owner sees an error; access lasts until retry succeeds after 00:00 UTC. Cutting first would leave KV admitting the token.
- Revoked writers retain file access for about 3 min (60 s KV cache + 120 s presign); signing never consults the hub's revoked table.
- Rooms persist until their share ends, in one 10 GB object. Deleting idle rooms is not enough: a deleted id is seedable again, so a stale disk takes the regrown log for a lost one and rotates over newer edits, and an expired pointer splits a note from its successor. Retiring needs a tombstone answered with a new signal, clients moving to the next generation (join, else seed) and a backfill within the Free write budget.
- Seeders learn the log name only at the next `STATE`; earlier log loss shows only when head falls behind.
- Writers can DELETE share objects; history, not revocation, repairs them.
- A hostile owner/operator serves the viewer and could read link notes.
- Compatibility: 1.3.0 clients show unknown `Refused(Unstored)` as generic cold status; older relays answer `not_found` on link creation and refuse one signing batch per transfer (redeploy notice).
- `SqlDocStore` converts 1.3 `deltas` to chunks transactionally; insufficient daily writes refuse document frames until retry, leaving the rest of the hub running. A manual rollback leaving both tables restarts every live log, preserving pointers; devices rotate from their text.

Tests: `tests/hub/`, `tests/share/`, `tests/link/`; real hub: `pnpm e2e:hub`.
