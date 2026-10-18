# Changelog

This file is the source of truth for release notes: the section of a version becomes the notes of its GitHub release.
The newest section must match `version` in `manifest.json`. Headings are `## [x.y.z] - YYYY-MM-DD`, then `### Important`, `### Features`, `### Improvements` and `### Fixes` as needed. Write for users, in plain sentences, not commit titles.

## [1.3.0] - 2026-10-19

### Important

- Update the relay to get its fixes below. A device that keeps your Cloudflare token offers it on its own; elsewhere select **Update relay** in **Settings → MDSync → Connection**.

### Features

- **Relay updates in one click.** When the relay MDSync deployed to your Cloudflare account is older than the one this version carries, MDSync offers to update it. Its secret, shared folders and links stay.
- **New storage keys in place.** When the storage turns this device's keys away (changed, revoked or mistyped), MDSync says so and points to where to update them. With Cloudflare R2, paste the rolled API token's new value or the new secret access key, and sync goes on in the same bucket and folder.

### Improvements

- Sync asks the storage for less. The history log, pinned versions and shared folders are downloaded again only when they changed. On Google Drive, an unchanged file is checked without downloading it, and many new files upload without looking each one up first.
- Less writing to disk: the sync state is saved only when it changed, the diagnostics log once per burst of entries, and settings once you stop typing.
- Live editing draws other people's selections only on the lines in view, so a long selection stays smooth.
- Restoring, reverting, resolving and checking many large files keeps memory use in check.
- History cleanup right after a push no longer leaves unused files on the storage until a deep clean.
- The relay does less work for every live edit, and an unchanged share link page loads from the browser's cache.

### Fixes

- Auto-merge, revert and accepting the remote version no longer overwrite an edit made after the compare, and reverting a moved file undoes the whole move.
- Two devices pushing at the same moment can no longer turn one device's files into deletions.
- History cleanup no longer removes a file another device is still uploading, and a history log that fails to load is never reset.
- Renaming a file only by letter case syncs as a rename. Where the disk ignores case, two remote files that differ only by case are skipped instead of overwriting each other.
- On Windows and Android, files whose names hold a character the system refuses (such as `:` or `?`) are skipped instead of stopping the sync.
- Google Drive: rate limits are retried, a full Drive is reported as such, a file another device deleted and created again is found, and a renewed sign-in is kept, so you are not asked to sign in again.
- S3: a device clock that is off is reported as such, not as wrong keys.
- Live editing: a note whose live history outgrew the relay's limits is rebuilt on its own, or goes back to the scheduled sync instead of failing.
- The relay reports a revoked Google sign-in as such, and refuses pings from a device whose shared folder access was revoked.
- The change popup in the gutter works in popout windows.
- Gutter change marks and the live mark stay in place when switching notes.

## [1.2.0] - 2026-10-11

### Important

- Storage credentials, the relay secret, the Cloudflare token, shared folder keys, share links and the cached passphrase are encrypted with a key kept in Obsidian's keychain, outside the vault. Existing settings move over at the first launch. A copy of the vault folder (a backup, git, a cloud folder) no longer carries them: on a copied or moved vault, import a setup link from another device.

### Features

- **Setup wizard.** It opens on first install, or with **MDSync: Set up sync**, and walks through storage, passphrase, the relay and the first sync. With a Cloudflare API token it creates an R2 bucket and deploys the relay to your account from inside Obsidian. Another device joins with a setup link, and a shared folder invite can be accepted from the same window.
- **Share links on all your devices.** Links you create appear on your other devices, and any of them can copy, update or stop one. They travel through your storage, encrypted with the vault key.

### Improvements

- MDSync's settings show up in Obsidian's settings search. They are split into Connection, Sync, Interface, Maintenance and Logs pages, and your shared folders are listed on their own page.
- Log entries can be selected, and copied one by one or all at once.
- The relay test refuses a plain `http://` URL, since the relay secret is sent with every request.

## [1.1.0] - 2026-10-08

### Features

- **Share links.** Publish one note as a link that opens in any browser, with an optional passphrase, a view limit and an expiry. The note is drawn as Obsidian draws it, with an outline, folding headings, links to a heading, copyable code and a button that copies the whole note as Markdown, encrypted on your device and kept on your own relay, which cannot read it. Properties, comments, links to other notes and embedded notes are left out; images are embedded. A globe in the file tree and the note header marks shared notes, with a dot once the note changed since; click it to update the link or stop it. A reader can let their browser remember the passphrase. Redeploy the relay to use it.

### Improvements

- The passphrase settings tell the passphrase saved on this device apart from the vault passphrase, and say what each button does.
- The settings tab keeps its scroll position when it redraws.

## [1.0.0] - 2026-10-03

First release.

### Features

- **Encrypted sync over storage you own.** S3-compatible services, WebDAV or Google Drive. File contents and the file list are encrypted on your device with a key derived from your passphrase, and there is no MDSync server in between.
- **Source control view.** Local changes, remote changes and conflicts in one panel, with a diff for every file. Push or pull what you pick, revert a single local change or accept a single remote one.
- **Conflict resolution.** Changes that do not overlap are merged up front. The rest open in a three-way merge editor, or you keep one side.
- **Change marks in the editor.** The gutter shows what changed since the last sync. Click a mark to see the old text or revert that change.
- **History.** Every saved version of a note, a timeline of every push with a way to put the whole vault back to one of them, deleted files you can restore, and pinned versions kept until you unpin them.
- **Real time, through your own relay.** Your other devices pull the moment you push. Notes and Excalidraw drawings edit together, you see who has which note open, and you can follow someone through the vault. The relay is one Cloudflare Worker you deploy to your own account.
- **Shared folders.** Share a folder through an invite link and a password, read-only if you like. The other person needs no storage of their own and never sees your credentials.
- **Device transfer.** Move your setup to a new device with an encrypted link or a QR code.
