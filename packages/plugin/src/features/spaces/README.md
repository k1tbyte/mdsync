# Shared folders (spaces)

A shared folder is a **space**: a vault folder with its own storage, key and history, synced by the same engine as the vault (`features/sync/README.md`). This slice holds the records that describe spaces, the partition built from them, how a device reaches a share (own S3 or the owner's relay broker), invites, moves, pause and the share window. It does no networking of its own except the broker client in `features/spaces/broker/`. The relay side is `packages/relay/src/share/` (`packages/relay/README.md`). Constraints: `.claude/rules/spaces.md`; engine side of the partition: `.claude/rules/sync-integrity.md`.

## Decisions

| Decision | Why |
|---|---|
| A space is the unit of sync; the vault and a share run one engine | one history, one live path, no parallel share cycle |
| Every path belongs to exactly one space; a share's data lives once | two writers on one path corrupt it |
| No accounts: a person is a vault (storage + passphrase), their bucket is their control plane | serverless, no third-party service |
| A share mounts itself on all of a person's devices; pause is per device or on all of them, and a device can turn shares off | otherwise the folder freezes: out of the vault, not in the share; paused, it stays out of the vault while nothing of it syncs |
| Leaving, closing or revocation never deletes files | they return to that person's vault |
| Owning a share needs S3-compatible storage | WebDAV and Google Drive cannot presign |
| A participant gets presigned URLs from the owner's relay, never credentials | the owner's keys stay in the owner's KV; revoking a token is one broker call |
| No integration with the Relay plugin (No-Instructions/Relay) | paid past 3 participants, closed control plane. Its MIT code may be borrowed with attribution in the source header, as `features/sync/hunks/anchored-hunks.ts` does; there is no NOTICE file |

## Model

A **person** is a vault's owner (`owner` on the hub) or a broker token's `participantId`; a **device** syncing that vault is the person's, anything else joins by invite. Attribution, presence and revocation work per person. A participant is named as the owner invited them (`personName`); the owner by **Your name** (Settings, Shared folders), kept on each of their open shares' owner access so every device of theirs reads one through the records' trade, "Owner" while empty (`features/spaces/record.ts`, `features/spaces/owner.ts`). A new share takes the name the others carry. The relay vouches only the `owner` key, so peers read that name from the owner's own announcement (`ChannelPresence.nameOf`).

| | root | key | storage | hub grant |
|---|---|---|---|---|
| vault | `/` minus share roots | vault data key | bucket root | `deriveChannelGrant(RELAY_SECRET, channel)` |
| own share | a folder | share key | `<prefix>/shares/<id>/` | same |
| joined share | own folder | share key | broker, presigned URLs | share token |

**Records** (`settings.spaces`, `features/spaces/record.ts`) are published one object each as `<prefix>/spaces/<id>.json.enc` under the vault key (`features/spaces/remote.ts` over `features/storage/records.ts`), so concurrent adds never race; one record edited on two devices is last-writer-wins (`rev`, then author). They are never in `manifest.json.enc` because the state file (`features/sync/state.ts`) keeps the manifest in plain text. A record is re-read only when its listing etag differs from the etag of the bytes last read (cached per storage, key and prefix; one it just published, or one that will not decode, is read again next cycle): a quiet cycle is one list and no GETs. A backend that lists no etags reads every record.

A share's location (endpoint, bucket, prefix) is pinned once: re-deriving it from current settings orphans its objects. Credentials never enter a record; each owner device uses its vault's current S3 credentials. Records belong to the vault storage they were traded with (`settings.spacesVault`).

**Pause** is one rule (`pauseOf` in `features/spaces/partition.ts`, read by the partition, the hub's routes and status, and `openShare`): `useSharedFolders` off pauses every share on that device, arriving ones too; the record's `paused` pauses it on every device of the person (published, LWW like any record edit; a resume from any device clears it); `pausedSpaces` on this device alone. Records still trade while shares are off, or the device would read a share's folder as vault files the vault no longer lists. Device-local, never published: `useSharedFolders`, `pausedSpaces`, `pauseArrivingShares`, `localRoots` (a move not yet followed here).

**Ignore.** Every space ignores by its own ignore note (`IGNORE_FILE_NAME`, `core/constants.ts`) in its root, rules relative to it; the vault's rules stop at a share's root. **Share folder** first writes one exact rule per path the vault's rules kept out, or those files would reach every participant. Device-local patterns apply everywhere.

**Roots** never overlap; nested shares and re-sharing someone else's are refused; only the owner invites. Two offline devices sharing one folder: the lower id wins, the other record is inert (`SpaceRecords.inert`, warned once).

**Broker signing.** The broker lets a participant into `shares/<id>/` only (`packages/relay/src/share/key.ts`); vault GC lists only `objects/`, `recipes/`, `chunks/`, `pins/` and `history/`. Pulls and pushes hint their object keys (`prepareReads`, `prepareWrites`); `features/spaces/broker/share-signed-urls.ts` lazily signs up to `SIGN_BATCH_MAX` GET or PUT URLs when the first is needed, because signing every object alone made a pull several times slower than direct S3. Expired URLs and failed batches fall back to single signing; an older relay costs one refused batch per transfer. The relay checks the token once, derives one signing key, rejects an unsafe key's whole batch and refuses PUT batches from read-only grants. Existence probes remain listings.

## Lifecycle

- **Share folder** (`shareFolder`) writes the record; the next refresh publishes and pushes it, and the push's signal wakes the owner's other devices, which mount it. Without a configured relay the share works across the owner's own devices; the notice says a relay is needed to invite people.
- **Invite** (`createInvite`) registers the share's location with the broker, remembers that relay in the owner's record (`access.relayUrl`), issues one token per person and seals `{id, name, key, relayUrl, token, participantId, personName, readOnly}` under a 60-bit password (`sealLink`), sent apart.
- **Accept** (`mountShare`) needs a new or empty folder (a full one would ship its files into someone else's share). A link to a share already here replaces its access in place: same folder and baseline, since the broker's storage identity is `broker|<id>`, not the relay. That is the way back after a re-invite or a move of the owner's relay; the owner's share window names the old relay.
- **Guest**: accepting needs no vault storage. A device without one (`isGuest`) syncs its joined shares and never opens the vault; its records stay in its settings. Once the vault is set up, the first trade admits them as an accept there would (`admitJoined`: no vault file and no other share at the root, else the refresh stops until the folder is renamed). In that trade (`syncRecords`, `unbound`) an open record outranks the vault's older close of it, and a share the vault owns stays its owner's whatever this device joined or left of it (its folder moves to the owner's root).
- **Move** is a record edit; the person's other devices move the folder (`features/spaces/share-moves.ts`). Paths inside the share and docIds do not change. A root gone on one device detaches that device (`SpaceGoneError`, `features/spaces/ui/space-gone.ts`); it never deletes for all.
- **Stop sharing / Leave** tombstone the record; the folder returns to the vault. Stop sharing then deletes `shares/<id>/` through the operation queue, so no refresh mounts the share again meanwhile; a failure only leaves orphans. Leave revokes the participant's own token at the broker (`DELETE /share/token`), never one issued after it; an unreachable relay does not stop the leave. Stop sharing from a vault whose relay is not the one the invites went through warns that their tokens live on there.
- **Revocation** closes the share on the participant's devices: a broker `unauthorized` that still holds for the same token 90 s later tombstones the record as Leave does (no broker call, the token is dead) and asks at once whether to keep its files or trash the folder (`features/spaces/ui/access-ended.ts`). The wait is because the broker's KV is eventually consistent (about 60 s, negative answers cached): a fresh or renewed token looks revoked at first, and a false close would reach every device of that person. A hub `REVOKED` pulls, so the broker is asked soon. People may lag an invite; a revoke shows at once, as the list reads each pointer.
- **Owner credentials**: after a good compare the owner device resends its S3 credentials to the broker (`createShareRegistration`), hourly, only where an invite went before.

## Accepted limitations

- Every share owner is the key `owner`: two shares of unnamed owners show them alike.
- The read-only lock (`features/spaces/ui/read-only.ts`) is the editor's: Properties, renames and other plugins still change files there, which then wait unpushed. A note moved into a read-only root while open locks on reopening. A drawing locks once its view loaded (up to 500 ms), and scripts can still edit it.
- A read-only participant's local changes in the share stay pending: auto-push skips them, an explicit push holding any of them is refused, **Revert this file** drops them. A read-only participant ignores only on their device.
- A revoked writer keeps file storage for up to about three minutes: the broker signs by the KV grant (cached about 60 s), never the hub's revoked table, and a presigned URL lives 120 s. They held the same rights a moment before; asking the hub on every signature costs a Durable Object round trip per object.
- The broker presigns DELETE too: a writer can remove a share's objects; history, not revocation, repairs that. `packages/relay/src/share/key.ts` is the whole boundary: it fails closed, and every change needs traversal tests.
- Re-inviting recognises a person by name, case-insensitively: one name is one participant, a renamed person is a new one, an unnamed invite is always new.
- `reset-remote-storage` leaves `shares/`, `spaces/` and `links/`: resetting the vault does not end shares others depend on, nor forget live share links.
- Mounting over one's own copy: identical files converge; an edit made before the record arrived is a conflict with no base in the share.
- The vault drops a share folder's frozen entries at its next push, so they stop holding the folder's blobs (`features/sync/remote/foreign.ts`); history keeps them until it rolls off. The baseline forgets them at the next refresh; until the share's baseline on this device takes a path, its entry stays in `shareBases` as the live merge base. Until that push the vault lists them. A device whose refresh read the records just before the share was created, or that skipped the share's whole open period and first refreshes after Stop sharing before the owner pushes the folder back, reads them as deletions of unchanged files; the share or the owner's push brings them back. A share kept paused while it is edited and closed gives that device conflicts, not a clean pull.
- Closing where the folder is gone returns an empty root: entries the vault still lists (no vault push since the share opened) read as deletions (files edited since give a conflict). A share empties only by closing; deleting every file also hits `SpaceGoneError`.
- A root move rehashes the moved files once, deletes the vault's frozen copy at the old path on the next push if one is still listed (history keeps it), and two offline moves converge by LWW (the loser moves again). A folder moved outside Obsidian, or while it was closed, is a vanished root (`SpaceGoneError`) plus new vault content. A rename in Obsidian cancels the running operation, so a pull stops writing under the old path.
- Pointed at another vault storage, a device drops the records rather than publish share keys into it, and their folders stay as plain files. It says so and forgets its state of them, so back at the first vault they mount afresh; a folder moved elsewhere meanwhile stays behind as vault content. Credentials are not the location: new keys to the same bucket keep every owned share.
- A failed share is retried on every refresh (one broker request), not backed off; an explicit operation on its paths shows its error, which the scheduler does not count.
- A closed share's ignore note stays as a plain file: the vault's rules govern the folder again.
- A new own share restarts the vault's socket, so live sessions resubscribe. A note whose folder becomes a share leaves its vault room in the hub (rooms are never trimmed); other devices type there until the record's signal moves them, then fold those edits into the share's room.
- A participant's other devices hear of an accepted share by signal only with a relay of their own.
- A guest has no vault socket: the ribbon's relay dot and the vault's relay line read offline while its shares' channels are live. A guest's shares reach the person's other devices only once it sets up the vault; files another device has in that folder but never pushed are pushed into the share there, as with any record arriving over one's own copy.
- The manifest caches (`validators`, `publishedHeads` in `features/sync/remote/manifest.ts`) live as long as their storage adapter; a share's root is in its adapter memo (`ShareStorage.memo`), so a new root is a new adapter.

## Tests

`packages/plugin/tests/features/spaces/` mirrors the slice; `packages/plugin/tests/helpers/space-records.ts` builds records; the broker is covered by `packages/relay/tests/share/`. Real flows: `pnpm e2e:shares`, `pnpm e2e:invite`, `pnpm e2e:guest` (`tests/e2e/README.md`).
