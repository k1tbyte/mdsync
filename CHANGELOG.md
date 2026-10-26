# Changelog

This file is the source of truth for release notes: the section of a version becomes the notes of its GitHub release.
The newest section must match `version` in `manifest.json`. Headings are `## [x.y.z] - YYYY-MM-DD`, then `### Important`, `### Features`, `### Improvements` and `### Fixes` as needed. Write for users, in plain sentences, not commit titles.

## [1.4.1] - 2026-10-27

### Improvements

- **Offline state.** Without a connection, the status bar, its menu and the Changes tab say you're offline instead of showing an error, and Push and Pull wait. History, Timeline and Deleted offer **Try again**. When the connection is back, MDSync syncs at once, or only compares when automatic sync is off.
- A shared folder whose storage can't be reached shows as offline, apart from one that failed, and automatic sync retries it on its own.
- Source control fits a phone's narrow sidebar: a long path shows its end, a chain of single subfolders takes one row in the tree, the size moves under the name and leaves the tree, and a row's menu shows the whole path.
- On a phone, a long file name in the compare header slides to its end and back, window titles wrap instead of being cut, and Push and Pull in the Changes summary sit at the bottom across its width.

### Fixes

- Turning MDSync off and on again on a phone no longer shows source control twice in the sidebar.
- In a sidebar, the bar under Push and Pull takes the sidebar's colour instead of a darker one.

## [1.4.0] - 2026-10-26

### Important

- Update the relay to get the live editing changes below. A device that keeps your Cloudflare token offers it on its own; elsewhere select **Update relay** in **Settings → MDSync → Connection**. Live notes already on the relay move to the new format at the first start.

### Features

- **A new look.** Source control, compare and merge, History, every window, the status bar, the note header, the shared note page and the settings are redrawn. On a phone, windows open as sheets from the bottom.
- **Changes tab.** A summary card shows what waits and when you last compared and pushed. Check several files to push, pull or revert them at once. The **ignored** and **not synced** counts open a list of those files, grouped by rule or reason, with **Stop ignoring**.
- **Changes as cards.** In Inline mode and on a phone, compare and merge show each change as a card: Push or Revert for a local one, Local, Remote or Both for a conflict, and every choice can be undone. Unchanged lines fold away.
- **One status bar item.** It shows where sync stands, the relay state and who is in shared notes. Select it for Push, Pull, Compare and Resolve. On a phone, **Show sync and relay status** opens the same menu.
- **Changes in the file explorer.** A changed file takes its change's colour, with a dot for your changes, an arrow for ones to pull and an alert for conflicts. Ignored and skipped files are dimmed. **Change marks beside names** in **Settings → MDSync → Interface** hides the marks and keeps the colours.
- **Following.** The note header shows whether the note is live and who has it open. **Follow** is also in the shared folder's window, and a banner under the header names who you follow, with **Stop following**. Typing no longer ends it.
- **Settings at a glance.** The settings open on cards for the storage, encryption and the relay, each with its state and the next step.
- **Source control in the phone's sidebar.** On a phone or tablet it sits in the right sidebar beside backlinks and the outline.
- **Live editing speed** in **Settings → MDSync → Sync** sends your live edits at most every 100 ms, 250 ms or 1 s. A slower speed uses less of the relay's daily limit.
- **Deletion limit.** An automatic push that would delete more than 5 files holds the deletions back for review. A push by hand still sends them. Set the limit, or turn it off with **Ask before pushing many deletions**, in **Settings → MDSync → Sync**.

### Improvements

- Compare and merge are faster on large notes.
- Large files get more time to upload and download, and saving a note updates source control without a new compare.
- The relay writes about half as much for every live edit, so the free Cloudflare plan goes further. Cursors are sent only while someone else has the note open.
- A connection lost to a network change is noticed within seconds.
- When the relay runs out of its daily writes, live editing waits and retries, and the rest keeps working.
- "Compared" and "Last push" times update every minute.

### Fixes

- On phones, pulling a deletion or a move no longer removes the folders above it with everything inside (#9).
- A file is taken as deleted only when its folder no longer lists it, so a storage that briefly loses a folder (ChromeOS shared folders) no longer turns its files into deletions.
- A write cut short (Obsidian closed, the phone out of memory) is finished at the next start instead of syncing as a half-empty note.
- A pull or merge stopped by an error keeps the files that already landed, instead of showing them as your edits.
- A note open for live editing takes pulled changes through its editor, so a pull never overwrites what is being typed.
- A moved file syncs as one move: an edit made elsewhere follows it instead of conflicting, and push, pull and revert take both paths.
- Change marks in the editor show exactly what Push and Revert move.
- Many smaller fixes under the hood.

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
