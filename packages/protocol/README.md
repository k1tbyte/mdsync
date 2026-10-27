# Protocol

`@mdsync/protocol`: the wire formats the plugin, the relay and the viewer share. Types and functions here are the single definition; a package that needs one imports it, never copies it. Source is the reference (`packages/protocol/package.json` points `main` at `packages/protocol/src/index.ts`, no build step), this file is the map. Hub constraints: `.claude/rules/realtime.md`; link constraints: `.claude/rules/links.md`.

| File | Defines |
|---|---|
| `packages/protocol/src/admin.ts` | `ADMIN_HEADER`, the request header that carries the relay secret |
| `packages/protocol/src/frames.ts` | hub paths and query params, keepalive constants, `EFrame`, `ERefusal`, `ClientFrame` / `ServerFrame`, limits, `OWNER`, `CHANNEL_DOC` |
| `packages/protocol/src/codec.ts` | `encodeClient` / `decodeClient`, `encodeServer` / `decodeServer`, `withSlot` |
| `packages/protocol/src/bytes.ts` | `Writer` / `Reader` (u8, u32, length-prefixed text and blocks), base64url and hex |
| `packages/protocol/src/grant.ts` | the owner's channel grant: `deriveChannelGrant`, `grantExpiry`, `GRANT_TTL_S` |
| `packages/protocol/src/share.ts` | share ids, the share's hub channel and storage prefix, signing batch size |
| `packages/protocol/src/link.ts` | the share-link seal: ids, keys, gate, payload, URL, route headers, limits |
| `packages/protocol/src/link-content.ts` | the `href` and image `src` allow-lists used by the plugin's sanitizer and the viewer's |

## Hub frames

A frame is `[type:u8][slot:u8][docLen:u8][doc][body]`. `slot` names a channel within one socket (index in the `c`/`t` pairs of the connect URL); `doc` is an opaque HMAC, or `""` (`CHANNEL_DOC`) for the channel itself; `body` is ciphertext or a few integers. Text fields carry a one-byte length (255 bytes at most), blocks a four-byte one.

**Client to hub** (`ClientFrame`):

| Frame | Body | Meaning |
|---|---|---|
| `Sub` | `since` | follow a document; answered with `State` (the tail since `since`) |
| `Unsub` | none | stop following |
| `Update` | `n`, sealed update | append to the log; answered with `Echo(seq, n)` |
| `Seed` | `n`, sealed update | `Update` into a document with no log only |
| `Snapshot` | `upto`, sealed snapshot | replace the log up to `upto` (compaction) |
| `Rotate` | `target`, `upto`, sealed `note`, sealed seed | seed `target`, point this log at it, only while it ends at `upto` |
| `Awareness` | sealed payload | cursors (document) or presence (channel); never stored |
| `Signal` | none | on the channel: another device pushed, pull |

**Hub to client** (`ServerFrame`): `State` (`head`, `snapshot`, `deltas`, then `log`, the log's name), `Fanout` (`seq`, `from`, sealed update), `Echo`, `Peer` (`from`, sealed awareness), `Join` and `Here` (`from`, `who`, `name`: a socket as the hub vouches for it; `Here` is someone already present, told to a newcomer), `Leave`, `Moved` (`target`, sealed note), `Revoked`, `Refused` (`ERefusal`), `Signal`. `from` is the hub's per-socket tag, not an identity.

Connect and keepalive: `HUB_PATH` with one `c` and `t` per slot plus `d` (`EHubParam`); `HUB_SIGNAL_PATH` takes the same params for one channel over HTTP. Text `ping` is answered `pong` by the hub without waking it (`KEEPALIVE_*`). `UNAUTHORIZED_CLOSE_CODE` closes a socket none of whose slots is admitted. Limits: `MAX_SLOTS` 32, `MAX_FRAME_BYTES` 1 MiB, `MAX_DOC_SUBS` 64, `MAX_DOC_ID_LENGTH`, `MAX_MOVE_NOTE_BYTES`.

Refusals (`ERefusal`): `TooLarge`, `TooManyDocs`, `ReadOnly`, `Unstored`. Each tells the client to stop waiting on that frame.

## Grants and identity

An owner grant is `<expiry>.<HMAC-SHA256(RELAY_SECRET, "<expiry>:<channel>")>` (unix seconds, lowercase hex), valid for one channel, `GRANT_TTL_S` (a day) long. A share's channel is `shareChannel(id)` (`mdsync-share-<id>`), the vault's is the SHA-256 of its storage identity; a share's objects live under `sharePrefix(prefix, id)`. `isShareId` is the one validity check. `OWNER` is the `who` of a socket the secret admitted. Share tokens are the relay's (`packages/relay/src/share/kv.ts`), not a protocol format.

## Sealed payloads

The hub carries ciphertext sealed by the plugin (`packages/plugin/src/core/crypto/seal.ts`): AES-GCM under the space's frame key with the place as additional data (`doc:<docId>`, `awareness:<docId>`, `moved:<docId>`, `presence`). The protocol defines the frames around them, not the sealing; the docId derivation is `packages/plugin/src/features/live/doc-id.ts`.

## Share links

`packages/protocol/src/link.ts` is the only definition (plugin seals, viewer opens, relay checks the gate).

- URL `<relay>/s/<id>#<key>[/<anchor>]` via `linkUrl` / `parseLinkLocation`. `id` is 16 random bytes in base64url (22 chars, `isLinkId`), `key` 16 bytes (`LINK_KEY_BYTES`).
- Payload `{title, html, createdAt}` (`LinkPayload`) -> JSON -> deflate -> AES-GCM with additional data `link:<id>`; blob = version byte, IV, ciphertext (`sealLinkPayload`, `openLinkPayload`). Inflating stops past a limit, since deflate ratios reach 1000x.
- `deriveLinkKeys`: content key and gate are two HKDF outputs of the fragment key, plus PBKDF2 (`LINK_KDF_ITERATIONS`) of the trimmed, NFC-normalized passphrase and a salt when protected. The relay stores only a hash of the gate.
- Relay routes use `LINK_HEADERS` (gate, salt in; views left, expiry out), `LinkMeta` and `LinkStatus` answers, `LinkPutMode` (`create` or `update`) and the `LINK_MAX_*` caps.

## Changing a format

- Plugin and relay deploy apart (the plugin ships a relay bundle, but a user's relay may be older or from the workflow), so a change keeps both directions readable: add a field at the end of a body, tolerate its absence, never reuse a frame number.
- Tests: `packages/protocol/tests/codec.test.ts` (round trips, malformed input, a state without a log), `packages/protocol/tests/link.test.ts` (seal, id binding, tampering, size). Both sides of a changed hub frame are also exercised by `packages/relay/tests/hub/`.
