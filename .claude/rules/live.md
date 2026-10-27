---
paths:
  - 'packages/plugin/src/features/live/**'
  - 'packages/plugin/src/features/sync/live-notes.ts'
  - 'packages/plugin/src/features/sync/recovery/**'
  - 'packages/plugin/src/features/sync/apply/**'
  - 'packages/plugin/tests/features/live/**'
---

# Live editing

Breaking one of these doubles, resurrects or silently drops text typed by someone else. Model, flows and accepted limits: `features/live/README.md`. Hub frames, echo and grants: `.claude/rules/realtime.md`. Paths are relative to `packages/plugin/src/`.

## Boundary

- `sync` never imports `live`: the engine owns the `LiveNotes` port (`features/sync/live-notes.ts`), `features/live/cold/cold-sync.ts` implements it, `app/` wires it. Live asks sync for nothing else.
- While a session lives its Y.Doc is authoritative for the note. Live never writes the file: the view that owns it saves.
- Text is LF before the CRDT and the hash, a lone CR included (CodeMirror breaks lines on it), through one normaliser (`toLf` in `core/utils/eol.ts`).

## Rooms

- A note is live only in its own space's room: named under that space's keys by the path inside its root (`docIdIn`, `features/live/workspace/space.ts`), its frames only on that space's slot. A note whose space changes (shared, paused, new key) leaves its room; the file sync of one space answers `later` for a note whose room belongs to another. Paused shares stay cold.
- A room is seeded once, only while it has no log: `Seed` from disk only on a `State` with `head == 0`, applied locally only on its `Echo`. An empty room with a log is a deleted note (seeding resurrects it, two seeds double it). An empty room behind what the device knows of it (its agreed seq in that generation, or a successor it was pointed at) lost its log and is never seeded.
- An update leaves the unacked FIFO only on its echo; everything unacked is resent on the next socket's `State`, and frames queued under a dead socket's epoch never act on the new one. A `State` with another log name, or a head behind what the session knows, means the room lost its log: the note rotates onto its next generation from its own text, never refills the old room.
- A room is rebuilt in one hub step or not at all: `Rotate` carries the sender's last seq as `upto`. Only a settled session rotates, a follower of a pointer never seeds, and a pointer other than `docIdFor(path, gen + 1)` leaves the note to the file sync.
- A snapshot comes only from a settled document (nothing pending or unacked), sent only by the lowest writer's client id; compaction after `COMPACT_AFTER` deltas (`features/live/session/room-log.ts`).
- A note reopened while its last session is still closing opens once that one's `Unsub` is out (`features/live/session/closing.ts`).
- A room silent `JOIN_PATIENCE_MS` after its `SUB` leaves the note to the file sync (`features/live/workspace/patience.ts`); a late answer merges in like a reopen.

## Disk and the file sync

- Disk enters a room only by three-way merge: `mergeThreeWay(base, disk, room)`, then `patchYText` as inserts and deletes on code points. Never delete-all plus insert, never a diff from room to disk: both overwrite what others wrote meanwhile. A conflict keeps both sides, the room's first.
- The merge base is the note's agreed text (`features/live/cold/agreed-texts.ts`), falling back to the cold baseline; a note whose folder just became a share uses the vault's frozen entry (`shareBases`).
- A `live` mark means the content is exactly that room's text at `seq`: only a hash equal to the agreed text earns it, and an open room with anything pending or unacked marks nothing. Marks `{doc, gen, seq}` are ordered by `(gen, seq)`, never merged, and never replace a remote mark of the same note at an equal or higher order.
- The file sync never writes a note whose room is open: the incoming version goes to the room (`LiveNotes.absorb`), which saves it through the editor before the baseline takes the remote entry. A room behind a snapshot of itself, one that closed or moved during the fetch, a view that could not save, or a note still joining while the hub is up all answer `later`: nothing moves.
- With the hub down a joining note is an ordinary file, and every view showing it is readied for the write (`expectWrite`). A marked version written to a closed note becomes its agreed text, disk first, then the base saved (`putNow`) before the journal lets a room open on it; a merge's base (`grewFrom`) is held the same way.
- Live and cold writes exclude each other: no room opens on a note under an engine write or stays on one cut short (an open marks the note joining before it asks the journal again, a sync claims before its last look for a room). An edit saved meanwhile, or a room come since, keeps the file (`coldSince`).
- Accepting the remote side and revert go the pull's way (`settleLive`, `writeIncoming`), so a room snapshot they put back becomes the base. `LiveNotes.holds` keeps the engine off a note live editing holds.

## Kinds

- Live document types are chosen by frontmatter, not suffix (`features/live/doc-types.ts`): a drawing goes live only in the Excalidraw view, never as text. Each kind is a `LiveModel` behind one session (`features/live/model.ts`); `features/live/workspace/editors.ts` pairs it with its view.
- Text binds through a Compartment over the undocumented `editor.cm`. Undo is the room's `Y.UndoManager` on every path (keymap, `beforeinput`, `editor.undo()`): Obsidian's own history would revert what others typed.
- A drawing binds through Excalidraw's undocumented API (`features/live/drawing/excalidraw.ts`, checked against 2.x). Elements go through a staging map drained once per send; remote ones apply with `captureUpdate: NEVER`; the room holds copies (Excalidraw mutates in place). A binding reads and writes only while the view `holds` its file, or one drawing pours into another's room. Excalidraw drops the first write after its own save, so the file sync clears that flag first (`letWriteIn`).
- A read-only person's text note follows its room (`features/live/session/follower-session.ts`): it sends only `Sub`, `Unsub` and `Awareness`, never seeds, rotates or compacts, and joins only when the disk is the room's text, the agreed text or the cold baseline. Drawings stay cold for readers.

## Renames and deletions

- A note renamed with its room open takes the room along (`features/live/workspace/rename.ts`): it rotates into the new path's first generation that has no room, probed by `SUB`; meanwhile the note counts as joining, so the file sync waits. Concurrent renames settle on the one the hub took first.
- Another device's deletion of a note open here keeps it as a new file and asks at once (`LiveNotes.kept`, `features/live/ui/deleted-elsewhere.ts`). An unreadable remote text is no deletion.

## Tests

- Live sessions run against the relay's own hub and SQLite store in-process (`packages/plugin/tests/helpers/live-hub.ts`) with switches for lost frames and reconnects; prove a lost or doubled edit there before fixing it.
