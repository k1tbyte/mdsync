# Live editing

Open notes and drawings of a space are edited together through that space's room on the relay hub: one Y.Doc per file, sealed frames. When no room answers, the note stays with the file sync.

Constraints: `.claude/rules/live.md`, `.claude/rules/realtime.md`, `.claude/rules/presence.md`. Wire formats: `packages/protocol/README.md`.

## Map

- `session/`: `session.ts`, `outbox.ts`, `rotation.ts` - session state, delivery, rebuilds.
- `workspace/`: `sessions.ts`, `room.ts`, `rename.ts` - open notes and room lifecycle.
- `cold/`: `cold-sync.ts`, `agreed-texts.ts` - file-sync bridge and merge bases.
- `text/`: `model.ts`, `binding.ts`, `merge.ts` - Y.Text, editor, merge.
- `drawing/`: `model.ts`, `binding.ts`, `excalidraw.ts` - Y.Map elements and host adapter.
- `register.ts` wires events; `live-state.ts` feeds header/status state.

## Flow

1. A note opens in a view that can edit it live; `room.ts` names its room from the path inside its space root plus the generation.
2. `Sub`, then `State`: an empty room with no log gets one `Seed` from disk, anything else is merged in three ways and patched into the Y.Text.
3. Local edits go out through the outbox (paced by **Live editing speed**) until their `Echo`; remote updates reach the editor through the binding, and the view saves the file.
4. A settled room is snapshotted and compacted; **Rebuild live note** rotates into the next generation.
5. The file sync meets live notes only through `LiveNotes` (`cold/cold-sync.ts`).

## Notes

- Agreed texts live in the plugin folder: a cold baseline alone duplicated unpushed lines. Git's zealous merge keeps matching opening/closing lines once. External writes enter through Obsidian's editor merge and the binding.
- Drawings stage changed versions because `mergeUpdates` retains overwritten stroke frames; dispose, absorb, rebuild and detach also drain the stage. Reconcile only `keysChanged`. Pointers use scene coordinates, once per animation frame. The API loads after `file-open`: retry every 500 ms; reloads rebind via `stale`.
- Peers in a renamed room rename their files and follow with the merge base; devices that never joined treat it as a new note.
- Rebuild sheds tombstones. An oversized snapshot triggers the leader's rebuild; an oversized rebuild falls back to file sync ("too-large").
- Deletions have no author: a Yjs delete set carries no client.

## Accepted limitations

- External writes based on files older than the editor's last save replace intervening edits; Excalidraw drops external writes just after its save.
- A seeder learns the log name at its next `STATE`; earlier log loss is detected only when the head falls behind.
- A rename blocked by another room at the target or 10 s of room activity leaves both files after sync; opening a stale old path before sync catches up does too.
- A remote move waits for the local room to close before file sync renames the file.
- A newly shared folder leaves its vault room behind; peers type there until the record signal moves them, then merge into the share room.
- A rebuild during a rename's workspace-refresh wait leaves the renamed note in a separate fresh room until reopen (`carryRenamed` skips moved sessions); file sync reconciles it.
- Reverting to an unmarked version under a newer agreed base replays into the room on next open.
- Excalidraw's key-derived pointer colours differ from avatars.
- Faster live editing speed takes effect at the note's next send.
- Open: rooms persist until their share ends, in one 10 GB Durable Object. Retirement needs tombstones, client generation moves and backfill within the Workers Free write budget; deleting idle rooms makes ids seedable again.

Tests: `packages/plugin/tests/features/live/`; hub harness: `packages/plugin/tests/helpers/live-hub.ts`.
