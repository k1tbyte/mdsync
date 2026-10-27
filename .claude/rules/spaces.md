---
paths:
  - 'packages/plugin/src/features/spaces/**'
  - 'packages/plugin/src/app/session-factory.ts'
  - 'packages/plugin/src/app/bootstrap.ts'
  - 'packages/relay/src/share/**'
---

# Shared folders (spaces)

Model, flows, accepted limits: `features/spaces/README.md`. What the engine does with the partition (frozen entries, `SpaceGoneError`, relative remote paths, vault-wide listings): "Spaces" in `.claude/rules/sync-integrity.md`. Hub and grants: `.claude/rules/realtime.md`. Share links are not spaces: `.claude/rules/links.md`. Plugin paths below are relative to `packages/plugin/src/`.

## Identity and records

- A person is a vault's owner (`OWNER`) or a broker token's `participantId`; attribution, presence and revocation work per person (`shareIdentity` in `features/spaces/record.ts`). The relay vouches only the `owner` key: a participant's name is the label the owner invited them by, the owner's is **Your name**, kept on every open owner share (`renameOwner`) so all their devices read one.
- One object per record, `spaces/<id>.json.enc` under the vault key, through `readRecords` / `writeRecord` (`features/storage/records.ts`): concurrent adds never race, one record edited on two devices is last-writer-wins (`isNewer`: `rev`, then `author`). Every edit bumps `rev` and sets `author`. Never in `manifest.json.enc`: the state file (`features/sync/state.ts`) keeps the manifest in plain text.
- A listing etag decides re-reads (a quiet cycle is one list, no GETs); a record that will not decode is never written over (`syncRecords` in `features/spaces/remote.ts`): it may be newer or of a newer format.
- A share's location (endpoint, bucket, prefix) is pinned at creation (`ShareLocation`): re-deriving it from settings orphans its objects. Credentials never enter a record: each owner device signs with its vault's current S3 credentials (`ownerStorageConfig`). Owning needs S3 (`ownerStorage` in `features/spaces/owner.ts`): WebDAV and Drive cannot presign.
- Records belong to the vault storage they were traded with (`settings.spacesVault`, `bindTo`): pointed at another vault the device drops them, never publishes share keys into it.
- Device-local, never published: `useSharedFolders`, `pausedSpaces`, `pauseArrivingShares`, `localRoots`. Replace `settings.spaces`, `pausedSpaces`, `localRoots`, never edit in place: `SpaceRecords.partition()` memoizes on their identity.

## Partition and pause

- `spacesOf` (`features/spaces/partition.ts`) is the one partition builder: vault first, then open records by id; a root overlapping one already held is skipped (lower id wins, the other is inert and warned once, `SpaceRecords.inert`). `mountError` refuses the vault root, hidden folders, nested and re-shared roots. Only the owner invites.
- Pause has one rule, `pauseOf`: shares off here (`useSharedFolders`), `record.paused` (published, every device of the person), `pausedSpaces` (this device). Ask it; never read those fields to decide. A paused share stays in the partition (marked `paused`) or the vault would publish its folder; records still trade while shares are off.
- `openShare` and `localShareStorage` (`app/session-factory.ts`) refuse a paused record; a share opens with the key in its record, never the vault passphrase. A guest (`isGuest`) has no vault storage: `openVault` returns null silently, its records stay in settings.
- `admitJoined` throws when a joined share's root holds vault files or another share: the refresh stops until the folder is renamed (a guest's first trade with a new vault).
- `spaces()` in `app/bootstrap.ts` keeps its order: vault session, `admitJoined`, `spaces.sync`, `links.sync` (a failed links trade warns, never fails the refresh), `forgetSpace` of closed and left shares, `followMoves`, `warnInert`, then the partition. Following moves before the partition is what keeps an old root from becoming vault content.

## Close, leave, revoke

- Closing is a record edit: `closeRecord` tombstones it (`rev` + `CLOSE_REV_STEP`), the folder returns to the vault. Never delete files, never delete a record. `closeHere` (`features/spaces/ui/share-action.ts`): close, refresh, then `forgetSpace`; `deleteRemote` only for the owner.
- Stop sharing ends the broker's tokens first (relay configured) and aborts when that fails: live tokens would keep writing where nobody reads. An unreachable relay never stops a Leave. A vault whose relay is not the one invites went through warns first (`strandedInvites`).
- A participant's share closes on revocation only when the broker's `unauthorized` still holds `RECHECK_MS` (90 s) later (`createAccessEnded`): broker KV lags ~60 s, a fresh token reads as revoked, and a false close reaches every device of that person. Never shorten it.
- `reset-remote-storage` leaves `shares/`, `spaces/` and `links/`.

## Moves, invites, ignore

- A rename of a share root (or a folder above it) is a record edit (`registerShareRenames`: `moveRoot`, cancel, `scheduleScopeRefresh`); into another share or a hidden folder it is renamed back. Other devices follow in `createMoveFollower`, before the partition; `localRoots` holds the old root until followed, a closed share's folder is never moved.
- `createInvite` registers the storage at the broker on every invite (current credentials), issues one token per person (same name, trimmed and case-folded, keeps `participantId`; the old link dies, older duplicates are revoked), remembers `access.relayUrl`, seals under a 60-bit password (`invitePassword`) sent apart. The password is never stored.
- `mountShare` needs a new or empty folder (a full one would ship its files into someone else's share) and refuses an owner's own share, closed too. A link to a share already here replaces its access in place (`renew`): the storage identity is `broker|<id>`, not the relay. Accepting runs `forgetSpace` so no old baseline is read.
- `syncRecords` `unbound` (records made before this device knew the vault): an owner record beats a participant's, an open join outranks the vault's older close.
- Every space reads its own ignore note (`IGNORE_FILE_NAME` in `core/constants.ts`) in its root (`ignoreNoteOf` in `features/sync/scope/ignore.ts`); the vault's rules stop at a share's root, device-local patterns apply everywhere. **Share folder** first writes one exact rule per vault-ignored path into the share's note (`carryVaultIgnores`), or those files reach every participant.

## Broker (`features/spaces/broker/`, `packages/relay/src/share/`)

- A participant never holds storage credentials: the broker presigns under their share token (`createBrokerAdapter`); the owner registers the storage (`registerShareStorage`) and issues tokens. `PARTICIPANT_REFUSALS` errors are about the share, never retried.
- `packages/relay/src/share/key.ts` is the whole boundary between a participant's object name and the bucket key: a participant reaches `shares/<id>/` only, escapes are rejected (fails closed), every change needs traversal tests (`packages/relay/tests/share/key.test.ts`). Vault GC lists only `objects/`, `pins/` and `history/`.
- A token is live only while its participant's pointer names it (`shareGrantOf` in `packages/relay/src/share/kv.ts`). Revoking cuts the hub first (`dropToken`), then forgets the token, so a failed cut is retried by repeating the revoke. Read-only tokens get `read_only` on `put` and `delete`.
- Signing: URLs live `PRESIGN_TTL_SECONDS` (120 s), the client drops its own after 60 s (`SIGNED_URL_TTL_MS`); batches take 1 to `SIGN_BATCH_MAX` keys, `get` or `put` only, one unsafe key rejects the batch; failures fall back to single signing (`prepareReads` / `prepareWrites` hint keys, separate GET and PUT caches). `saveStorage` writes KV only when the registration changed (free tier: 1k writes a day).
- `createShareRegistration` resends credentials hourly, only after the share compared fine (dead keys never overwrite good ones) and only where an invite went before.

## Tests

- `packages/plugin/tests/features/spaces/` mirrors the slice (`packages/plugin/tests/helpers/space-records.ts` builds records); the broker is `packages/relay/tests/share/`; real flows: `pnpm e2e:shares`, `e2e:invite`, `e2e:guest`.
