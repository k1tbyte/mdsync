---
paths:
  - 'packages/plugin/src/features/sync/history/**'
  - 'packages/plugin/src/features/source-control/history/**'
  - 'packages/plugin/src/features/source-control/timeline/**'
  - 'packages/plugin/src/features/source-control/trash/**'
  - 'packages/plugin/src/features/diff/ui/restore-modal.ts'
  - 'packages/plugin/src/features/sync/runtime/maintenance*.ts'
---

# File history, restore and GC

History is a change log, not an archive. Model, publish order, windows and accepted limits: `features/sync/README.md` (History). Engine invariants: `.claude/rules/sync-integrity.md`; hunk restore: `.claude/rules/hunks.md`.

## Change log

- `history.json.enc` holds one record per push: the diff from that snapshot's parent, which is `compareResult.remote`, not `state.baseline` (they differ whenever another device pushed since the last compare). `publishManifestWithHistory` passes the remote as `parent`.
- A record carries both sides (`modified.from` / `.to`, the departed entry on `deleted`) and compares every field (`sameEntry`), so a restore never needs a replay and a lost update leaves a detectable gap, not a corrupted chain.
- A merged record (`composeChanges`, history rework model in `features/sync/history/model/`) runs from its first parent to its last push: `deleted` keeps the parent's entry for replay, `deletedLast` the content right before the deletion, and `changeEntries` names both. Merge only chain-contiguous runs.
- Walk the chain only while `entry.parentId === next.id` (`contiguousLength`), starting at HEAD (`walkableChain`); past a gap the log is not evidence of anything. Order by log position, never `createdAt` (clock skew).
- History is best-effort: a failed log update warns and never fails the push, and GC runs only for the guard's winner. A log that is there but unreadable, malformed or newer is an error, never read as empty (a fresh log would overwrite the real one and orphan its blobs): `readHistoryLog` asks twice before returning empty.
- Log writes go through `updateHistoryLog` (read, mutate, write, read back, redo once if the change did not survive): the manifest guard does not serialize them. Callers act on what it returns.
- Queue anything that rewrites the log on the operation queue (`setSnapshotPinned` does): a push or GC of this device rewrites it too.

## Listings

- `listDeletedFiles` walks deletions, never absences: `changes[snapshot].deleted` newest first, first hit per path, so a file deleted, recreated and deleted again reports its latest death; anything back in HEAD is skipped.
- Pinned snapshots outside the walked chain are diffed against HEAD separately; those rows are `source: "pinned"` and say "last seen", never "deleted": a pin proves the file existed, not when it went. A pin clears the eviction `rank` only of the hash it holds.
- A log that lags HEAD sets `lagging` (and a gap `truncated`); the UI warns instead of showing an empty vault as an empty trash (`features/source-control/trash/trash-tab.ts`, `features/source-control/timeline/timeline-tab.ts`). The Trash tab and `listDeletedFiles` skip paths the scope no longer includes.
- A snapshot is `restorable` only when replay reaches it from HEAD (`replayTo`) or it is pinned. `replayTo` returns null on any gap: a partial replay would invent a state.

## Restore

- A restore that puts the vault back is local only: nothing reaches the remote until the person pushes. `planVaultRestore` (`features/sync/history/restore-vault.ts`) is pure, and the confirmation and the operation both run it; the operation re-plans after the confirmation and applies nothing if the plan differs (`sameRestorePlan`).
- It removes only paths the scan actually read (an unreadable directory is unknown, not absent), sends removed files to the trash (`trashPath`), and never touches an ignored, out-of-scope or disk-refused path in either direction.
- Its writes run under a journal claim like a pull's (`restoreVault` in `features/sync/runtime/history-service.ts`) and its target manifest keeps only paths the space owns (`ownedFiles`).
- Restore dialogs promise "nothing is pushed until you say so" (`features/diff/ui/restore-modal.ts`); keep that true.

## Pins

- Write the pin manifest under `pins/` before setting the flag (`setSnapshotPinned`): a flag without its manifest makes GC believe objects are protected that nothing references. A pin whose manifest cannot be read is replaced, never trusted.
- Unpinning removes the flag first; a leftover manifest is inert (GC reads only flagged pins; deep clean removes it). No rollback on failure.
- A pin keeps its own full manifest so it outlives the chain once the snapshots between HEAD and the pin are evicted.

## GC and deep clean

- Never delete an object reachable from HEAD, from a retained change record (every version it names: `changeEntries`), or from a pinned snapshot's manifest. If any of those cannot be read, delete no objects at all (`skippedObjectSweep` in `collectGarbage`; deep clean and verify throw): a bounded blob leak is acceptable, a dangling reference is not.
- Sweep only blobs older than any push in flight: `settledKeys` / `keysByAge` list them by age, `SETTLED_AFTER_MS` is twice `UPLOAD_TRUST_MS`. Another device may have re-uploaded an old hash for a push it has not published. A storage that cannot report object ages cannot be swept (`listDetailed` is required).
- Evict a record only when it is past the limit, unpinned and at least `SETTLED_AFTER_MS` old (`evictable`); a record naming a blob still settling stays, or nothing would name that blob again. GC fires only past `gcExcessBuffer` (amortized).
- Order in `collectGarbage`: list ages, prune the log, re-read HEAD late, then sweep. Prune before sweeping: a crash between leaves orphan blobs deep clean collects, never log versions whose content is gone. An unreadable or moved HEAD, an unreadable kept record, or a snapshot pinned meanwhile (`pinnedAmong` checks storage, not just the log) withholds the sweep.
- Deep clean (`deepCleanOrphans` in `features/sync/runtime/maintenance.ts`) needs a published HEAD and a complete live set, deletes nothing written in the last day, and bails if HEAD or the pinned set changed while it listed (a pin does not move HEAD).
- GC, verify and deep clean list only `objects/` and `pins/` of their own space.
