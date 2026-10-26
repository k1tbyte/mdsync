# Platform contracts

What Obsidian's `DataAdapter` really does, read from the 1.14.5 app bundle (desktop `FileSystemAdapter`, mobile `CapacitorAdapter` over Capacitor Filesystem). Code that writes, renames or deletes vault files must hold under every line here. The bundle is proprietary: read it outside the repo, never copy it in.

- **Writes are not atomic.** `write` and `writeBinary` truncate, then write, everywhere: a write cut short leaves a prefix or an empty file. Mobile writes 5 MiB and up as an empty write plus 1 MiB appends, and a failed append deletes the file. No write creates a missing parent folder. See `sync/journal.ts`, `vault/atomic-write.ts`.
- **Rename checks, then renames.** Desktop takes a new case of a name only when it knows its disk is case-blind; mobile never knows, so it refuses every name `exists()` calls taken, the file's own other casing included ("Destination file already exists!"), before touching the disk. See `renameCaseSafe`.
- **`rmdir(path, false)` is no "only if empty".** Mobile always recurses, desktop removes nothing. See `removeEmptyDir`.
- **Mobile `exists()` is false on any error** (permissions, I/O), not only for a missing path: never decide a deletion or an overwrite on it alone.
- **`stat` is null only for a missing path** (ENOENT) and throws on any other error, on both platforms: the way to tell missing from unreadable.
- **Listings lie at the edges.** Desktop `list` rejects a whole folder when one child's stat fails. Mobile `list` turns U+00A0 and U+202F into a plain space and NFC-normalizes, so a listed name may not be the name on disk.
- **Events fire inside the call.** An adapter call's vault events run before its promise resolves: code awaiting the call sees its own events first.
- **Case sensitivity is per disk, not per OS.** Windows, macOS and Android shared storage are case-blind; iOS and Android app-private storage are case-sensitive; Linux depends on the mount. `caseInsensitiveDisk()` only guesses by OS.
- **Local trash** (`.trash`): a taken name gets a number from 2; mobile lowercases the extension.
- **ChromeOS** runs the Android app: no sign of transient ENOENT was found.
