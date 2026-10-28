# Sync engine

File sync of the vault and of each shared folder (a "space") against object storage. One slice, kept whole: history is called by publish and hunks by operations, so splitting them out would create cycles; the sub-areas carry the navigation. Constraints live in `.claude/rules/sync-integrity.md`, `.claude/rules/hunks.md`, `.claude/rules/history.md`, `.claude/rules/vault-io.md`; this file holds the map, the flows and the reasons behind them.

## Map

| Folder | Holds |
|---|---|
| `changes/` | scan -> diff: `features/sync/changes/diff.ts` (local, remote, conflict, converged), `features/sync/changes/moves.ts` (`pairMoves`), `features/sync/changes/content.ts` (load and write content), `features/sync/changes/remote-names.ts`, `features/sync/changes/binary-extensions.ts` |
| `remote/` | the remote side: `features/sync/remote/manifest.ts` (fetch, build, guarded publish), `features/sync/remote/baseline.ts`, `features/sync/remote/space.ts`, `features/sync/remote/space-paths.ts`, `features/sync/remote/foreign.ts`, `features/sync/remote/config-reset.ts`, `features/sync/remote/uploads.ts`, `features/sync/remote/reset.ts`, `features/sync/remote/keyfile.ts`, `features/sync/remote/passphrase-manager.ts` |
| `scope/` | what syncs: `features/sync/scope/scope.ts` (policy), `features/sync/scope/scanner.ts`, ignore matcher, rules and state, the scope and exclusions settings sections |
| `apply/` | landing remote content: `features/sync/apply/pull.ts`, `features/sync/apply/pull-moves.ts`, `features/sync/apply/auto-merge.ts`, `features/sync/apply/conflict-merge.ts`, `features/sync/apply/conflict-copy.ts` |
| `recovery/` | `features/sync/recovery/journal.ts`, `features/sync/recovery/cut-short.ts`, `features/sync/recovery/state-persister.ts` |
| `hunks/` | `features/sync/hunks/hunks.ts`, `features/sync/hunks/projection.ts`, `features/sync/hunks/diff-cache.ts`, `features/sync/hunks/merge-model.ts`, `features/sync/hunks/anchored-hunks.ts` |
| `operations/` | what a person or the auto cycle runs over one compare: push, pull, revert, resolve, hunks, config reset, flows, `features/sync/operations/text-loaders.ts` |
| `automation/` | `features/sync/automation/scheduler.ts` (timer, backoff), `features/sync/automation/auto-push.ts` (bulk-deletion hold) |
| `identity/` | `features/sync/identity/authors.ts`, `features/sync/identity/device.ts`, `features/sync/identity/device-name.ts` |
| `runtime/` | what `features/sync/controller.ts` is built from: `features/sync/runtime/operation-runner.ts`, `features/sync/runtime/refresh-queue.ts`, `features/sync/runtime/auto-cycle.ts`, `features/sync/runtime/scan-cycle.ts`, `features/sync/runtime/controller-state.ts`, `features/sync/runtime/file-diff-service.ts`, `features/sync/runtime/history-service.ts`, `features/sync/runtime/maintenance.ts`, `features/sync/runtime/saved-refresh.ts`, `features/sync/runtime/merged-result.ts` |
| `history/` | push records, queries, replay, pins, vault restore plan, GC and sweep |
| `ui/` | menu items, modals, the maintenance section |

Top level: `features/sync/engine.ts` (`compare`, `pushPaths`, `publishFileMap`), `features/sync/session-state.ts`, `features/sync/state.ts` (the state file), `features/sync/types.ts`, `features/sync/constants.ts` (remote layout, size limits), `features/sync/live-notes.ts` (the seam to live editing: the file sync never imports `features/live`), `features/sync/index.ts` (facade).

## One refresh

1. `RefreshQueue` coalesces requests into one cycle on the single operation chain (`SyncControllerRuntimeState.enqueue`); `runRefreshCycle` (`features/sync/runtime/auto-cycle.ts`) runs `refreshNow`, then the automatic steps.
2. A full `refreshNow` asks `host.spaces()` once (records traded with the vault storage, moves followed) and keeps that partition for the cycle; a targeted share refresh reuses the previous one. For each unpaused space it opens a session (`app/session-factory.ts`, scope built from that partition alone) and runs `compare`.
3. `compare`: scan the disk while the remote head downloads, `finishCutShort`, take the baseline `withLanded`, check the vault id and `assertSpacePresent`, reconcile the head against the baseline, mark unholdable names skipped, then `diffWithin`. A refresh then forgets reset categories and dropped frozen entries from the baseline, advances it for `converged` paths (both sides reached equal content: no phantom conflict), and saves state and hash cache once.
4. Automatic steps, per space: conflicts go to `autoMergeOp`, remote changes to `pullPathsOp`, local changes chosen by the auto-push selector to `pushPathsOp`. The first failing step ends the cycle.
5. `runOperationNow` re-checks that the space is still mounted, reuses the refresh's comparison only for the same scope epoch and local revision (else compares again), runs the operation, then patches the result from what it wrote (`recomputeAfterWrite`) instead of rescanning. `ConcurrentPushError` clears the result and refreshes; a cancel says nothing on the remote changed; the journal is saved as every operation ends.
6. `invalidate` bumps the epoch: results begun before it are dropped, so a stale partition or scope never settles state auto-push could act on.

## Baseline

The baseline is the manifest this device last agreed with, per storage identity slot of the state file (`features/sync/state.ts`) (`LocalState.storages`; `projectSession` flattens one slot for one space and re-roots it after a share move). Local change = disk differs from baseline; remote change = head differs from baseline; both = conflict, unless equal (converged).

It moves only through `advanceBaselineForPaths`: converged paths at refresh, `written` after a pull, the published delta after a push, one path for a hunk operation. Adopting a whole manifest would claim files this device never downloaded; the next push would publish them as deletions. Empty folders advance by majority of baseline, remote and disk (`majorityFolders`): a folder on one side only is not agreed yet.

A push publishes the remote's file map (`result.remote`) plus this push's changes, never the local snapshot: files the device has not pulled stay. Authorship (`attribute`) is stamped there and only there.

## Publication guard

`publishManifestWithGuard`: seal first (gzip after the precheck would widen the race window), precheck the head equals the expected parent, `put`, then read back. A head this push replaced is a stale read or a lost push, so it re-reads (`VERIFY_DELAYS_MS`); only our own snapshot id proves it landed. Taking the replaced head as stale would let a sibling's overwrite turn our files into remote deletions. History is recorded only for the guard's winner.

Accepted limit: a backend hiding our own write past the retries (WebDAV behind a cache) leaves a landed push unconfirmed: peers are not pinged, a partial push shows an auto-merged conflict, that snapshot gets no history record.

Uploads: the head vouches for a blob; this device's own unpublished uploads count for 12 h (`UPLOAD_TRUST_MS`, still probed). Anything else may be swept by GC or deep clean between probe and publish. Still open, narrow: another device's reset between the probe and the publish, clock skew over 12 h.

A blob is gzipped when that makes it smaller (`encryptCompressible` in `core/crypto/cipher.ts`, padded like the JSON documents), else sealed as is; every release since 1.0.0 reads both. A large file is judged by its first 64 KB, so media is not compressed whole for nothing.

## Writes and the journal

Obsidian truncates before it writes (mobile drops a file whose append fails), so a killed write leaves a prefix. `features/sync/recovery/journal.ts` makes every engine content write recoverable: a durable claim, the whole content staged under the plugin folder, the write, release. Recovery (`features/sync/recovery/cut-short.ts`) runs at load (`restoreCutShort`) and in every `compare` right after the scan: a prefix of the staged copy, or a missing file in a folder that stays, is rewritten; one that landed still gives its room its merge base (judged by its bytes when the scan left it out); what cannot be finished yet (unreadable, open room) leaves the diff as unreadable. A start with one pending refreshes at once (`main.ts`).

A finished download gives the baseline its entry (`BaseStep`, taken only by the storage and vault it was claimed under, only while the baseline still holds what it held then); `withLanded` applies it in the diff, because on the old baseline the write would read as this device's edit. Landed writes stay in the journal until the baseline holding their step is saved (`acknowledge`, else `settleLanded`).

Live editing meets this in `features/sync/live-notes.ts` (`coldSince`, `writeIncoming`, `LiveNotes.holds`); its rules are in the live rule: a room never opens on a note under an engine write, the engine never writes a note whose room is open.

Accepted limits: garbage that is no prefix reads as an edit; an edit since that leaves a prefix of the staged copy, or deletes the file, is undone; a pulled new file that is no room snapshot, cut short, stays a conflict and gives no step; so does a file a pull moves here and edits there; a step of a storage switched away from is dropped; a write landed in a run the app died in, edited before the next compare, loses its step; a first sync's download has none (no baseline yet), so a note deleted elsewhere before it finished comes back.

## Spaces

A `Space` is the vault or a shared folder with its own storage and key. The partition (`spacesOf`, built by `features/spaces/records.ts`) lists the vault first, then each open record whose root is free. Scopes own a root's subtree minus nested roots. The vault treats share roots like a local ignore: entries there are frozen in its manifest (so a share opened or closed never reads as a deletion), dropped from the next vault push, and swept from storage by history GC once no history record names them. A frozen entry the baseline forgot but whose share has no baseline yet is kept in `shareBases`, the merge base of a note that just became a share.

Remote blobs hold paths relative to the space root (`features/sync/remote/space-paths.ts`), so participants mounting at different folders agree; locally everything is vault paths. A move of a share root edits the record; every device moves its folder before the next partition (`features/spaces/share-moves.ts`).

Failure modes the rules guard: a share whose scan lost every file (`SpaceGoneError`) is the device's error, settled by the person; closing is a tombstone, never file deletion; pausing keeps the folder out of the vault.

## Moves, folders and names

`pairMoves` pairs a gone path with a new one of the same baseline hash in one space, else by file name where one to one; the empty hash pairs nothing. A pull renames locally (`features/sync/apply/pull-moves.ts`), so a local edit goes with the file. Recasing on a case-blind disk steps through a free name (`renameCaseSafe`).

A folder is removed only after a listing shows it empty. Accepted limits: a file created between the listing and the removal goes too; a destination edited while its source downloads keeps both files; a recasing whose rename back fails stays under its step name, said in the error, and a push may publish it so; an open live room waits as joining, holding the move back, until the next refresh or the rename back; two files of equal size and mtime swapped while an operation runs keep each other's hashes until one is edited (the persister saves the cache its scan saw); a remote rename into a name this disk refuses reads here as the deletion of its source.

## Hunks

A hunk index means nothing without its two texts. The diff view, the gutter marks and the operation must agree on the pair, the order and the baseline, or "apply hunk 3" hits another region. So the operation loads sides from one function, hashes them against what the view drew, and the editor's marks are built from the same segments push and revert move (blank lines make diffs ambiguous). History restore numbers hunks version-to-current, so it inverts the selection instead of recomputing the other way. Size gates run before any read so a large video never loads into a diff.

## History

Every push writes one encrypted record, `history/p/<id>.enc`, before it publishes: the diff from that snapshot's parent (`added`, `modified {from, to}`, `deleted`). Both sides are stored so one version restores without replaying, and a record that never landed shows as a parent/child gap the walk from HEAD stops at (`coverOf`). A failed record write is retried before the next push. Readers list `history/` once and keep what they decoded in memory (`features/sync/history/remote.ts`); every query walks from HEAD (`features/sync/history/query.ts`). Pins are their own objects under `pins/` holding a full manifest, so they outlive the records. GC (`features/sync/history/gc.ts`) runs after a push this device published, at most every 10 minutes per space: it packs aged records into one object per period (every push for the last hour, then per 10 minutes, hour, day and week, then activity counts past the horizon, **Keep history for**), planned by the pure model in `features/sync/history/model/`, and sweeps the file versions they stopped naming one to two days later (the sweep lists every blob, so it runs about once a day). The activity those reads see is kept on the device (`features/sync/history/activity-cache.ts`) for the settings overview, which never reads history itself.

Every manifest carries `MANIFEST_VERSION` 3, so a 1.x client refuses the remote from the first new push and never runs its GC or deep clean over this layout. 1.x history is not imported: the first push of a session deletes `history.json.enc` and the bare-manifest pins (`features/sync/history/legacy.ts`); the versions only they named stay until a deep clean, which refuses to run until a v3 HEAD fences the old clients out.

Windows: a blob younger than `SETTLED_AFTER_MS` (24 h) is never swept, GC sweeps what it freed only a day after freeing it, deep clean deletes nothing written in the last day. Accepted limits: a re-upload landing between the listing and its delete is still lost (Drive has no conditional delete); a push by another device that re-uploaded an old hash is covered only by those windows; a cold read decodes every listed record, and a vault never thinned by GC reads all of its pushes; a push stalled between its guard's precheck and its put while another push and its GC complete (the guard race, where that other push's files already leave HEAD) may find its parent merged away, so its history starts at a gap; a push that outlasts the 10-minute GC interval can queue a second, empty run behind the first; the horizon is a device setting, so the device with the shortest one thins history for all; a 1.x client stalled mid-push across the first v3 publish can land one v2 HEAD and rewrite the old log, until the next push publishes v3 and deletes it again.

## Other flows

- Reset and adopt (`features/sync/operations/flows.ts`): reset deletes the vault storage's manifest, history, objects and pins and clears the baseline; adopt re-aims this device at a remote vault whose id changed. Category resets (`features/sync/operations/config-reset.ts`) bump a generation in the manifest.
- Maintenance (`features/sync/runtime/maintenance.ts`): verify checks every reachable object exists (`deep` also hashes it); deep clean removes unreachable settled objects.
- Saved-file refresh (`features/sync/runtime/saved-refresh.ts`): display only, patches the last compare after an editor save; nothing persists, the next refresh reconciles.
- Credentials: `features/sync/remote/keyfile.ts` wraps one constant data key under the passphrase (rotation re-wraps only); `features/sync/remote/passphrase-manager.ts` caches keys per epoch.

## Tests

`packages/plugin/tests/features/sync/` mirrors the folders. Two devices share one `FakeStorage` through `pairedSessions` (`packages/plugin/tests/helpers/session.ts`); faults come from `packages/plugin/tests/helpers/faults.ts`; `packages/plugin/tests/features/sync/chaos.test.ts` runs seeded rounds of edits and killed writes across three devices.
