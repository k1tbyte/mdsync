# Protocol

`@mdsync/protocol` shares wire formats and signing across plugin, relay and viewer. `package.json` points `main` at `src/index.ts`; no build step.

Constraints: `.claude/rules/realtime.md`, `.claude/rules/links.md`, `.claude/rules/security.md`.

## Map

| File | Defines |
|---|---|
| `src/frames.ts`, `src/codec.ts` | frame types, limits, paths, encode/decode, `withSlot` |
| `src/bytes.ts` | `Writer` / `Reader`, base64url, hex |
| `src/admin.ts`, `src/grant.ts` | `ADMIN_HEADER`, owner grants |
| `src/share.ts` | share ids, channel, storage prefix, signing batch size |
| `src/link.ts`, `src/link-content.ts` | link seal, headers, URL helpers; sanitizer allow-lists |
| `src/sigv4.ts` | shared request-signing/presigning pieces |

## Hub frames

Frame: `[type:u8][slot:u8][docLen:u8][doc][body]`. `doc` is opaque, or `""` (`CHANNEL_DOC`) for channel frames. Text lengths use u8; block lengths use u32.

**Client to hub** (`ClientFrame`):

| Frame | Body | Meaning |
|---|---|---|
| `Sub` | `since` | follow |
| `Unsub` | none | unfollow |
| `Update` | `n`, sealed update | append |
| `Seed` | `n`, sealed update | initialize |
| `Snapshot` | `upto`, sealed snapshot | compact |
| `Rotate` | `target`, `upto`, sealed `note`, sealed seed | move |
| `Awareness` | sealed payload | cursor or channel presence |
| `Signal` | none | channel push notification |

**Hub to client** (`ServerFrame`): `State(head, snapshot, deltas, log)`, `Fanout(seq, from, sealed update)`, `Echo`, `Peer(from, sealed awareness)`, `Join` / `Here(from, who, name)`, `Leave`, `Moved(target, sealed note)`, `Revoked`, `Refused(ERefusal)`, `Signal`. `from` is a socket tag, not identity.

Connect: `HUB_PATH` with `c`/`t` per slot and `d` (`EHubParam`); `HUB_SIGNAL_PATH` takes those params for one channel over HTTP. Text keepalive: `ping` / `pong`.

`ERefusal`: `TooLarge`, `TooManyDocs`, `ReadOnly`, `Unstored`.

## Grants and identity

Owner grant: `<expiry>.<HMAC-SHA256(RELAY_SECRET, "<expiry>:<channel>")>`; unix seconds, lowercase hex. Share channel: `mdsync-share-<id>` (`shareChannel`). `isShareId` validates ids; `sharePrefix` builds storage prefixes. Share tokens belong to `packages/relay/src/share/kv.ts`, not this package.

## Share links

- Id: 16 random bytes, base64url (22 chars, `isLinkId`); key: 16 bytes (`LINK_KEY_BYTES`).
- `LinkPayload`: `{title, html, createdAt}`. Blob: version byte, IV, ciphertext (`sealLinkPayload`, `openLinkPayload`).
- `LINK_HEADERS`: gate/salt in, views-left/expiry out. Replies: `LinkMeta`, `LinkStatus`; `LinkPutMode`: `create` / `update`.

## Limits and compatibility

- `MAX_SLOTS` 32 per socket, `MAX_FRAME_BYTES` 1 MiB, `MAX_DOC_SUBS` 64.
- Plugin and relay deploy apart (a user's relay may be older or workflow-deployed): keep both directions readable, never reuse a frame number.

## Tests

`tests/codec.test.ts` (round trips, malformed input, legacy state), `tests/link.test.ts` (seal, binding, tampering, size), `packages/relay/tests/hub/` (both sides).
