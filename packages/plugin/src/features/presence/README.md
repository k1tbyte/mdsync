# Presence

Who is where: each device announces the note it shows on every space channel it holds, and the plugin turns those into avatars in the note header, people in the file tree and share window, cursor following and the tree's "new" dot. Constraints: `.claude/rules/presence.md`; the channel and its frames: `.claude/rules/realtime.md`.

## Map

| File | Holds |
|---|---|
| `announcement.ts` | the sealed payload `{key, name, device, note, idle}` |
| `channel.ts` | one space channel's entries, shown only from sockets the hub vouches for |
| `people.ts` | per-space, per-note and per-device views over all channels, cached until a channel changes |
| `views.ts` | grouping and sorting people for display |
| `here.ts` | the active file and idleness of this device |
| `unseen.ts`, `register.ts` | files others changed that this device has not opened, kept in vault localStorage; open, rename and delete hooks |
| `follow/` | following a person: the controller, scrolling to their cursor, the banner |
| `ui/avatars.ts`, `ui/presence.css` | avatars and stacks; header, lock and following styles |

Keys and identity per space come from `features/spaces/space-access.ts`, shared with live editing. The note header itself is `features/note-header/`, the tree marks `features/explorer/`, the relay dot and menus `features/status/`.

## Model

- The key groups people: the person in a share (their devices share a key), the device in the vault (one person). One colour per key everywhere.
- `note` is the path inside the space root, so each mount of a share maps it onto its own folder. A device with no note of a share open still sees who is in which.
- A person's entry lists their devices ("Owner · Laptop, Phone"); each cursor carries its own device name.
- Manifest entries name their publisher (`by` into the manifest's `authors`), which the explorer and history show as last editor; the table only grows, so unchanged entries stay byte-identical.

## Accepted limitations

- Every share owner is the key `owner`: two shares of unnamed owners show them alike.
- A remote cursor moves only while its window has focus (y-codemirror), so following goes where they last were there.
- The read-only lock is the editor's: Properties, renames and other plugins still change files there, which then wait unpushed. A note moved into a read-only root while open locks on reopening; a drawing locks once its view loaded (up to 500 ms), and scripts can still edit it.
- The "new" dot knows only what this device pulled: a file seen on another of the same person's devices is still new here. Deletions mark nothing.
- The vault's device list needs the vault key: until a sync knows the passphrase, settings say so instead of listing devices.
- Open: the cursor heartbeat is y-protocols' own, timed by the wall clock. Set back, an idle device sends none and others drop its cursor after 30 s until it moves or someone joins.
