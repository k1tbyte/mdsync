# Presence

Turns who-is-where state into avatars, tree marks and cursor following. Shared views feed the note header, file tree, share window and status surfaces.

Constraints: `.claude/rules/presence.md`, `.claude/rules/realtime.md`, `.claude/rules/sync-integrity.md`.

## Map

- `channel.ts`, `people.ts`, `views.ts` - channel entries, aggregate views, display grouping.
- `here.ts`, `unseen.ts`, `register.ts` - local activity, unseen files, event wiring.
- `follow/`, `ui/avatars.ts` - following and avatars.

## Model

Devices see who is in a share's notes even without one open. A person's entry lists their devices; each cursor carries its device name. The explorer and history show the manifest publisher as last editor.

## Accepted limitations

- Every share owner has key `owner`; unnamed owners of different shares look alike.
- y-codemirror moves cursors only in focused windows; following uses that last position.
- Properties, renames and other plugins can change read-only files, leaving edits unpushed. An open note moved into a read-only root locks on reopen; drawings lock after view load (up to 500 ms), but scripts can still edit them.
- "New" is device-local: another device seeing a file does not clear it here. Deletions mark nothing.
- Settings cannot list vault devices until a sync knows the passphrase and vault key.
- Open: y-protocols' cursor heartbeat uses wall time. A backward clock stops idle heartbeats; peers drop the cursor after 30 s until movement or someone joining.

Tests: `packages/plugin/tests/features/presence/`.
