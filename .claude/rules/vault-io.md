---
paths:
  - 'packages/plugin/src/core/vault/**'
  - 'packages/plugin/src/features/sync/**'
  - 'packages/plugin/src/features/live/workspace/**'
  - 'packages/plugin/src/features/spaces/share-moves.ts'
---

# Vault I/O and platform contracts

What Obsidian's `DataAdapter` really does, read from the 1.14.5 app bundle (desktop `FileSystemAdapter`, mobile `CapacitorAdapter` over Capacitor Filesystem). Code that writes, renames or deletes vault files holds under every line here. The bundle is proprietary: read it outside the repo, never copy it in. Wrappers live in `core/vault/` (`packages/plugin/src/core/vault/io.ts`); use them, never the raw adapter call. Engine consequences: `.claude/rules/sync-integrity.md`; the journal's flow: `features/sync/README.md`.

## Writes

- Writes are not atomic: `write` and `writeBinary` truncate, then write, everywhere, so a write cut short leaves a prefix or an empty file. Mobile writes 5 MiB and up as an empty write plus 1 MiB appends, and a failed append deletes the file. Engine content writes go through the journal (`features/sync/recovery/journal.ts`); the plugin's own state files through `writeAtomic` (`core/vault/atomic-write.ts`: `.new` temp file and `.bak` backup, never missing).
- No write creates a missing parent folder: `writeBinary` ensures the parent (`ensureDir`), and retries once only when a cached "folder exists" proves stale. `ensureParent` before any other write.
- Every reader of a file `writeAtomic` wrote also tries `.new` and `.bak` (`loadState` in `features/sync/state.ts`, `WriteJournal.load`); state nobody can parse is kept as `state.json.unreadable` before a fresh one is written, and a journal whose read throws stops the plugin loading.
- A name the disk refuses is never written (`diskRefuses`: Windows and Android refuse U+0000-U+001F, DEL and `\/:*?"<>|`): `writeBinary` throws. Windows would put `a:b.md` in a hidden stream, Android fails with `FILE_NOTCREATED`.
- Events fire inside the call: an adapter call's vault events run before its promise resolves, so code awaiting the call sees its own events first.

## Existence, stat and listings

- Mobile `exists()` is false on any error (permissions, I/O), not only for a missing path: never decide a deletion or an overwrite on it alone.
- `stat` is null only for a missing path (ENOENT) and throws on any other error, on both platforms: the way to tell missing from unreadable (`staged` in the journal, `folderStays` in `features/sync/recovery/cut-short.ts`).
- `unchangedSince(adapter, path, seen)` guards every overwrite or delete of a file the engine did not just write: a later edit must not be lost. Coarse mtimes (FAT, exFAT) can hide a same-size edit from it and from the hash cache.
- Listings lie at the edges: desktop `list` rejects a whole folder when one child's stat fails; mobile `list` turns U+00A0 and U+202F into a plain space and NFC-normalizes, so a listed name may not be the name on disk. A failed listing is "unknown" (`safeList` in `features/sync/scope/scanner.ts`), never "empty".
- A deletion the engine mirrors counts only when the file is gone afterwards (`deletePath` rethrows while `exists`); a person's deletion of work maybe only here goes to the trash (`trashPath`: system trash, else `.trash`).

## Folders

- `rmdir(path, false)` is no "only if empty": mobile always recurses, desktop removes nothing. Remove a folder only through `removeEmptyDir` (list, then `rmdir(path, true)`); relying on the flag wiped every folder above a pulled deletion or move on phones.
- Empty folders are listed by the scanner only for candidates the index shows empty (the index hides dotfiles, so a folder holding only a `.DS_Store` looks empty); `emptyFolders` holds the ones the listing confirms.
- A share's root folder is moved only by `createMoveFollower` (`features/spaces/share-moves.ts`) and `renameInVault`; `following` marks the follower's own rename events.

## Renames and case

- Rename checks, then renames: desktop takes a new case of a name only when it knows its disk is case-blind; mobile never knows, so it refuses every name `exists()` calls taken, the file's own other casing included ("Destination file already exists!"), before touching the disk.
- Every rename route goes through `renameCaseSafe` (`renameInVault` in `core/vault/file-index.ts`, `renameLocal` in `features/sync/apply/pull-moves.ts`): a recasing steps through a free `<name>.mdsync-recase<n>.<ext>` name (extension kept so a view stays open), tries the target, and puts the file back when the target is taken. Return false means the move did not happen.
- A put-back that fails too throws `StrandedRenameError` ("rename it back"); the pull stops there. Anything that follows renames (live rooms, views) asks `isRecaseStep(path)` and ignores a step in flight.
- `caseInsensitiveDisk()` only guesses by OS. Case sensitivity is per disk: Windows, macOS and Android shared storage are case-blind; iOS and Android app-private storage are case-sensitive; Linux depends on the mount. Never rely on the guess for safety: two remote spellings of one path are skipped as `case-clash` where it says blind (`features/sync/changes/remote-names.ts`).
- `.trash` (local trash): a taken name gets a number from 2; mobile lowercases the extension. ChromeOS runs the Android app: no sign of transient ENOENT was found.

## Symlinks and Node

- Symlinks and junctions look like folders to Obsidian but belong to one machine: the scope skips them like device-local ignores (`createSymlinkDetector` in `core/vault/symlinks.ts`), so they are never pushed or read as deletions. Mobile has no Node, so detection is a no-op there.
- `node:fs` is loaded once, lazily, through `import("node:fs")` in `loadNodeFs`, desktop only, before any detector (detection is synchronous). Never `require` it, never import it statically.
