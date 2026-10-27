# History rework (design)

Status: v2 after architecture review, 2026-10-27, base `93a93bf`. Force-added on this branch; remove before merge.
Scope: History, Timeline and Deleted tabs, a new activity calendar, the remote history format, history GC,
and blob storage efficiency (compression, content-defined chunking). Current model and invariants:
`packages/plugin/src/features/sync/README.md` (History), `.claude/rules/history.md`, `.claude/rules/sync-integrity.md`.
Review findings and how v2 answers them: section 15.

## 1. Problem

A user issue (paraphrased): every instant save is a snapshot (quiet period 5 s, **Versions to keep** 50), so
history holds under an hour during heavy editing and about half a day with periodic sync only. "Versions"
reads as per file, but snapshots are per vault: a file edited all day yesterday can have zero versions
today. Tiny pushes clutter Timeline and make a change hard to find.

What the code does today:

| Area | Today | Cost |
|---|---|---|
| Retention | last N pushes (`fileHistoryMaxSnapshots`, default 50), GC when excess > max(30%, 10), records younger than 24 h never evicted (`gc.ts` `evictable`) | TTL depends on push rate; under autosync the 24 h floor silently overrides N |
| Log | one object `history.json.enc`, read-modify-write per push (`updateHistoryLog`): GET (conditional) + PUT whole log + GET whole log (the write drops the validator, so the verify is a full download), redo once on a lost update | 3 storage calls (5 with redo), ~2-3x log size per push; on Drive ~5-7 HTTP requests; awaited on the push path (`publish.ts:24-57`) |
| GC | runs after the push that crosses the excess; under 5 s pushes it can run every ~80 s once records are older than 24 h; a sweep lists all of `objects/` (`keysByAge`) | 20 LISTs per sweep for 20k objects on S3/Drive, one unpaginated PROPFIND on WebDAV |
| Pins | flag + label in the log, full manifest in `pins/<id>.json.enc` | pin = replay + log update + verify |
| Blobs | `objects/<sha256>` = whole file, AES-GCM, **not compressed** (`encryptBytes`, `engine.ts:212`); gzip only for JSON docs >= 16 KB | every version is a full copy |

## 2. Decisions taken

- Retention by time tiers, default horizon **3 months**.
- A file created and deleted inside one merged window may vanish from history (accepted).
- Merged deletions keep the last content before the deletion (`deleted.last`).
- Content-defined chunking (CDC), not git-style delta packs.
- The log is redesigned in the same rework; all perf work lands in one pass.
- Activity calendar (GitHub-style); a click opens Timeline at that date.
- History moves ahead of Big files in the roadmap; CDC is shared groundwork for both.
- Not doing: Obsidian File recovery integration (per device, local, no public API).
- D1: hard format fence, 1.x devices stop syncing until updated (section 11).
- D2: the first day thins too: every push for 1 h, then one per 10 min (section 4).

## 3. Goals and non-goals

1. A push costs O(size of its change) in history: no read, no rewrite of anything shared.
2. No lost-update gaps between devices pushing concurrently.
3. Retention a person can predict per file.
4. Reads are incremental: after the first open, only new objects are fetched; Timeline loads by visible range.
5. GC is off the push path, at most hourly, and never lists more than it must.
6. Storage: compress what compresses; versions of large files share unchanged chunks.
7. No race may delete a blob that HEAD, a retained record, `deleted.last` or a pin names (fail closed).

Non-goals: git delta packs, per-file retention settings, server-side logic, locks.

## 4. Retention model

| Age | Kept |
|---|---|
| < 1 h | every push |
| 1-24 h | last push of each 10 min |
| 1-7 d | last push of each hour |
| 7-30 d | last push of each day |
| 30 d - horizon | last push of each week |
| > horizon | activity counts only (section 8) |

Horizon setting **Keep history for**: 1 week, 1 month, 3 months (default), 1 year, forever.
v1 kept every push for 24 h because a thinned record's blobs may still be settling; the two-phase sweep
(section 7) removes that constraint, so the first day can thin too. Worst case is now bounded: about
720 records in the last hour (5 s pushes), 144 + 168 + 23 + 9 after that, about 1100 in all.

**Time authority.** Never the device clock (skew), never derived from children (would move compacted buckets).
- `at(r)`: the storage's write time of `history/p/<id>`, from `listDetailed().modified` (S3 Last-Modified,
  WebDAV getlastmodified, Drive modifiedTime; MDSync never sets them, so it is the server's clock).
- Captured once when GC first packs the record, stored with it, never recomputed. An undated listing entry
  counts as the newest time listed (kept longer, the safe direction).
- No clamp along the chain: a period takes the records whose `at` falls in it, and merges only chain-contiguous
  runs inside it, so a rare straggler stays a record of its own instead of moving a period.
- GC's "now" is the newest `modified` in its listing (its own push record, just written).
- Device `createdAt` stays for display.

**Ladder.** Every history object holds one resolution over one group period; groups nest
(10-min slot < UTC hour < UTC day < ISO week < 4 ISO weeks), so an object is built from finer objects inside its group.

| Resolution | Keeps per | Group (one object) | Built when |
|---|---|---|---|
| push | every push | 10-min slot | group end + 10 min <= now |
| 10m | 10 min | UTC hour | group end + 1 h <= now |
| 1h | hour | UTC day | group end + 24 h <= now |
| 1d | day | ISO week | group end + 7 d <= now |
| 1w | ISO week | 4 ISO weeks | group end + 30 d <= now |
| counts | activity only | 4 ISO weeks | group end + horizon <= now |

A tier applies once its whole group has aged past it, so a record stays finer up to one group longer than the
table above says: the promise is "at least". About 45 objects over 3 months, plus the pushes of the last ~20 min.

**Merge (thinning).** Records are diffs from their parent, so a contiguous run r1..rk merges into one record
with `parent = r1.parent`, `id = rk.id`. Per path, folding left (`sameEntry` decides "unchanged"):

| earlier | later | merged |
|---|---|---|
| added(x) | modified(x -> y) | added(y) |
| added(x) | deleted | none (accepted loss) |
| modified(a -> b) | modified(b -> c) | modified(a -> c), none if a = c |
| modified(a -> b) | deleted(b) | deleted(from a, last b) |
| deleted(a, last l) | added(y) | modified(a -> y), none if a = y |
| none | any | the later change |

`deleted.from` stays the parent's entry (`replayTo` and `undoChanges` need it); `deleted.last` only serves
Deleted and restore. Undoing a merged record from `rk` yields exactly `r1.parent`, so replay still reaches
every retained id; merged-away ids are simply no longer listed. Merges never span a gap. Pins do not
constrain merges: a pin carries its own full manifest.

## 5. Remote layout

```
history/p/<snapshotId>.enc                          push record, written once by the pushing device
history/b/<res>-<groupStart>-<digest>.enc           object: one resolution over one group, written by GC
history/g/<runId>.enc                               sweep candidates waiting for phase 2 (section 7)
pins/<snapshotId>.json.enc                          pin: { manifest, label, pinnedAt }
history.json.enc                                    legacy v2 log; a v3 stub after migration (section 11)
objects/<sha256>                                    file content, or a recipe (section 9)
objects/c/<chunkId>                                 chunk
```

```ts
interface PushRecord {
	v: 1; vaultId: string;               // a reset generation is a different vaultId
	id: string; parentId: string | null;
	createdAt: number; deviceId: string; deviceName?: string;
	changes: SnapshotChanges;            // + deletedLast: content right before a merged deletion
}
interface StoredRecord {                 // a push or a merged run of pushes
	id: string; parentId: string | null; // last push's id, first push's parent
	createdAt: number; deviceId: string; deviceName?: string;   // last push
	changes: SnapshotChanges;
	at: number; firstAt: number; pushes: number;
	activity: Activity;
}
interface HistoryObject {
	v: 1; vaultId: string;
	res: "push" | "10m" | "1h" | "1d" | "1w" | "counts";
	group: number;                       // group start, server time
	records: StoredRecord[];             // chain order, oldest first; empty for counts
	activity?: Activity;                 // counts only
	consumed: string[];                  // keys this object replaces
}
/** Sparse: UTC hours since epoch -> [pushes, paths changed]. */
type Activity = Record<number, [number, number]>;
```

- An object's key carries its resolution, group and a `digest` of its records (SHA-256, first 16 hex; not of
  `consumed`). Two contents of one group never share a key; two devices building the same content write the
  same key, and a Drive duplicate of it is the same content. No reliance on `putIfAbsent` (B2 rejects
  `If-None-Match`, Drive has none): plain `put`, then read back and check the digest.
- Paths inside are space-relative, translated only in `features/sync/remote/space-paths.ts`. Each space has
  its own `history/`.

## 6. Write path (push)

1. Build the record against the guard's expected parent `compareResult.remote` once the manifest is built
   (after uploads, `engine.ts:191-197`).
2. PUT `history/p/<snapshotId>.enc` right before publish: the shorter that gap, the rarer a late record (section 7).
3. Publish through `publishManifestWithGuard`, unchanged.
   - Won: the record is there. Lost-update gaps disappear; an unconfirmed landed push still has its record.
   - Lost (`ConcurrentPushError`): the record is a sibling of a chain record (section 7 proves that before deleting it).
4. Record PUT failed: warn, publish anyway; the chain shows a gap.
5. Nothing else on the push path: GC is scheduled, not awaited.

Cost: 1 PUT the size of the change (an initial or import push is as large as the manifest), plus Drive's
name lookup. Today: 3-5 calls moving 2-3x the whole log.

## 7. Read path and GC

### Read
1. `listDetailed("history/")`, `list("pins/")` (logical calls; S3 and Drive page by 1000).
2. Skip every object a present object names in `consumed`. Walk from HEAD's id back: at each id take an
   object whose last record has that id, coarser first, then more records, then the smaller key; when that
   choice dead-ends and another candidate reaches further back, take the other. GC uses the same pure function.
3. Fetch only what the visible view needs and the cache lacks: Timeline newest first by period; File history
   and Deleted decode block by block and keep only their rows (no whole-history materialisation).
4. Gap or unreadable object: today's `lagging` and `truncated`. A 404 (object retired after the listing):
   one re-list.

Local cache: IndexedDB per vault id, storage identity and root; rebuildable, may be evicted (iOS), never a
source of truth. Holds decoded blocks and records (paths, hashes, sizes: the sensitivity of `state.json`).

### GC
Scheduled after a won push, at most every 10 min per device, with jitter; a run with nothing due costs one
listing. Also from **Maintenance**. Requires `listDetailed`, as today.

Building one object (resolution R, group G), planned pure:
- Only the coarsest due resolution of a group is built; finer due groups inside it are left to it.
- Due: G's age rule holds, G is complete (the chain walk reaches a record older than G's start minus 10 min,
  or the root), and some input is not consumed yet (so a run is idempotent).
- Inputs: present objects at a finer resolution whose group lies inside G, other objects of the same (R, G),
  and push records on the chain with `at` in G. A push record off the chain is never an input.
- Content: the chain's records with `at` in G, merged per R-period over chain-contiguous runs. `consumed` =
  the input keys plus the `consumed` of every input still present.
- Late record: a push record written before publish may join the chain after its slot was built. It is an
  unconsumed input of that slot, so the next run rebuilds the slot with it.

Phase 1, one run:
1. List, read what the plan needs, plan.
2. Write each new object, read it back, check its digest. Candidate hashes come from the verified stored
   object, never from the plan.
3. Delete every key the verified object lists in `consumed`; a later run deletes leftovers it finds named in a
   present object's `consumed`. Readers that listed before re-list once on 404.
4. Write `history/g/<runId>.enc`: hashes the consumed objects named that their replacement does not. Delete no blob.

Phase 2, a later run, for each candidate object at least `SETTLED_AFTER_MS` old:
1. Build the live set fresh: HEAD, every history object of HEAD's `vaultId` (every record of a disconnected
   range included), every pin (listed, each read; an unreadable one fails closed), chunks of live recipes.
2. One `listDetailed("objects/")` for ages. Delete candidates that are absent from the live set and settled.
3. Re-read HEAD late and bail if it moved (as today); then delete the candidate object.

The 24 h between phases lets any pin or record written around phase 1 show up in every listing (Drive search
lag), and any re-upload by an in-flight push refresh the blob's age. This is Duplicacy's fossil collection,
reduced: references come back by being listed, not by renaming. A crash leaves candidates pending; phase 2 is idempotent.

What GC may delete (nothing else):

| Object | Condition |
|---|---|
| history object | named in `consumed` of a present object whose digest checks |
| push record of a lost guard | its parent is on the fully resolved chain, the chain's child of that parent is another id, older than `SETTLED_AFTER_MS` |
| object of another `vaultId` | HEAD's `vaultId` differs (a reset), settled |
| anything in a group past the horizon | consumed by that group's verified `counts` object (only chain records add activity) |
| blob | phase 2 above |

Within the horizon, a gap or a disconnected range never makes anything deletable: past a gap the log is not evidence.

Concurrency:

| Race | Outcome |
|---|---|
| two GCs, same view | same keys and bytes; the second write changes nothing |
| two GCs, different views (listing lag) | different digests for one group; both live; the next run rebuilds the group from both |
| GC vs push | a group is due only 10 min after its end; a late record rebuilds its slot; blobs only in phase 2 |
| GC vs pin | phase 2 lists and reads pins 24 h after the drop |
| reader vs GC | one re-list on 404; readers never delete |
| old client | fenced by the format bump (section 11) |

## 8. Activity calendar

- Every stored record carries `activity`; merges sum it, so thinning never loses counts.
- A group past the horizon becomes a `counts` object (about 13 a year, a few hundred bytes each).
- Only chain records count (a lost guard's record does not).
- UTC hours, folded into local days by each viewer (30/45-minute zones may misplace a push by one hour).

UI, collapsible on top of Timeline: 53 x 7 grid coloured by pushes.
- Tooltip through `aria-label`: "27 Oct: 34 pushes, 12 files"; a phone tap shows it as a notice.
- Click a day: Timeline scrolls to that date and its resolution; past the horizon: "Only counts are kept for this day".
- Each day shows its tier (outline), which also explains thinning.
- Phone: last ~4 months, horizontal scroll, touch targets `--mdsync-touch`.
- No extra request: activity lives in blocks the read path already holds.

## 9. Blob storage efficiency

### 9.1 Compression (independent, can ship first)
Seal file blobs and chunks with `BLOB_VERSION_GZIP` when gzip shrinks them; skip known-compressed kinds
(`features/sync/changes/binary-extensions.ts`). Readable since 1.0.0 (`b451cb7`). Every content read already
decrypts through `decryptBytes` via `changes/content.ts`; deep verify calls it directly (`maintenance.ts:103-109`).
`CompressionStream` exists on iOS 16.4+ and Android WebView 80+; feature-detect and upload uncompressed
without it. Tip for README: Excalidraw's **Compress Excalidraw JSON in Markdown** is on by default and
defeats both gzip and CDC; turning it off makes drawings cheap to keep.

### 9.2 Content-defined chunking
- Files above 256 KB are split with FastCDC: min 16 / avg 64 / max 256 KB up to 16 MB, then avg 1 MB
  (a 100 MB file would otherwise need ~1600 objects). Below the threshold: one object, as today.
- No maintained browser FastCDC library exists; the algorithm is ~100 lines, written in `core/`.
- `objects/<fileHash>` becomes a **recipe**: new blob version `BLOB_VERSION_RECIPE`, body `[chunkId, size][]`,
  gzip-sealed. Manifests, diffs, `sameEntry` and history keep naming the file hash.
- Chunk ids are `HMAC(key, chunk)` and the gear table is seeded from the key. This hides known content but does
  not fully hide boundaries (keyed CDC fingerprinting, eprint 2025/558): an accepted limit, softened by gzip
  padding.
- **One owner for content** (`features/sync/content/`): read a file hash to bytes (recipe or plain), write bytes
  to a hash, expand a hash to its storage keys. Used by `changes/content.ts`, deep verify, history GC and deep
  clean. Unreadable recipe: destructive maintenance fails closed.
- Upload skips a chunk only when HEAD's recipes name it or this device uploaded it for an unpublished push
  (`uploads.ts` trust, probed): the rule "only the head vouches for a blob" extends to chunks. The recipe cache
  only saves decoding.
- Reads stream chunks into the journal's staged write (Big files groundwork); `prepareReads` batches signing.
- Excalidraw codec: a drawing saved as `compressed-json` changes its whole LZString stream on every edit, so neither
  gzip nor CDC helps. The content owner stores such a file as its markdown around the block, the wrap width and the
  decoded scene JSON (`readDrawing` in `core/drawing/format.ts`, lz-string is already bundled), and rebuilds the
  bytes on read. Kept only when re-encoding reproduces the file byte for byte at write time, else stored as is; the
  read path's SHA-256 check stays the last guard. With CDC an edit costs 1-2 chunks of JSON, and embedded images
  in the scene become shared chunks.

Expected effect (to be measured, 9.3):

| Files | Effect |
|---|---|
| notes 1-20 KB | none from CDC; gzip 3-5x |
| text/JSON 100 KB - few MB (long notes, canvas, uncompressed Excalidraw) | a version costs 1-2 chunks: ~15x for 2 MB, plus gzip |
| append-style (PDF incremental save, logs, CSV) | unchanged prefix shared |
| compressed formats (Excalidraw `compressed-json`, docx, images) | none |
| video, large binaries | no history gain; parts, resume, dedup of copies |

### 9.3 Measurement before choosing parameters
A local script over a real remote: for every `modified {from, to}` pair, fetch both versions, report bytes
today, with gzip, with CDC + gzip for 3 parameter sets; plus pushes per day and log size.

## 10. UI and settings

- **Timeline**: consecutive pushes of one device with gaps < 10 min form a session row
  ("Laptop · 10:02-10:31 · 24 saves · 3 files"), expandable; older tiers under headers; filter by path or folder.
- **History** (file): the same grouping; versions labelled by resolution.
- **Deleted**: "kept until <date>" replaces "survives N more pushes"; `rank` leaves `DeletedFile`.
- **Settings**: "File version history" -> "History"; "Versions to keep" -> "Keep history for" with one line on
  the promise. `fileHistoryMaxSnapshots` (transfer key `j`) joins `RETIRED_KEYS`; the horizon gets a transfer key.
- README History section, roadmap, `features/sync/README.md`, `.claude/rules/history.md` and
  `sync-integrity.md` updated in the same change.

## 11. Migration and the format fence

Old clients must not run destructive paths against the new format. Without a fence (verified in code):
- 1.x deep clean deletes every pin not flagged in the legacy log (`maintenance.ts:142-145,171-174`) and every
  object only new history names.
- 1.x GC sweeps hashes of legacy records it evicts, which new blocks may still name.
- An in-flight legacy `updateHistoryLog` can overwrite a v3 stub with v2 (unconditional put).

Fence: the new format ships with `MANIFEST_VERSION` 3, like the config reset's version 2.
1. Migration runs inside a push: import `history.json.enc` into blocks (deterministic), move flagged pins to
   the new pin shape, delete unflagged leftover pin manifests, publish HEAD v3, then write a v3 log stub.
2. Every release since 1.0.0 refuses a manifest version above its own ("requires a newer MDSync version",
   checked in tag 1.0.0). An old deep clean in flight re-reads HEAD after listing and bails
   (`maintenance.ts:154-160`); an old GC in flight re-reads HEAD late and withholds its sweep (`gc.ts:159-170`, `readHead`).
3. Consequence: a 1.x device stops syncing with "update MDSync" until updated.
4. Reset by an old client does not read the manifest (`remote/reset.ts:21-31`) but can no longer reach a v3 remote
   through the normal flow; any `history/` left behind carries the old `vaultId` and goes as another generation.
5. Settings: horizon default 3 months whatever N was.

## 12. Shares and relay

Shares use the same layout under `shares/<id>/` (the broker accepts any key there, `packages/relay/src/share/key.ts`).
Participant requests are presigned by the relay: the record PUT and history listings add relay requests
(Workers free tier); `prepareReads` batching applies. Budget to be checked (Q5).

## 13. Cost model

| Operation | Today | New |
|---|---|---|
| push | 3 calls (5 on a race), 2-3x log bytes; Drive 5-7 HTTP | 1 PUT, size of the change; Drive + name lookup |
| open Timeline, warm | log read (304) + HEAD | LIST history/ (+ pins/) + HEAD + new objects only |
| open Timeline, cold | whole log + HEAD | LIST + HEAD + blocks of the visible range |
| File history / Deleted, cold | whole log + HEAD (+ pins) | LIST + every block once, decoded one at a time |
| GC | up to every ~80 s under autosync; log rewrite + full `objects/` listing | at most hourly; block PUTs + read-backs; one `objects/` listing per phase 2 (daily) |

R2 prices LIST as Class A ($4.50/M) and GET as Class B ($0.36/M): readers list once per open, never per push.

## 14. Open questions

- Q1. Retire grace for superseded inputs: 1 h enough for slow readers?
- Q2. Cover rule: coarser first. Can a reader prefer a coarse block over a finer one that has a newer record?
- Q3. Activity in UTC hours vs local days of the pushing device.
- Q4. CDC sizes and threshold after the measurement; recipe cache size on phones.
- Q5. Relay request budget for share participants.
- Q6. History off: replaced HEAD blobs wait for deep clean today; let phase 2 take them?

## 15. Review log (v1 -> v2)

Architecture swarm (8 confirmed), a research explorer and a code-cost explorer.

| Finding | v2 |
|---|---|
| F1 migration not fenced: a legacy writer can overwrite the stub | format fence, HEAD v3 (section 11) |
| F2 one key for different segment representations | resolution + content digest in the key, verify by read-back (5) |
| F3 chunk upload skipped on cache evidence | only HEAD's recipes or own uploads vouch (9.2) |
| F4 deep clean and verify ignore recipes and chunks | one content owner used by all (9.2) |
| F5 pin listing not authoritative under Drive lag | two-phase sweep, pins read 24 h after the drop (7) |
| F6 "off-chain" deletes ranges behind a gap | deletable table; gaps protect (7) |
| F7 bucket time derived from children | server write time, captured once, forward clamp (4) |
| F8 read size unbounded (17k records/day at 5 s) | finer first-day tiers, packing every 64 records, view-ranged reads (4, 7) |
| O1 legacy reset leaves new history dangling | `vaultId` generation (5, 11) |
| B2 rejects `If-None-Match`; Drive has no conditional create | no reliance on `putIfAbsent` (5) |
| keyed CDC is not fingerprint-proof | accepted limit, stated (9.2) |
| no maintained browser FastCDC | own implementation (9.2) |
| 100 MB at 64 KB = 1600 objects | second size class above 16 MB (9.2) |
| GC can run every ~80 s today, on the push path | hourly, scheduled (7) |
| record size is the change, not ~1 KB; LIST is Class A on R2 | cost model fixed (13) |

## 16. Implementation steps

Each step: tests, `pnpm typecheck`, `pnpm arch`, a review swarm, and the rules and READMEs it touches, in its own commit.
Steps 3-6 change the remote format, so they release together (the fence).

| # | Step | Ships alone |
|---|---|---|
| 1 | Compress file blobs (9.1) | yes |
| 2 | Folded into 9: until recipes exist, `loadRemoteBytes` is already the one reader and the owner would be an abstraction ahead of its need | - |
| 3 | History model, pure. 3a: merged records (`composeChanges`, `deletedLast`), activity, ladder and periods, thinning. 3b: cover and the GC plan. Property tests | no |
| 4 | Write and read: record on push, listing + cover + cache, queries (file history, deleted, timeline, replay), pins in the new shape | no |
| 5 | GC: phase 1 blocks, phase 2 sweep, schedule; deep clean, verify and reset on the new layout | no |
| 6 | Migration and fence: `MANIFEST_VERSION` 3, legacy import, pins, stub | with 3-5 |
| 7 | Settings: **Keep history for**, retire `fileHistoryMaxSnapshots` | with 3-6 |
| 8 | UI: Timeline sessions, tier headers, filter; History grouping; Deleted "kept until"; activity calendar | with 3-7 |
| 9 | Measurement script (9.3), content owner, CDC (recipes, chunks, upload trust), Excalidraw codec | yes |

Side finding, outside this design: `putIfAbsent` on S3 sends `If-None-Match: *` (`s3-store.ts:140-147`), which
Backblaze B2 reportedly rejects; onboarding a data key on B2 may fail. Unverified.
