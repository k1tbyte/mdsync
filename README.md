# Obsync

Obsync syncs an Obsidian vault over storage you configure (S3-compatible, WebDAV or Google Drive), encrypted with a key derived from your passphrase. It compares local files with an encrypted remote manifest, then lets you push local changes, pull remote changes, and resolve conflicts from a source-control style view. With the optional relay it also pushes changes to your other devices at once, shares folders with other people, and edits shared notes live.

## Features

- Manual compare, push, and pull commands, plus optional autosync and push-after-changes.
- Source control view with local changes, remote changes, conflicts, per-file diff, and hunk actions for text files.
- S3-compatible, WebDAV and Google Drive storage with encrypted manifests and encrypted file blobs.
- File history, a deleted-files list and whole-vault restore.
- Shared folders and live editing through the relay (owning a share needs S3-compatible storage).
- Optional sync of selected Obsidian configuration categories.
- Shared `syncignore.md` rules plus device-local ignore patterns and symlink skipping.
- Encrypted setup transfer by Obsidian URL, copyable link, or QR code.
- Local-only diagnostics stored under the plugin folder in the current vault config directory.

## Storage layout

Obsync writes only inside the configured bucket and prefix:

```text
<prefix>/manifest.json.enc
<prefix>/history.json.enc
<prefix>/salt.bin
<prefix>/keys.json
<prefix>/spaces/<id>.json.enc
<prefix>/shares/<id>/...
<prefix>/objects/<sha256>.enc
<prefix>/pins/<snapshotId>.json.enc
```

`history.json.enc` is a single encrypted change log: one entry per push, each recording
only what that push added, modified or deleted relative to its parent. Reading a file's
history therefore costs one download regardless of how many snapshots are kept. Pinning a
snapshot additionally stores a full manifest under `pins/`, so a pin survives after the
snapshots between it and the current state have been pruned.

The manifest and object contents are encrypted with a key derived from your passphrase. The passphrase is not uploaded.

### History, deleted files and the timeline

The source control view has four tabs. **Changes** is the usual push/pull list,
with a path filter above it. **History** lists the open file's past versions -
click one to diff it against the working copy, or use its `⋯` menu to restore it,
compare it with the version before, or pin it under a name you choose. Restoring
always shows the exact diff first. **Timeline** lists every push to the vault with
what it changed, and can put the whole vault back to any of them.

### Restoring a deleted file

The source control view has a **Deleted** tab (also **Obsync: Restore deleted files**)
listing every file that is gone from the vault but still held by history, with when it
went, which device removed it, and how many more pushes the record survives. Restore puts
it back where it was, recreating any folders it needs; **Restore to…** writes it somewhere
else. Deletions age out with their snapshot, so pin a snapshot to keep one for good.

## Setup

1. Install the plugin files into `<Vault>/.obsidian/plugins/obsync/`.
2. Enable the plugin in Obsidian.
3. Open **Settings → Obsync**.
4. Enter the S3 endpoint, region, bucket, optional prefix, and credentials.
5. Run **Obsync: Compare with remote** and enter a passphrase when prompted (at least 12 characters).
6. Use **Push all local changes** for the first upload, or pull from an existing remote manifest.

Use a separate bucket prefix per vault. Reusing a prefix for another vault is rejected after the remote vault id is established.

Set up the first device alone, until its first sync finishes. That sync creates the vault's key; on a server that ignores conditional writes (Google Drive, some WebDAV and S3-compatible servers), two devices starting at the same moment can each create one, and files one of them encrypts become unreadable to the other.

## Ignore patterns

Obsync uses two ignore sources, both with gitignore-style syntax:

- `syncignore.md` in the vault root is the shared repository-level ignore list. A shared folder has its own in its root, with paths relative to it, shared by everyone in it; the vault's rules stop at that root, so sharing a folder copies what they kept out of it into its note.
- The **Patterns** setting under Device-local exclusions is applied only on the current device.

Shared ignore rules are synced like a normal note. Both kinds are non-destructive: a matching file stops being sent or received, but nothing is deleted, neither the remote copy nor the copies on other devices. To remove a file everywhere, delete it before ignoring it.

Examples:

```gitignore
README.md
drafts/
*.tmp
.obsidian/plugins/example-plugin/cache/
```

**Ignore symlinks** (on by default) skips symbolic links, Windows junctions and directory links. Obsidian shows them as ordinary files and folders, so without this the vault walk descends into them and offers to sync whatever lives outside the vault. Like a device-local pattern it is non-destructive: a link never reads as a local deletion of what other devices store at that path. Desktop only, since mobile has no symlinks.

Changing `syncignore.md` or the ignore settings marks the current compare result as stale and schedules a refresh when a compare has already been run.

## Commands

- **Obsync: Compare with remote** - refresh sync status and open the source control view.
- **Obsync: Push all local changes** - push all local changes after compare preflight.
- **Obsync: Pull all remote changes** - pull all remote changes after compare preflight.
- **Obsync: Open source control** - open the sync panel.
- **Obsync: Refresh sync status** - run compare only.
- **Obsync: Reset remote storage** - delete the remote Obsync manifest, file objects, version history and pins for the configured bucket prefix, then compare local files as new additions.
- **Obsync: Open diff for active file** - open the diff for the active file when it has changes.
- **Obsync: Forget cached passphrase** - clear the locally cached passphrase.
- **Obsync: Show file history** - list the open file's past versions.
- **Obsync: Restore deleted files** - list files history still holds and put them back.
- **Obsync: Verify remote integrity** - check that every object the remote manifest names exists.
- **Obsync: Deep-clean orphaned objects** - delete remote objects nothing references.
- **Obsync: Manage sharing** - open the sharing window of the open file's shared folder.
- **Obsync: Accept shared folder invite** - paste an invite link to mount a shared folder.
- **Obsync: Rebuild live note** - move the open live note's room to a fresh generation.
- **Obsync: Toggle authors in live notes** - tint text by who typed it.
- **Obsync: Show relay status** - the relay state of every space and who is in shared notes.
- **Obsync: Show live menu of this note** - the menu of the open note's live header.

## Remote reset

Use **Obsync: Reset remote storage** or **Settings → Obsync → Reset remote** only when you want to rebuild the remote sync state from this vault. The reset flow requires typing `RESET` before it runs. It deletes `manifest.json.enc`, everything under `objects/`, the change log `history.json.enc` and every pinned snapshot under `pins/`. It keeps `salt.bin` and `keys.json`, so the same passphrase-derived key remains valid.

After reset, local vault files are preserved, the local baseline is cleared, and the next source control view shows local files as additions ready to push.

## Running the relay

The relay is `packages/relay`, one Cloudflare Worker deployed to your own account — the credentials it holds are yours, and no one else's traffic passes through it. One deployment serves every optional role: realtime sync signals and live editing, the share broker that presigns requests for people you invite, and the Google Drive token exchange.

1. Fork this repository. In **Settings → Obsync → Connection → Relay server**, select **Generate** to create a relay secret; it is copied to the clipboard.
2. Add repository secrets under **Settings → Secrets and variables → Actions**: `CLOUDFLARE_API_TOKEN` (Cloudflare's *Edit Cloudflare Workers* template is enough), `CLOUDFLARE_ACCOUNT_ID` and `RELAY_SECRET`. `GDRIVE_CLIENT_ID` and `GDRIVE_CLIENT_SECRET` are only needed for your own Google Drive token exchange.
3. Run the **Deploy Relay** workflow. The first run creates the KV namespace and the Durable Object; the run summary shows the worker URL.
4. Paste that URL into **Relay server URL** and select **Test**.

The relay is one hibernating SQLite-backed Durable Object (the hub) per deployment, which stays inside the Workers free tier. If it is offline, devices fall back to periodic sync — nothing stops, since your own device holds the real credentials.

## Device transfer

Use **Settings → Obsync → Connection → Export** to create an encrypted setup link and QR code for another device. The transfer payload is intentionally compact: it includes the main sync settings such as endpoint, bucket, prefix, credentials, sync scope, device-local ignore patterns, file size limit, concurrency, autosync, and queued-push settings. It does not include the cached passphrase, passphrase cache settings, or local-only display preferences.

The transfer link is encrypted with a key derived from the current Obsync passphrase and a random transfer salt. Before encryption, the payload is minified to short keys and compressed when that actually makes the token smaller. The final URL uses the `obsidian://obsync?d=...` format. The receiving device must use the same passphrase and explicitly confirm import before the transferred settings are applied.

## Development

```bash
pnpm install
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

The plugin's source lives in `packages/plugin/src`, the relay's in `packages/relay/src`. The bundled release artifact is `packages/plugin/main.js`.

## Release checklist

1. Update `manifest.json` `minAppVersion` if the release needs a newer Obsidian API.
2. Run `npm version patch`, `npm version minor`, or `npm version major` (the `version` script updates `manifest.json` and `versions.json`).
3. Confirm `package.json`, `manifest.json`, and `versions.json` contain the new version.
4. Run `pnpm build`.
5. Create a GitHub release whose tag exactly matches `manifest.json` `version` without a leading `v`.
6. Attach `manifest.json`, `main.js`, and `styles.css` as individual release assets.

## Privacy and security

Obsync has no telemetry. Sync logs are local to the current device and are excluded from sync. Vault files and filenames are sent only to the storage backend that you configure. Plugin settings are transferred between devices only when you explicitly export an encrypted setup link or QR code.

### What each optional service can see

Obsync works with nothing but your storage bucket. The optional services below are the only other places anything goes, and all of them are the same self-hosted Cloudflare Worker (`packages/relay`).

**The relay** (optional, for instant propagation, shared folders and live editing) never sees vault file content, filenames or keys: live note edits and who is in which note travel sealed under the space's key. It does see, for each channel it carries: a hash of the storage identity; a device id per connection; and the timing of every sync and of switching notes. If you invite people to a shared folder, its broker also keeps your S3 access key and secret in its KV so it can presign requests for them, and the names you invited people by, which it shows to the others in that folder.

### Google Drive and the default auth server

Google's OAuth flow needs a client secret, which cannot ship inside a plugin. Obsync therefore performs the token exchange on a small worker. **The `Auth server URL` field defaults to `https://obsync-relay.kitbyte.workers.dev`, a worker run by this plugin's author.** With that default, your Google refresh token is sent to it on every token refresh, and it can mint access tokens for the Drive folder you granted.

Deploy your own copy of `packages/relay` and point the field at it if you would rather not rely on someone else's. It is the same worker as the realtime relay, and one deploy covers both.

Google Drive is supported on a best-effort basis: it has no conditional writes, so two devices writing the same new object at the same moment can leave two files with one name.
