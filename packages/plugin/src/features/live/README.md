# Live editing

Open notes and drawings of a space are edited together through that space's room on the relay hub: one Y.Doc per file, sealed frames, the hub stores ciphertext only. When no room answers, the note falls back to the file sync. Constraints: `.claude/rules/live.md`; hub frames: `.claude/rules/realtime.md`; wire formats: `packages/protocol/README.md`.

## Map

| Area | Holds |
|---|---|
| `features/live/session/` | one file's session in its room: the state machine (`session.ts`), the unacked FIFO (`outbox.ts`), the room log and compaction (`room-log.ts`), rotation (`rotation.ts`), who else is there (`room-awareness.ts`), close before reopen (`closing.ts`), read-only followers (`follower-session.ts`), its ports (`session-deps.ts`) |
| `features/live/workspace/` | which open notes are live: `sessions.ts` and each note's state, joining a room (`room.ts`), join patience, renames (`rename.ts`), the space a note is in (`space.ts`), `editors.ts` pairing each model with the view that edits it |
| `features/live/cold/` | the file sync's `LiveNotes` port (`cold-sync.ts`, declared in `features/sync/live-notes.ts`) and the agreed texts (`agreed-texts.ts`) |
| `features/live/text/` | Y.Text model, CodeMirror binding and undo, disk-to-CRDT patch, three-way merge, rebuild, author tint, cursors, scrollbar marks |
| `features/live/drawing/` | Y.Map of Excalidraw elements, its binding and the undocumented host adapter (`excalidraw.ts`) |
| `features/live/register.ts` | workspace events, rooms, agreed texts and the sync port, wired from `app/` |
| `doc-id.ts`, `doc-types.ts`, `model.ts`, `authors.ts`, `live-state.ts` | room ids, what goes live in which view, the `LiveModel` contract, CRDT attribution, the states the header and status show |

## Flow

1. A note opens in a view that can edit it live; `sessions.ts` asks `room.ts` for its room id: HMAC of the path inside its space root plus the generation (`doc-id.ts`), so every mount of a share meets in one room.
2. The session sends `Sub` with what it knows. `State` answers with the room's head and log name. An empty room with no log gets one `Seed` from disk; anything else is merged in: `mergeThreeWay(agreed text, disk, room)`, then patched into the Y.Text.
3. Local edits go out through the outbox (paced by **Live editing speed**), each kept until its `Echo`. Remote updates apply to the doc, the binding carries them into the editor, and the view saves the file.
4. Once settled (nothing pending or unacked), the lowest writer snapshots the room; past `COMPACT_AFTER` deltas it compacts. **Rebuild live note** rotates into the next generation, shedding tombstones.
5. The file sync meets live notes only through `LiveNotes`: an open room takes incoming versions (`absorb`), a closed note's agreed text moves with each marked version, and a push marks a note `{doc, gen, seq}` only when its content equals the room's text.

## Notes

- Merge base: the note's agreed text per docId, kept in the plugin folder, falling back to the cold baseline (the baseline alone duplicated lines not yet pushed). Lines both sides open or close with come once (git's zealous merge).
- Drawings: `onChange` stages elements whose version moved; the session drains the stage once per send (also on dispose, absorb, rebuild, detach) because `mergeUpdates` keeps every overwritten frame of a stroke. Only an event's `keysChanged` are reconciled. Pointers travel in awareness as scene coordinates, one per animation frame. The view loads its API after `file-open`, so binding retries every 500 ms; a reloaded view replaces its API and the binding asks again (`stale`).
- A write under an open note (git, another sync) needs nothing from live: Obsidian merges it with the editor and the binding carries the change.
- A rename with the room open rotates the room to the new path's first free generation; a device in the room renames its file and follows with the merge base; one that never joined steps past as a new note.
- A snapshot past a frame makes the leader rebuild; a rebuild past a frame sends the note back to the file sync ("too-large"), as does the hub's tail cap.
- Attribution is advisory: each client names its own client id in `users`; deletions name no one (a Yjs delete set carries no client).

## Accepted limitations

- A writer that started from a file older than the editor's last save replaces what came between: Obsidian merges against that save. Git or another sync writing under an open drawing right after its save is still dropped by Excalidraw.
- A session that seeded a room learns the log's name from its next `STATE`: a log lost before that shows only once the head falls behind.
- A rename leaves the room in place when another note's room holds the new path or the room stays busy for 10 s; the sync then ends with both files. So does a device that opens a stale copy of the old path before its file sync caught up.
- A file moved elsewhere waits here while an open room holds its note; the file sync renames it once the room closes.
- A note whose folder becomes a share leaves its vault room in the hub (rooms are never trimmed); others type there until the record's signal moves them, then fold those edits into the share's room.
- A rebuild landing while a rename waits for its workspace refresh leaves the renamed note in a fresh room apart (`carryRenamed` skips a moved session) until it reopens; the file sync reconciles it.
- A revert to an unmarked version under a newer agreed base still replays into the room at its next open.
- Excalidraw colours pointers itself from the person's key, so they do not match the avatar.
- A faster **Live editing speed** applies from a note's next send.
- Open: the hub keeps every room until its share ends, in one Durable Object capped at 10 GB. Retiring rooms needs a tombstone, clients moving generation, and a backfill within the Workers Free write budget; deleting idle rooms alone makes ids seedable again.
