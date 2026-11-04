# Sync engine

File sync of the vault and each shared folder (a "space") against object storage. History is called by publish and hunks by operations; keeping one slice avoids cycles.

Constraints: `.claude/rules/sync-integrity.md`, `.claude/rules/history.md`, `.claude/rules/hunks.md`, `.claude/rules/vault-io.md`, `.claude/rules/live.md` (`LiveNotes`).

## Map

| Folder | Holds |
|---|---|
| `changes/` | scan -> diff; `diff.ts`, `moves.ts` |
| `remote/` | manifests, baselines, storage identity, keys; `manifest.ts` |
| `scope/` | policy, scan, ignores and scope settings; `scope.ts`, `scanner.ts` |
| `apply/` | incoming content, moves and conflicts; `pull.ts` |
| `recovery/` | durable writes and state persistence; `journal.ts`, `cut-short.ts` |
| `hunks/` | text projection, patches and diff cache; `projection.ts`, `hunks.ts` |
| `operations/` | actions over one compare; `text-loaders.ts` |
| `automation/` | scheduling and auto-push holds; `scheduler.ts` |
| `identity/` | authors and device identity |
| `runtime/` | controller queue, cycles, diff/history services and maintenance |
| `content/` | remote content formats; `load.ts`, `store.ts` |
| `history/` | records, queries, replay, pins, restore, GC and sweep |
| `ui/` | actions, modals and settings sections |

Entry points: `index.ts` (facade), `controller.ts` (runtime), `engine.ts` (`compare`, `pushPaths`, `publishFileMap`), `state.ts` (persistence), `live-notes.ts` (live port).

## One refresh

1. `RefreshQueue` coalesces requests on `SyncControllerRuntimeState.enqueue`; `runRefreshCycle` runs `refreshNow`, then automation.
2. For each unpaused space, `compare` scans while the head downloads, recovers writes, takes `withLanded`, checks identity/presence, reconciles the head and runs `diffWithin`. Refresh settles resets, frozen and converged paths, then saves state and hash cache once.
3. Automation runs `autoMergeOp` -> `pullPathsOp` -> selected `pushPathsOp`; the first failure ends the cycle.
4. After the operation, `recomputeAfterWrite` patches the comparison without a rescan. `ConcurrentPushError` clears it and refreshes; cancellation reports no remote change.

With autosync off, `automation/scheduler.ts` still requests a startup compare if unlocking needs no prompt.

## Baseline

Baseline = this device's last agreement, per storage identity in `LocalState.storages`; `projectSession` flattens a slot for a space. Disk vs baseline = local change; head vs baseline = remote change; both = conflict unless converged. Advancing converged paths avoids phantom conflicts. `majorityFolders` advances empty folders by majority of baseline, remote and disk.

A push starts from `result.remote` plus its delta, not the local snapshot, preserving files not pulled here.

## Publication guard

Seal before the precheck: gzip inside the race window would widen it. History is recorded only for the guard's winner.

## Content

`engine.ts` decides which files need uploading; `storeContent` which chunks. Deep verify uses `fetchRoot` -> `openContent`. Read failures, chunks included, abort rather than become `ContentError`.

`encryptCompressible` gzips only when smaller, with JSON-style padding; releases since 1.0.0 read both forms. Large files sample the first 64 KB to avoid compressing media needlessly. File blobs: 0x01/0x02; described blobs: 0x03, JSON header then payload.

A drawing's `compressed-json` block is stored decoded: LZString changes wholesale on each edit, defeating sharing between versions. The header retains base64 wrap width and gap; the transform is kept only if it reproduces the original bytes at write time. Without CompressionStream, drawings stay whole.

With `EngineDependencies.chunkIds` (HKDF of the vault keyfile's or share record's data key), files >= `CHUNK_THRESHOLD` (256 KB) use FastCDC: 16/64/256 KB cuts, or 256 KB/1/4 MB past 16 MB. HMAC names hide plain chunk hashes. A recipe is a described blob with empty payload and `chunks: [id, size][]`; chunks are 0x01/0x02 blobs of the stored form, including decoded drawings.

`prepareContent` caches batch recipes and hints roots/chunks together: hints replace previous hints. `writeIncoming` offers the disk copy to `loadContent` only if no bigger than remote or below `LARGE_FILE_BYTES`, keeping large-file work out of small transfers. Cuts use remote sizes to reuse chunks. Copy, downloads and joined file coexist, about three times the file in memory.

## Writes and the journal

Flow: durable claim -> stage whole content under the plugin folder -> write -> release. `restoreCutShort` runs at load; `finishCutShort` after each scan repairs prefixes or missing files in surviving folders. Pending recovery triggers an immediate startup refresh. A landed write still supplies its room's merge base, checked by bytes if the scan omitted it; unreadable files or open rooms defer recovery.

`BaseStep` -> `withLanded` lets the diff see a finished download as agreed, not a local edit; `acknowledge` / `settleLanded` retires it after baseline persistence. Live meets this flow through `coldSince`, `writeIncoming` and `LiveNotes.holds`.

## Spaces and moves

A `Space` has its own storage and key. `spacesOf` lists the vault first, then open records with free roots. Remote paths are relative to the space root so participants mounted at different folders agree. `pairMoves` never pairs an empty hash.

## Hunks

An index has meaning only within its two texts: "apply hunk 3" on another pair hits another region. Flow: shared side loader -> view hashes -> operation hash check -> patch in the same order. Gutter marks use those patch segments because blank lines make independent diffs ambiguous. History restore selects version-to-current hunks by inversion, not a reverse diff; size gates keep large videos out before reads.

## History

Each push writes an encrypted record before it publishes the manifest: the diff from its parent (`added`, `modified {from, to}`, `deleted`). Both sides allow file restore without replay; the HEAD walk stops at gaps. Pins hold manifests and outlive records. Configuration has no versions: retaining every plugin bundle for the horizon would be costly; `released` hashes are cleanup metadata.

GC packs aged records: every push for the last hour, then 10-minute, hourly, daily and weekly periods, then activity counts beyond **Keep history for**. The pure model lives in `history/model/`. Versions named only by removed 1.x history remain until deep clean.

Windows: blobs younger than `SETTLED_AFTER_MS` (24 h) are never swept; GC waits a day after freeing hashes, leaving versions one to two days. Deep clean deletes nothing written in the last day.

## Other flows

- Reset removes the vault storage's manifest, history, objects and pins and clears the baseline; adopt targets a remote vault whose id changed (`operations/flows.ts`).
- Verify checks reachable roots and recipe chunks against one chunk listing; deep verify rebuilds and hashes content.
- Saved-file refresh patches only the displayed compare after an editor save; nothing persists, the next refresh reconciles (`runtime/saved-refresh.ts`).
- Passphrase rotation re-wraps a constant data key; `remote/passphrase-manager.ts` caches keys per epoch.
- Plugin level defaults to Settings so code stays as each device installed it. Per-plugin selection also lists remote-only plugins, using names from local manifests. Obsidian 1.14.5 watches only enabled plugins' settings; the sync never reloads plugins itself.

## Accepted limits

- Publication guard: a backend hiding our write past retries (e.g. cached WebDAV) leaves it unconfirmed: peers are not pinged, a partial push shows an auto-merged conflict, that snapshot gets no history record.
- Open: uploads still have a narrow probe-to-publish race with another device's reset, or clock skew over 12 h.
- Journal: non-prefix garbage reads as an edit.
- Journal: a later edit leaving a staged-copy prefix, or deleting the file, is undone.
- Journal: a cut-short new pull that is no room snapshot stays a conflict with no baseline step.
- Journal: a file a pull moves here and edits there likewise stays a conflict with no step.
- Journal: switching storage drops its step.
- Journal: a write landed in a run that died, then edited before the next compare, loses its step.
- Journal: first-sync downloads have no baseline step; a note deleted elsewhere before completion comes back.
- Folders: a file created between the empty listing and removal goes too.
- Moves: a destination edited while its source downloads keeps both files.
- Recasing: failed rename-back strands the step name reported in the error; a push may publish it.
- Moves: an open room waits as joining, holding the move until refresh or rename-back.
- Hash cache: equal-size/mtime files swapped mid-operation keep each other's hashes until edited; persistence saves the scan's cache.
- Names: a remote rename to a disk-refused name reads as deletion of its source.
- History: re-upload between listing and delete is lost (Drive has no conditional delete).
- History: another device pushing a re-uploaded old hash has only the stated age windows.
- History: cold reads decode every listed record; without GC, every push is read.
- History: a push stalled between its guard's precheck and its put while another push and its GC complete (the guard race) may find its parent merged away, so its history starts at a gap.
- History: a push outlasting the 10-minute GC interval can queue a second, empty run.
- History: the shortest device-local retention horizon thins history for everyone.
- History: a 1.x push stalled across first v3 publication can land a v2 HEAD and rewrite the old log until the next v3 push deletes it again.
- History: packed push counts include config-only pushes; the activity calendar excludes them.
- History: a restored file in a share closed elsewhere returns to the vault without its hold; auto-push may publish it there.
- Plugin levels: a missing plugin gets only its settings file until installed by hand; the installer keeps that file.
- Plugin levels: different plugin versions trade one settings file.
- Plugin levels: removing a plugin where Code is covered removes settings everywhere; devices below Code keep the plugin with defaults.
- Plugin levels: **Keep both** refuses a settings-file copy outside scope; `keepBothConflictOp` refuses any copy scope would not publish.
- Plugin levels: **Clear on remote** clears all parts regardless of level; devices covering them upload again.
- Plugin levels: an enabled but locally missing plugin stays in the synced enabled list; Obsidian reads/writes the list whole.
- Restart notice: a pull failing after landing code shows no notice for it, as with marks of others' edits.

## Tests

`packages/plugin/tests/features/sync/` mirrors the folders; `chaos.test.ts` runs seeded edits and killed writes across three devices. Harness: `.claude/rules/testing.md`.
