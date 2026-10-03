# Changelog

This file is the source of truth for release notes: the section of a version becomes the notes of its GitHub release.
The newest section must match `version` in `manifest.json`. Headings are `## [x.y.z] - YYYY-MM-DD`, then `### Important`, `### Features`, `### Improvements` and `### Fixes` as needed. Write for users, in plain sentences, not commit titles.

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
