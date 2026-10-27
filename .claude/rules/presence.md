---
paths:
  - 'packages/plugin/src/features/presence/**'
  - 'packages/plugin/src/features/note-header/**'
  - 'packages/plugin/src/features/explorer/**'
  - 'packages/plugin/src/features/status/**'
  - 'packages/plugin/tests/features/{presence,note-header,explorer,status}/**'
---

# Presence

Who is where, the note header, the file tree marks and the status surfaces. Model and accepted limits: `features/presence/README.md`. Paths are relative to `packages/plugin/src/`.

## Announcements

- Each device announces `{key, name, device, note, idle}` on every space channel it holds, sealed whole with that space's frame key (`features/presence/announcement.ts`): the relay sees no names or paths. `note` is the path inside the space root, so each mount maps it onto its own.
- `device` is the device's own name in a share (one person's devices share a key), null in the vault (whose keys are devices). Every settings save refreshes presence and rooms, so a device rename reaches both.
- A client can seal any name, not the `who` the hub vouches for its socket: an announcement shows only from a vouched socket whose key is its `who` (`features/presence/channel.ts`), a participant under their invited label. The owner's sockets may carry any key (the vault's devices).
- A file counts only while a tab shows it (Obsidian keeps naming a closed one active); idle after `IDLE_AFTER_MS` without input in any window, popouts included, or with every window hidden (`features/presence/here.ts`).

## Identity and colour

- The key groups and colours: the person in a share, the device in the vault. One colour per key everywhere (`personColor` / `personTint` in `core/shared/colors.ts`): cursors, author tint, avatars. Hex, so awareness sends no tint.
- The author tint names a present person by their vouched label; one who left, by their own `users` entry. Attribution is advisory (each client names its own client id); never treat it as proof.

## Views and caches

- `People` (`features/presence/people.ts`) caches its per-space and per-note views and drops them at every change of what a channel knows (`onEntriesChange`), a changed partition, or dispose. Returned lists are shared: never edit them.
- `SpaceRecords.partition()` is memoized on the identity of `settings.spaces`, `pausedSpaces` and `localRoots`: replace those fields, never edit them in place, or every reader sees the old partition.
- The tree paints two layers (`features/explorer/row-decorator.ts`): change, link and ignored marks, rebuilt only when the diff, links, partition or ignore state changed; and the presence layer (share badges, people, unseen), recomputed per pass. A people event repaints only rows whose marks changed. The row adapter reads Obsidian's undocumented `fileItems` (`features/explorer/file-explorer-api.ts`).

## Follow

- One follow controller on the plugin (`features/presence/follow/follows.ts`), so one tab follows at a time. Following opens the person's presence `note` in the same tab and keeps their cursor in the middle half of the view (`features/presence/follow/follow-scroll.ts`); the watch reads edits too and scrolls a frame later.
- Input never ends following; it ends on **Stop following** (`features/presence/follow/follow-banner.ts`), another note opened there by hand, or the person leaving the space.

## Header and marks

- The note header shows its live mark only after the room answers or `SETTLE_MS` passes (`features/note-header/note-presence.ts`), so switching notes never blinks through joining. A vault note shows none unless another device is in it or the relay has trouble. The header is its own button, not `clickable-icon`.
- Scrollbar cursor ticks (`features/live/text/scroll-marks.ts`) scroll there, never follow.
- A read-only share's lock is the editor's (`features/spaces/ui/read-only.ts`: CodeMirror `editable`/`readOnly`), shown in the header; drawings stay in Excalidraw's view mode, and only views put there by the lock are let out.
- The tree's "new" dot (`features/presence/unseen.ts`, vault localStorage): a pull or auto-merge landing content another key published, past the space's first sync, marks those share files unseen unless active; opening clears it, renames and deletions follow it.
- The relay status every display reads is `HubConnection.statusOf` (`features/relay/connection.ts`), worded once in `core/hub/relay-text.ts`: never derive a second status in a surface.
