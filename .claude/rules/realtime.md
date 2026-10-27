---
paths:
  - 'packages/plugin/src/core/hub/**'
  - 'packages/plugin/src/features/relay/connection.ts'
  - 'packages/plugin/src/features/relay/channels.ts'
  - 'packages/plugin/src/app/realtime.ts'
  - 'packages/protocol/src/**'
  - 'packages/relay/src/hub/**'
---

# Realtime hub and protocol

Hub model, storage, accepted limits: `packages/relay/README.md`. Wire formats: `packages/protocol/README.md`. Live documents: `.claude/rules/live.md`; presence: `.claude/rules/presence.md`; share broker and tokens: `.claude/rules/spaces.md`. Plugin paths are relative to `packages/plugin/src/`.

## Formats

- `packages/protocol/src/frames.ts` and `packages/protocol/src/codec.ts` are the only definition of a frame: plugin, relay and tests import them. A new frame is a `CLIENT` or `SERVER` codec entry; a new field goes last in its body (State's `log`: an older reader stops short); a new `ERefusal` also needs its `ColdCause` in `REFUSED` (`features/live/workspace/room.ts`), or the client cannot say why the note went cold. Plugin and relay deploy apart, so both directions stay tolerant.
- `decodeClient` / `decodeServer` return null for anything malformed, never throw. A text field is at most 255 bytes (one length byte): cut a name before framing it (`MAX_NAME_LENGTH` in `packages/relay/src/hub/access.ts`).
- Limits are protocol constants (`MAX_FRAME_BYTES`, `MAX_SLOTS`, `MAX_DOC_SUBS`, `MAX_DOC_ID_LENGTH`, `MAX_MOVE_NOTE_BYTES`) shared by client and hub. `MAX_DOC_SUBS` follows from the 16 KB socket attachment.
- Every sealed payload names its place as AES-GCM additional data (`SealedFor` in `core/crypto/seal.ts`: `doc:<docId>`, `awareness:<docId>`, `moved:<docId>`, `presence`): the relay cannot move a frame into another document or kind. A rotation is sealed for its target, a rename note for the room it left. A new kind of payload gets its own tag.
- docId = HMAC (`docIds` key) of `<path inside the space root>#<generation>`, 16 bytes (`features/live/doc-id.ts`), so every mount of a share meets in one room. Frame and docId keys are HKDF outputs of the space key, derived where the envelope is unwrapped (`core/crypto/live-keys.ts`; the content key is not extractable).
- The relay sees ciphertext, sizes, timings, a hashed channel and a device id; never a path, file content or key. What else it holds: `.claude/rules/security.md`.

## Echo and delivery

- The Echo is the ACK and names the update by the sender's counter `n`. The hub answers a socket in order, so an earlier unacked update was dropped and goes out again at once (`Outbox.ack`, `features/live/session/outbox.ts`); one with no echo for `ACK_PATIENCE_MS`, and all of them after a reconnect, go again (Yjs updates are idempotent). Never ACK before the write is stored.
- A dropped `SUB`, `SEED` or `ROTATE` is not retried: the note turns "unanswered" until the next socket. `SUB` carries `since`: a reconnect gets the tail, not the whole state.
- Over the rate (`FrameLimits`) a frame is dropped unanswered; the echo gap tells the client. A document frame refused for size, too many documents, a read-only grant or failed storage answers `Refused{reason}` to its sender only (`refuse`): unanswered, the client waits forever. A new refusal path answers too; only malformed frames, frames for an unfollowed document and bad `Sub`/`Rotate` fields are dropped silently.
- `Seed` goes only into a document with no log (the loser gets the room to merge into, or text doubles). `Rotate` seeds the target and points the old log at it atomically, only while the log ends at `upto`, else the rotator gets the room: an update after `upto` would be acked here and missing there. A moved document answers every frame with its pointer.
- `LEAVE` drops a socket's awareness at once, but only of clients that socket announced last (a dead socket's `LEAVE` comes after its successor's); every announcement moves the awareness clock on, or a peer that dropped the state never takes it back (`features/live/session/room-awareness.ts`).
- Sends are paced because each update is a hub row (Free: 100k rows a day): at once, then once per `liveSendMs`; cursors per `ANNOUNCE_MS`, and nothing while alone in the room.

## Hub (`packages/relay/src/hub/`)

- Admission is the worker's (`handleHubRequest`, `grantFor`): a request with no valid grant never wakes the Durable Object, which accepts only an upgrade carrying `HUB_ADMISSION_HEADER`. An empty `RELAY_SECRET` fails closed. A channel asked twice is admitted once.
- Owner grant: `<expiry>.<HMAC>` (`deriveChannelGrant`), minted per connection, `GRANT_TTL_S` (a day); refused when expired or minted further ahead than a skewed clock explains (`CLOCK_SKEW_S`). A share token is admitted only while `shareGrantOf` calls it live. A socket outlives its grant.
- The hub is blind: it orders and forwards ciphertext, never merges. Presence is never stored; `JOIN`/`HERE` carry the `who` and `name` of the vouched grant (`vouchedFrame`): nothing a client seals counts as identity.
- Read-only grant: each write answers `Refused(ReadOnly)`; `Signal` is dropped (HTTP 403: it would only wake everyone); awareness has its own ceiling (`READ_ONLY_AWARENESS`, `MAX_READ_ONLY_AWARENESS_BYTES`).
- One SQLite transaction per document frame (`DocStore.atomic`). A throw rolls back, clears the caches and answers `Refused(Unstored)`: unanswered the writer resends forever, and half a seed leaves a row that answers every seed with `State(head 0)`. The echo follows a successful `append` or `seed` in the same run (`logged`): a full log answers `Refused(TooLarge)`, a failed write rolls back and answers `Refused(Unstored)`, never an echo. `Sub` reads before it follows (the attachment is outside the transaction).
- Tails are capped (`MAX_TAIL_DELTAS`, `MAX_TAIL_BYTES`): a log nothing compacts refuses writes with `TooLarge` and the note goes back to the file sync. A snapshot replaces the log only up to `upto` (clamped to the head); an empty or older one is ignored.
- State lives in the socket attachment and SQLite, never in memory beyond caches: the object hibernates between frames, and `ping` is answered without waking it. Sweeps run by alarm only while two or more sockets are open; `leave` announces once.
- Schema: `CREATE TABLE IF NOT EXISTS` plus the settle step in `SqlDocStore`. A new Durable Object class needs a new migration tag in `packages/relay/wrangler.toml`, never an edited one.

## Refusal and revocation

- Revoking cuts the hub before it forgets the token (`dropToken` in `packages/relay/src/share/kv.ts`): a failed cut is retried by repeating the revoke. `Hub.dropGrant` keeps the fingerprint `REVOKED_MS` (5 minutes) and refuses it on connect and on HTTP signal, since KV may still admit the token for about a minute.
- A cut slot gets `REVOKED(slot)` and other slots live on; a socket with none left closes `UNAUTHORIZED_CLOSE_CODE`. `purgeChannel` (a share ended) deletes the rows and shuts the channel for good (`closed`): no write can bring it back.
- Client: `HubConnection` marks the slot revoked and ignores its signals; it retries `REVOKED_RETRIES` times (jittered, doubling), a refused socket `UNAUTHORIZED_RETRIES` times (a fresh token can be refused for a minute while KV catches up), then reads `unauthorized` until settings change or the device wakes (`online`, page visible).
- Space channels are `SpaceHub` per space behind `SpaceHubs` (`core/hub/space-hub.ts`); `HubConnection` implements them, live and presence see only the contract.
- Relay state is one answer: `HubConnection.statusOf` -> `relayStatus` (`core/hub/status.ts`). A display never derives its own.

## Client socket

- One `HubLink` per relay, channels addressed by slot = index in `HubRoute.spaces`, the vault first. `hubRoutes` (`features/relay/channels.ts`): vault and owned shares on the own relay, joined shares on their owner's; paused and closed shares get no slot; past `MAX_SLOTS` a space is `full`, never queued. `HubRoute.key` holds everything the socket depends on: a change reconnects that socket only.
- Vault channel = `sha256(storageIdentity)`, share channel = `shareChannel(id)`: the relay never sees an endpoint or bucket. Grants are asked per connection (`channels()`), never reused past their day.
- Grant and token ride in the URL (a browser WebSocket sends no `Authorization`; `Sec-WebSocket-Protocol` is logged unredacted): never log the hub URL.
- `HubLink.send` drops while down: callers resend on reconnect. A send after `PROBE_AFTER_MS` of quiet pings first and a missing answer in `PROBE_MS` drops the link; `KEEPALIVE_SILENCE_MS` of quiet drops it too. Backoff is jittered and restarts on the first message, not on open.
- Listeners outlive socket rebuilds; `onConnectionChange(false)` fires on every restart so state tied to the old link is dropped. `HubLink.signal` posts `/hub/signal` when the socket is down: best effort.

## Tests

- Hub logic runs in-process (`packages/relay/tests/hub/`, `packages/relay/tests/helpers/hub.ts`); protocol round trips in `packages/protocol/tests/codec.test.ts`; `pnpm e2e:hub` against `wrangler dev`.
