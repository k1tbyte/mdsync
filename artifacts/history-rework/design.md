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
- Captured once when GC first packs the record, stored with it, never recomputed. An undated push record takes
  its parent's listed time, else the newest time listed (as "now", a record never packs and holds up the rest).
- Forward clamp along the walk (`forwardTimes` in `coverOf`): a record is never older than its parent, so every
  period is one run of the chain. A straggler back in time joins its parent's period; one ahead carries its
  successors with it (kept longer, the safe direction). The clamp depends only on older records, so a
  captured `at` stays valid. Without it, a group held non-adjacent records: replay skipped what lay between,
  and a counts group's `lastId` cut off a newer record.
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
history.json.enc                                    1.x log, deleted after the first v3 push (section 19)
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
	lastId?: string;                     // counts only: newest record dropped, where the chain ends by retention
	consumed: string[];                  // keys this object replaces
}
/** Sparse: UTC hours since epoch -> [pushes, paths changed]. */
type Activity = Record<number, [number, number]>;
```

- An object's key carries its resolution, group and a `digest` of its whole content (`records`, `activity`,
  `lastId`, `consumed`; SHA-256, first 16 hex), so a key never changes meaning and readers cache it for good.
  Readers recompute the key and treat a mismatch as unreadable. Two devices building the same content from the
  same view write the same key, and a Drive duplicate of it is the same content; from different views they
  write two keys (the "different views" race below). No reliance on `putIfAbsent` (B2 rejects
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
2. Skip every object a later present object names in `consumed`. Split each object into chain runs; every
   record ends a candidate (its run up to it), so a sibling may fork from inside a packed run. Walk from HEAD's
   id back: at each id take the candidate reaching furthest (the root, then more pushes), then coarser, then
   longer, then the smaller key. GC uses the same pure function (`coverOf`).
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
- Replaced: within the horizon only an input the walk took whole. A part off the walk may be a sibling that
  held HEAD for a moment (two pushes on one parent both read their own id back) or lie behind a gap, and no
  age proves otherwise (a straggler fools the complete rule): it stays until its group goes to counts, which
  replaces the whole group. A build that replaces nothing still thins; the next walk prefers it.
- Content: the chain's records with `at` in G, merged per R-period over chain-contiguous runs. `consumed` =
  the replaced keys plus the `consumed` of each of them still present.
- Counts: the walked records' activity, merged per UTC hour by the larger value with other counts of G
  (another view of the same pushes, never a sum). A counts group goes whole even with a gap inside it:
  behind the gap nothing is counted (accepted).
- Late record: a push record written before publish may join the chain after its slot was built. It is an
  unconsumed input of that slot, so the next run rebuilds the slot with it.

Phase 1, one run:
1. List, read what the plan needs, plan. A history object that cannot be read stops the run: a gap that is
   only this run's would let a counts group or the horizon take what lies behind it.
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
| push record or object off the walk | its newest record past the horizon, settled (behind a gap, never counted) |
| blob | phase 2 above |

Within the horizon, a gap or a disconnected range never makes anything deletable: past a gap the log is not evidence.

Concurrency:

| Race | Outcome |
|---|---|
| two GCs, same view | same keys and bytes; the second write changes nothing |
| two GCs, different views (listing lag) | different digests for one group; both live; the next run rebuilds the group from the walked one, the other stays until counts (a bounded leak); two counts merge by the larger per hour |
| GC vs push | a group is due only 10 min after its end; a late record rebuilds its slot; blobs only in phase 2 |
| GC vs pin | phase 2 lists and reads pins 24 h after the drop |
| reader vs GC | one re-list on 404; readers never delete |
| old client | fenced by the format bump (section 11) |

## 8. Activity calendar

- Every stored record carries `activity`; merges sum it, so thinning never loses counts. Readers take per hour
  the larger of the walked records' sum and each counts object (`activityOf`): a second counts of a group, or a
  record walked there until GC folds it in, is another view of the same pushes.
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
1. No import: every new publish carries v3, and the push after it deletes `history.json.enc` and the
   bare-manifest pins (section 19).
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
| F7 bucket time derived from children | server write time, captured once, forward clamp along the walk (4) |
| F8 read size unbounded (17k records/day at 5 s) | finer first-day tiers, packing every 64 records, view-ranged reads (4, 7) |
| O1 legacy reset leaves new history dangling | `vaultId` generation (5, 11) |
| B2 rejects `If-None-Match`; Drive has no conditional create | no reliance on `putIfAbsent` (5) |
| keyed CDC is not fingerprint-proof | accepted limit, stated (9.2) |
| no maintained browser FastCDC | own implementation (9.2) |
| 100 MB at 64 KB = 1600 objects | second size class above 16 MB (9.2) |
| GC can run every ~80 s today, on the push path | hourly, scheduled (7) |
| record size is the change, not ~1 KB; LIST is Class A on R2 | cost model fixed (13) |

Step 3 review (two bug-hunt rounds and a probe):

| Finding | Fix |
|---|---|
| a straggler leaves an object `[a, c]` with `b` elsewhere; the walk skipped `b` and replay invented states | forward clamp (4); `coverOf` still splits stored objects into runs |
| a straggler across a 4-week boundary put `a`, `c` in counts with `lastId = c`, cutting off `b` | forward clamp (4) |
| a delayed sibling forking inside a packed run read as a gap | every record ends a candidate (7) |
| a rebuild consumed an off-walk object holding a sibling, or one behind a gap that a straggler made look complete | within the horizon only what the walk took whole (7) |
| counts rebuilt from a later view summed the same pushes; duplicate counts, or a walked record beside its counts, double-counted | per-hour max (`mergeCounts`, `activityOf`) |
| `expired` could take a key written moments ago | settled only |
| counts bypass completeness; a gap of one run loses counts | accepted for real gaps; an unreadable object stops the run (7) |

Carried into step 4: `historyLogToSpace` and the new record and object path translation must carry `deletedLast`.
A failed record PUT freezes everything older than it out of the walk until the horizon; retry the record from
the pushing device (it holds parent and manifest) before calling the gap permanent.

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
| 6 | Fence: `MANIFEST_VERSION` 3 on every publish; 1.x history and pins deleted, not imported (section 19) | with 3-5 |
| 7 | Settings: **Keep history for**, retire `fileHistoryMaxSnapshots` (section 20) | with 3-6 |
| 8 | UI: Timeline sessions, tier headers, filter; History grouping; Deleted "kept until"; activity calendar | with 3-7 |
| 9 | Measurement script (9.3), content owner, CDC (recipes, chunks, upload trust), Excalidraw codec | yes |

Side finding, outside this design: `putIfAbsent` on S3 sends `If-None-Match: *` (`s3-store.ts:140-147`), which
Backblaze B2 reportedly rejects; onboarding a data key on B2 may fail. Unverified.

Side finding: two pushes on one parent can both read their own id back when the second `put` lands after the
first verify (`publishManifestWithGuard`, a device stalled between precheck and put); the first device's
changes leave HEAD while it believes them published. Pre-existing, outside history; history keeps the sibling
only for the settle window.

## 17. Step 4 plan: write and read on the new layout

Paths relative to `packages/plugin/src/features/sync/`. Steps 3-6 release together, so the branch may sit
between formats; no commit may leave a destructive path reading the wrong one.

| Module | Holds |
|---|---|
| `history/remote.ts` (new) | keys (`history/p/<id>.enc`, `history/b/<res>-<group>-<digest>.enc`); `sealPushRecord`; `readHistory(storage, key, root)` -> `{ view, unreadable, now }`: one `listDetailed("history/")`, decode only keys not cached, one re-list on a 404. Cache: per storage adapter, key and root, decoded entries by storage key (immutable: ids for pushes, digests for objects), pruned to the listing. In memory; IndexedDB is a later perf step |
| `history/pins.ts` (new) | `pins/<id>.json.enc` = `{ v: 1, manifest, label?, pinnedAt }`; `readPins(pick)` (listing + decode, newest snapshot first, LRU of 4 by key and etag/modified), `readPinById`, `writePin`, `deletePin`. A legacy bare-manifest pin reads as unreadable until step 6. The pinned set is the listing: no flags anywhere. Pin, unpin and relabel run on the operation queue as today |
| `history/query.ts` | `readTimeline(...)`: HEAD + `readHistory` + `coverOf` + pins, the one entry for every query. `getFileHistory`, `listDeletedFiles`, `listSnapshots`, `resolveSnapshotManifest`, `setSnapshotPinned` over `cover.chain`; a pin not on the chain is diffed against HEAD as today |
| `history/replay.ts` | `replayTo(head, cover, id)` over walked records |
| `history/publish.ts` | build the `PushRecord` (`diffManifests(parent, manifest)`), PUT it, publish with the guard. A failed PUT warns, publishes anyway and stays pending in memory for this storage; the next push writes pending records first (heals the gap while the app runs). No GC call (step 5) |
| `history/store.ts` | shrinks to the legacy log reader (`readHistoryLog`), kept for step 6's import and for deep clean's live set until then; `updateHistoryLog`, `prependSnapshot`, `writeHistoryLog` and the old pin flag code go |
| `history/gc.ts` | deleted with its tests; step 5 writes the new GC. Until then nothing thins or sweeps |
| `remote/space-paths.ts` | `changesToSpace` / `changesToVault` (with `deletedLast`), used by `remote.ts` for records and objects and by the legacy log rekey |
| `runtime/maintenance.ts` | live set = HEAD + every present push record and object (`changeEntries`, off-walk included) + every listed pin + every record of the legacy log until it is imported (unreadable fails closed, legacy pins included). Deep clean deletes settled orphan objects only; pins are live by being listed. Bails if HEAD or the pin listing changed |
| `remote/reset.ts` | also deletes `history/` |
| `history/types.ts` | `DeletedFile.rank` and `SnapshotSummary.rank` -> `keptUntil: number \| null` (null: a pin holds it, or no horizon). `DeletedFile.pinned` says a pin holds that hash. `HistoryConfig` is `{ horizon }` (3 months until step 7's setting); `pushes` and `at` on `SnapshotSummary` wait for the UI step |
| `source-control/trash/trash-rows.ts` | retention note "kept until <date>" from `keptUntil` |

`keptUntil` for a record: the end of its counts group plus the horizon (`groupEnd("counts", groupStart("counts", at)) + horizon`), the latest moment it can still be read: retention promises "at least".

Rows come from walked records: a merged record is one row (`pushes` > 1). Order by chain position, never `createdAt`.

Deviation from section 7 (ranged, block-by-block reads): step 4 lists `history/` and decodes every key
not yet cached, holding the decoded view in memory per storage. Records are small and, once GC runs,
bounded by the horizon; ranged reads and the IndexedDB cache come with the Timeline UI (step 8), behind
`readHistory`.
Tests: the legacy query, log and GC tests are rewritten on `FakeStorage` with real pushes (`pairedSessions`):
push records land before publish; queries over a packed view (objects written by hand through the model);
a failed record PUT then a later push heals the gap; space paths round-trip with `deletedLast`; deep clean
keeps every blob named only by new history and every new-shape pin.

## 18. Step 5 plan: GC

Paths relative to `packages/plugin/src/features/sync/`.

| Module | Holds |
|---|---|
| `history/sweep.ts` (new, out of `runtime/maintenance.ts`) | `reachableHashes` (HEAD, every listed record and object, every pin, the legacy log until step 6; anything unreadable fails closed) and `sweepObjects(storage, key, root, { freedOnly })`: settled objects nothing reaches, never a hash in a candidate file younger than a day (an unreadable young file fails closed), only the settled files' hashes with `freedOnly`; bails if HEAD, the pin listing or a new history key moved meanwhile; deletes the settled files after. Deep clean is `sweepObjects()`, phase 2 `sweepObjects({ freedOnly: true })`. `runtime/maintenance.ts` keeps verify and the deep clean wrapper |
| `history/remote.ts` | `writeHistoryObject(storage, key, root, build)`: space paths, digest of `{ records, activity, lastId, consumed }` (SHA-256, 16 hex) in space paths, key `history/b/<res>-<group>-<digest>.enc`; put, read back, key check; returns the verified object. Decoding recomputes every object's key (mismatch: unreadable). `readHistory` returns the `history/g/` listing from its one call. Candidate files `history/g/<runId>.enc` = `{ v: 1, hashes }` (`writeCandidates`, `readCandidates`) |
| `history/gc.ts` (new) | `collectHistoryGarbage(storage, key, root, history)`. Phase 1: HEAD, `readHistory` (stops on an unreadable key), `coverOf`, `planGc`; write and verify each build; candidates = hashes of every listed key the run retires minus those the verified builds name (`freedHashes`); write the candidate file, then delete each verified build's `consumed` and `plan.deletes`. Phase 2, only when the same listing holds a settled candidate file: `sweepObjects({ freedOnly: true })`. Returns counts |
| `runtime/maintenance-service.ts` | `afterPush(space)`: at most every 10 min per space, on the quiet queue (`enqueueQuiet`: no busy state), with that space's session; skipped with history off or the space paused; a failure is a log warning. `dispose()` stops queued runs |
| `runtime/operation-runner.ts`, `controller.ts` | the won-push branch calls a `historyGc` callback; the controller wires it to `maintenance.afterPush` |

Deviations from section 7: the candidate file is written before any key is retired (a crash between leaves
candidates whose hashes are still named, so phase 2 keeps them; the other order leaks them); no jitter (one
device wins each push, so runs do not herd); no manual trigger yet; the digest covers `consumed` (section 5).
Deep clean holds every hash a run freed within the day, so neither caller of the sweep bypasses the window.

Accepted (review of step 5): a push whose record was written long before its publish is due at once, so on
the guard race (side finding, section 16) its GC may merge away the parent a stalled concurrent push still
names; that push's history then starts at a gap. The throttle is checked when GC is queued, so a push longer
than 10 min can queue a second run behind the first (one extra listing).

Tests: pushes under fake time through `FakeStorage`; every retained snapshot replays to the manifest it
published, before and after GC; a rerun changes nothing; lost sibling, foreign vault and expired-behind-gap
deletes; an unreadable object stops phase 1; candidates swept only after 24 h and only when unreachable; a pin
or record appearing between the phases keeps its blobs.

## 19. Step 6 plan: fence and old-history cleanup

Replaces the legacy import (section 11, item 1): old history is deleted, not converted. Paths relative to
`packages/plugin/src/features/sync/`.

| Module | Holds |
|---|---|
| `constants.ts` | `MANIFEST_VERSION` 3 |
| `remote/manifest.ts` | `buildManifest` publishes `MANIFEST_VERSION` on every manifest (was the parent's version), so every 1.x client refuses the remote from the first new push |
| `operations/config-reset.ts` | drops its own version override: every manifest already carries one 1.x cannot read |
| `history/legacy.ts` (replaces `history/store.ts`) | `clearLegacyHistory(storage, key)`: deletes every pin that decrypts to a bare manifest (top-level `snapshotId`), then the log if present; returns the count. Pins are scanned without the log too (an interrupted reset can leave them); a pin it cannot decrypt stays (unknown) |
| `runtime/maintenance-service.ts` | `afterPush` runs `clearLegacyHistory` before GC once a session per space (again after a failure), history on or off (a legacy pin blocks every sweep), and logs when it removed something |
| `history/sweep.ts` | `reachableHashes` drops the legacy log: no reader is left, so the blobs only it named are orphans for deep clean. `sweepObjects` refuses a HEAD below `MANIFEST_VERSION`: before the fence 1.x clients still sync and name those blobs |
| removed | `readHistoryLog`, `historyLogToVault`, `HistoryLog`, `SnapshotEntry` |

No v3 log stub: a 1.x client reads HEAD before any history path and refuses it. A 1.x client stalled
mid-push across the first v3 publish can still land one v2 HEAD and rewrite `history.json.enc`; the next new
push publishes v3 again and its cleanup deletes the log again. Versions only the old log or old pins named
leak until a deep clean.

Tests: `legacy.test.ts` (bare-manifest pins and the log go, new pins and undecryptable ones stay, pins without
the log go); the service clears with history off, once a session, again after a failure; `buildManifest`
writes 3 on a v2 parent; deep clean refuses a v2 HEAD.

## 20. Step 7 plan: Keep history for

| Module | Holds |
|---|---|
| `core/constants.ts` | `HISTORY_KEEP_MS`: `week` 7 d, `month` 30 d, `quarter` 91 d, `year` 365 d, `forever` null |
| `core/settings/model.ts` | `fileHistoryKeep: HistoryKeep` (default `quarter`, any other value parses to it); `fileHistoryMaxSnapshots` joins `RETIRED_KEYS`, its bounds and constants go |
| `features/settings/sections/automation.ts` | **History** toggle (was "File version history"); **Keep history for** dropdown replaces **Versions to keep**, its text says what thins and that the shortest device setting applies |
| `features/transfer/transfer.ts` | `fileHistoryKeep` travels as `y`; an old link's `j` is ignored (default applies) |
| `app/session-factory.ts` | `horizon: HISTORY_KEEP_MS[settings.fileHistoryKeep]` replaces the constant |

The horizon stays a device setting, as N was: each device's GC applies its own, so the shortest wins (said in the
setting and the READMEs). Changelog (at release): 1.x devices must update; old history and pins are removed;
**Keep history for** replaces **Versions to keep**.

## 21. Step 8 plan: UI

Target: `artifacts/history-mockup/History Rework.dc.html`; state colours from both mockups. Decided with the
user: calendar in settings under **Keep history for** (2b); the root page draws one too, from the activity this device last read (`ActivityCache`, no request); a toggle hides the Timeline
calendar; rows say "pushes", never "saves"; the phone shell stays. Plugin paths under `packages/plugin/src/`.

What stored data cannot show, so the UI does not: a file's push count ("from 214 saves"), distinct files per
day (activity sums paths per push), the pushes inside a merged version ("Show all N pushes" only for
every-push sessions), a merged version's other devices (a session goes by each version's last device),
deleted rows past the horizon.

Stages, each its own commit:

| # | Stage | Modules |
|---|---|---|
| 1 | Palette | `core/ui/styles/tokens.css`: `--mdsync-added-rgb`, `--mdsync-modified-rgb`, `--mdsync-deleted-rgb` per theme (dark = mockup `#44cf6e`, `#e9973f`, `#ff8a8e`; light = `#1a7f37`, `#bc4c00`, `#cf222e`) and `--mdsync-added/modified/deleted`; every A/M/D letter and chip, size delta, explorer mark, editor change bar and diff tone reads them. Warnings, errors and success stay on theme colours |
| 2 | Data | `history/model/cover.ts`: `WalkedRecord.res`. `history/types.ts`: `SnapshotSummary` + `at`, `firstAt`, `pushes`, `res` (null off the walk); `FileVersion` + `at`, `pushes`, `res`, `first`; `SnapshotListResult` + `truncated`, `activity`. `history/query.ts` fills them (`readTimeline` returns the view for `activityOf`) |
| 3 | Shaping, pure | `source-control/history/age-groups.ts` (replaces `day-groups.ts`): Pinned, then "Last hour" (every-push within the hour), a day per header for push / 10 min / hour versions, a week ("Oct 12 – 18") for daily, a month for weekly; the chip names the coarsest stored resolution in the group, shown where it changes; dated by `at`; titles by `ageTitle`. `source-control/timeline/sessions.ts`: consecutive versions of one device and resolution under one header, < 10 min or one kept period apart, a pin alone (sessions run on the walk order, so a composed session never skips a link), composed lazily with `composeChanges`. `sync/ui/history/calendar.ts` (next to its renderer): activity to local days, level 0 / 1-5 / 6-12 / 13-24 / 25+, a day at the coarsest version covering it, counts before the oldest walked version, a week at its newest kept day else the newer week's, bands, tooltip. `core/shared`: `formatDay`, `startOfDay`, `startOfWeek`, `pluralize` plural |
| 4 | Timeline | `sync/ui/history/activity-calendar.ts` + `.css` (renderer shared with settings, exported by the sync facade with `buildCalendar`, `RESOLUTION_TEXT`): weeks as columns, scrolled to the picked day or today, horizontal scroll, `aria-label` tooltip, a tap on a phone shows it as a notice, clicks by delegation; resolution strip under it. `source-control/timeline/`: `session-rows.ts` (`buildSessionRows`, `touches`), `session-card.ts` (card, version rows, file rows), `timeline-tab.ts`: collapsible Activity card ("N pushes since <date>"), path filter (typing redraws only the list) with a day chip, a picked day lists that day and older, a counts-only day shows its card with **Show nearest version**, session cards ("Laptop · 08:40 – 12:10", "N versions · N pushes · N files", chips, net size neutral, **Latest**), expanded: composed files plus **Show all N pushes** for every-push sessions, else "Last version of each <period>" rows, each version row opens its files; menus "Pin this version", "Restore vault to end of session…" / "…to this version…"; gap callout "Older history is out of reach" at the end; filter with no match: "No pushes touch <q>" + **Clear filter**. Setting `fileHistoryActivity` (default on, transfer `f`), **Show activity in Timeline**. The current device keeps its own name, not "This device" |
| 5 | History | `getFileHistory` dates a version by the record that wrote it (was: the newest snapshot holding it, which put every current version at HEAD) and marks it pinned when any pin holds its hash (pin actions go to that pin's snapshot); content older than the walk is the oldest record's parent and cannot be pinned. Grouped like the Timeline with chips (`renderAgeHeader` in `row-parts.ts`, shared); titles "14:41" / "Wed 14 Oct" / "Week of 7 Sep"; meta "Phone · last of 3 pushes", "first version"; size above a coloured delta; footer "Older versions thin out with age; before <date> only pinned versions and activity counts remain." (date: start of the counts group `keptUntil` has passed, `countsBefore`) + **Keep history for** (opens settings); forever: "Older versions thin to one per week and are kept for good." |
| 6 | Deleted | path filter (Select all acts on the shown rows; hidden ones leave the selection), header "Kept <3 months> after deletion" / "Kept for good", note "Kept until 24 Feb 2027", empty "Nothing deleted in the last <3 months>. Older deletions drop out unless a pinned snapshot holds them." Choice names are `HISTORY_KEEP_TEXT` (`core/constants.ts`), shared with the setting; a relative time past a month reads "12 Aug" (`formatDay`) |
| 7 | Settings | `sync/ui/history/holds-row.ts`, exported by the sync facade and composed by `settings/sections/automation.ts` (loading and the ladder stay with sync's history UI): **What history holds** row under **Keep history for**: calendar, strip and a ladder of the kept resolutions for the chosen horizon ("Every push · Last hour" ... "1 per week · Back to <date>", "Activity only · Older"); a day click opens the Timeline on it (`openTimeline(day)` host callback, `openSourceControlTimeline` in `source-control/workspace.ts`; the Timeline builds its calendar while hidden so the day still filters); data from `listSnapshots`, loaded when the row renders, a failure says so in the row; ladder from `stagesOf` (periods: a rung due no sooner than counts never shows, so a week or month horizon has no weekly step), "Back to <countsBefore>" / "Kept for good" |

Tests: stage 2 on `FakeStorage` pushes (fields, activity, truncated); stage 3 pure (groups across tiers and the
hour boundary, sessions split by device, gap, resolution and header; calendar levels, local days across DST,
counts-only cut, bands); stages 4-7 rows-level builders, DOM only where a builder cannot show it.
