# Spaces, shares and live editing

How shared folders and live editing are built, and why. The rules that keep
data safe are in [sync invariants](sync-invariants.md); open work is in
[docs/spaces-and-live.md](../docs/spaces-and-live.md).

## Decisions

| Decision | Why |
| --- | --- |
| The relay stores and fans out ciphertext and never merges | zero-knowledge; hibernation has nothing to lose |
| The relay is never the source of truth, for data or config | losing its Durable Object loses only an unsaved live tail |
| No accounts: a person is a vault (storage + passphrase), their bucket is their control plane | serverless, no third-party service |
| A space is the unit of sync; the vault and a share run one engine | one history, one live path, no parallel share cycle |
| Every path belongs to exactly one space; a share's data lives once | two writers on one path corrupt it |
| A share mounts itself on all of a person's devices; pause is per device | otherwise the folder freezes: out of the vault, not in the share |
| Leaving, closing or revocation never deletes files | they return to that person's vault |
| One socket per relay with channels in slots; one hub object per deployment | fewer sockets, handshakes and wake-ups; one `RELAY_SECRET` is one trust domain |
| Owning a share needs S3-compatible storage | WebDAV and Google Drive cannot presign |
| No integration with the Relay plugin | paid past 3 participants, closed control plane; its MIT code may be borrowed with its header and a `NOTICE` |

## Identity

A **person** is a vault's owner (`owner` on the hub) or a broker token's
`participantId`; a **device** syncing that vault is the person's, anything
else joins by invite. Attribution, presence and revocation work per person. A
participant is named as the owner invited them (`personName`); the owner shows
as "Owner".

## Spaces and records

| | root | key | storage | hub grant |
| --- | --- | --- | --- | --- |
| vault | `/` minus share roots | vault data key | bucket root | `deriveChannelGrant(RELAY_SECRET, channel)` |
| own share | a folder | share key | `<prefix>/shares/<id>/` | same |
| joined share | own folder | share key | broker, presigned URLs | share token |

- Records (`settings.spaces`, `spaces/record.ts`) are published one object each
  as `<prefix>/spaces/<id>.json.enc` under the vault key, so concurrent adds
  never race; one record edited on two devices is LWW (`rev`, then author).
  Never in `manifest.json.enc`: `state.json` keeps the manifest in plain text.
  A record is re-read only when its listing etag differs from the etag of the
  bytes last read (`listWithEtags`, cached per storage and key in
  `spaces/remote.ts`; one it just published, or one that will not decode, is
  read again next cycle): a quiet cycle is one list and no GETs. A backend
  that lists no etags reads every record.
- A share's location (endpoint, bucket, prefix) is pinned once: re-deriving it
  from current settings orphans its objects. Credentials never enter a record;
  each owner device uses its vault's current S3 credentials.
- Device-local, never published: `pausedSpaces`, `pauseArrivingShares`,
  `localRoots` (a move not yet followed here).
- Every space ignores by its own `syncignore.md` in its root, rules relative to
  it (`vault/ignore.ts`); the vault's rules stop at a share's root. **Share
  folder** first writes one exact rule per path the vault's rules kept out, or
  those files would reach every participant. Device-local patterns apply
  everywhere.
- Roots never overlap; nested shares and re-sharing someone else's are refused;
  only the owner invites. Two offline devices sharing one folder: the lower id
  wins, the other record is inert.
- The broker lets a participant into `shares/<id>/` only (`share/key.ts`); vault
  GC lists only `objects/` and `pins/`. Keep both so.
- A participant's pull signs its objects in batches: `pullPaths` hints the
  object keys (`prepareReads`), and the broker adapter asks
  `POST /share/sign {op: "get", keys}` for the next `SIGN_BATCH_MAX` (32) when
  the first is needed (`share-read-urls.ts`), falling back to one sign per
  object on any failure (an older relay refuses batches: one wasted request,
  then single signs until the next pull). The relay checks the token once, derives one signing
  key, and one bad key refuses the whole batch. Pushes are not batched.
  Measurements: [share-pull-measurements.md](../docs/share-pull-measurements.md).

## Lifecycle

- **Share folder** writes the record; the next refresh publishes and pushes it,
  and the push's signal wakes the owner's other devices, which mount it.
- **Invite** registers the share's location with the broker, remembers that
  relay in the owner's record (`access.relayUrl`), issues one token per person
  and seals `{id, name, key, relayUrl, token, participantId,
  personName, readOnly}` under a 60-bit password (`sealLink`), sent apart.
- **Accept** needs a new or empty folder (a full one would ship its files into
  someone else's share). A link to a share already here replaces its access
  in place: same folder and baseline, since the broker's storage identity is
  `broker|<id>`, not the relay. That is the way back after a re-invite or a
  move of the owner's relay; the owner's share window names the old relay.
- **Move** is a record edit; the person's other devices move the folder. Paths
  inside the share and docIds do not change.
- **A root gone on one device** detaches that device; it never deletes for all.
- **Stop sharing / Leave** tombstone the record; the folder returns to the vault.
  Stop sharing then deletes `shares/<id>/` through the operation queue, so no
  refresh mounts the share again meanwhile; a failure only leaves orphans.
  Leave revokes the participant's own token at the broker (`DELETE
  /share/token`), never one issued after it; an unreachable relay does not
  stop the leave. Stop sharing from a vault whose relay is not the one the
  invites went through warns that their tokens live on there.

## Relay hub

- One `Hub` Durable Object per deployment. `/hub?c=<channel>&t=<grant>&…&d=<device>`
  opens up to 32 slots; the worker checks every grant before waking it. The
  vault's channel is `sha256(storageIdentity)`, so the relay never sees the
  endpoint or bucket. An owner grant is `<expiry>.<HMAC(secret,
  "<expiry>:<channel>")>`, minted per connection for a day; the relay refuses
  one expired or minted over a day further ahead. A socket outlives its grant. A read-only share token follows documents but never
  writes: each write is answered `Refused(ReadOnly)`. It never signals (the
  hub drops it, HTTP answers 403: it would only wake everyone into a sync),
  and its awareness runs under a ceiling (5 a second, bursts of 20, 4 KB).
- Per-socket state (slot -> channel, grant fingerprint, `who`, `name`) lives
  in the 16 KB WebSocket attachment, not in tags (at most 10). `name` is the
  label the owner invited a participant by, from the broker token, cut to 64
  UTF-16 units so its UTF-8 fits a frame's one-byte text length.
- `JOIN {from, who, name}` goes to the channel as a socket arrives; before
  it, the newcomer gets `HERE` with the same fields for everyone already on
  that channel, since presence is never stored.
- `ping` is auto-answered without waking the object; while sockets exist, an
  alarm every half window (37 s of 75) closes those silent past the window and announces `LEAVE` once.
- A share token is live while its participant's pointer names it
  (`share/kv.ts`): two re-invites at once leave one live token, not an
  orphan no revoke finds.
- Revocation: broker -> `dropGrant` -> `REVOKED(slot)`; other slots live on, a
  socket with none left closes with 4001. The client retries a refused socket
  six times (a fresh share token can be refused for a minute while KV catches
  up) and then reads `unauthorized` until the settings change or the device
  wakes (`online`, page visible); its backoff is jittered and restarts on the
  first message, not on open. The hub keeps a revoked fingerprint 5 minutes
  (`hub/revoked.ts`) and refuses it on connect, while KV may still let it in.
- Storage is SQLite per `(channel, doc)`, both tables WITHOUT ROWID: an update
  writes its delta row only (the head is the last seq, or the snapshot's when
  compaction left none), the document row (snapshot, forwarding pointer, log
  name) changes on compaction and rotation. Ending a share deletes its rows
  (`purgeChannel`) and shuts the channel for good (`closed`). A frame is at most 1 MiB; live notes are
  markdown up to 256 KB, so a snapshot fits one frame and one row.
- A room row created again gets a new log name, sent in `STATE`: a client
  that sees another name, or a head behind what it knows, rotates the note on.
- A frame past 1 MiB, a document past a socket's 64, or a write from a
  read-only grant is answered `Refused{reason}` to its sender only; that note
  stays with the file sync until it is closed, and its status says why.

## Protocol (`packages/protocol`)

Frames are `[type][slot][docLen][doc][body]`. Choices that would cost three
places to change later:

- The echo is the ack; unacked updates are resent after a reconnect (Yjs
  updates are idempotent).
- `SUB` carries `since`: a reconnect gets the tail, not the whole state.
- `LEAVE` drops a socket's awareness at once, without y-protocols' 30 s timeout.
- docId = HMAC(docId key, path inside the space root + `#` + generation), 16
  bytes: every mount of a share meets in one room.
- `MOVED` / `ROTATE` carry the target docId: rename and rebuild are one
  operation. A rename adds a note of the new path, sealed, which the hub
  keeps with the pointer.
- Frame and docId keys come from the space key by HKDF, derived when the
  envelope is unwrapped (the content key is not extractable).
- A sealed payload names what it is for as AES-GCM additional data
  (`doc:<docId>`, `awareness:<docId>`, `moved:<docId>`, `presence`): the relay
  cannot move a frame into another document or kind. A rotation is sealed for
  its target, a rename note for the room it left.
- Edits and cursors batch for 250 ms: at 100 ms the envelope outweighed them.

## Live layer

- While a session lives its Y.Doc is authoritative for the note; live never
  writes the file, the view that owns it does.
- Text is LF before the CRDT and the hash, a lone CR included (CodeMirror
  breaks lines on it), through one normaliser (`utils/eol.ts`).
- The merge base is the note's agreed text (per docId, in the plugin folder),
  falling back to the cold baseline; the baseline as the main base duplicated
  lines not yet pushed. A note whose folder just became a share has no share
  baseline yet: the base is the vault's frozen entry. A real conflict keeps
  both sides, the room's first, and lines both open or close with come once
  (git's zealous merge), since two inserts at one spot often share them.
- A note reopened while its last session is still closing opens once that
  one's `Unsub` is out (`live/closing.ts`): after the new `Sub` it would drop
  the socket's subscription.
- Live document types are chosen by frontmatter, not suffix
  (`excalidraw-plugin: parsed` also sits in plain `.md`): a drawing goes live
  only in the Excalidraw view, never as text.
- Each kind is a `LiveModel` behind one session (`live/model.ts`): a note is one
  Y.Text, a drawing a Y.Map of whole elements settled by Excalidraw's own rule
  (`live/drawing/`). `live/editors.ts` pairs each with the view that edits it.
- A drawing binds through the Excalidraw plugin's undocumented `excalidrawAPI`
  and `window.ExcalidrawLib` (checked against 2.x). `onChange` pushes elements
  whose version moved into a staging map; the session drains it into the room
  once per 250 ms batch (`LiveSession.stage`, also on dispose, `absorb`, a
  rebuild and detach; `settled` is false meanwhile), because `mergeUpdates`
  keeps every overwritten frame of a stroke. Remote elements come in through
  `reconcileElements` and `updateScene` with `captureUpdate: NEVER`, so undo
  stays local; only the event's `keysChanged` are reconciled (the whole room
  after an event missed while the view did not `holds` its file). Y.Map settles
  concurrent sets by client id, so the element a view kept goes back into the
  map; an edit made over a newer version is bumped past it. The room holds
  copies: Excalidraw mutates elements in place.
- Drawing pointers travel in awareness as scene coordinates from `pointermove`,
  one per animation frame (the API has no `onPointerUpdate`), and render as
  Excalidraw collaborators.
  The view loads its API after `file-open`, so binding retries every 500 ms.
- A view switched to another file names it a moment before it shows its
  scene (`excalidrawData.file` lags `file`): a binding reads, takes and gives
  elements only while the view `holds` its file, or one drawing pours into the
  other's room.
- The editor binding is a Compartment over the undocumented `editor.cm`, as
  Peerdraft and Relay do.
- Undo in a live note is the room's `Y.UndoManager` on every path: the
  keymap, `beforeinput` history inputs (Edit menu, system gestures) and
  `editor.undo()`/`redo()` (the phone toolbar), routed while bound.
  Obsidian's own history would revert what others typed.
- A write under an open note (git, another sync) needs nothing from live:
  Obsidian merges it three-way with the editor, and the binding carries the
  change. Excalidraw drops the first write after its own save as that save's
  (2.27), so the file sync clears the flag first (`letWriteIn`).
- A drawing view that reloads replaces its `excalidrawAPI`; its binding then
  asks for a new one (`stale`).
- A room silent 15 s after its `SUB` leaves the note to the file sync, as a
  dead hub does; if it answers later, the session merges in like a reopen.
- A note renamed with its room open takes the room along (`live/rename.ts`,
  spotted by its TFile's new path): the room rotates into the new path's
  first generation with no room, probed by `SUB`, since readers step past
  every pointer; meanwhile the note counts as joining, so the file sync
  waits. A device in the room renames its file (`vault.rename`: the
  links are the renamer's edits, and they sync) and follows with the merge
  base. A device that never joined steps past as a new note. Concurrent
  renames settle on the one the hub took first.
- The lowest writer's client id compacts once 200 deltas pile up; **Rebuild
  live note** sheds tombstones (a note's document reached 3x its text after an
  hour).
- A read-only person's text note follows its room (`live/follower-session.ts`):
  it sends only `Sub`, `Unsub` and `Awareness`, never seeds, rotates or
  compacts. It joins only when the disk is the room's text, the agreed text or
  the cold baseline, since the bound view shows the room over it. A change
  made there, an incoming version the room lacks, an empty room or a lost log
  leave the note to the file sync until it closes, or until the share turns
  writable. The view saves the room's text, a pending local change until the
  writers' push of it is pulled. Drawings stay cold for readers.
- Attribution is advisory: each client names its own client id in `users`, in
  the ciphertext, so a client may type under another's key. Checking it
  against the hub's `who` needs signatures, since compaction snapshots come
  from clients; only the names shown for present people are the relay's. Deletions name no
  one: a Yjs delete set carries no client, and tracking it would keep the
  tombstones Rebuild sheds.

## Presence

- Each device announces `{key, name, note, idle}` on every space channel it
  holds, sealed whole with that space's frame key: a device with no note of a
  share open still sees who is in which one, and the relay sees no names or
  paths. `note` is the path inside the root, so each mount maps it onto its own.
- A client can seal any name, not the `who` the hub vouches for its socket
  (`JOIN`/`HERE`): an announcement shows only from a vouched socket whose key
  is its `who`, and a participant under their invited label (the owner's
  sockets may carry any key: the vault's devices). The author tint names a
  present person by it; one who left, by their own `users` entry.
- The key groups and colours: the person in a share, the device in the vault
  (one person). One colour per key everywhere (`shared/colors.ts`): cursors,
  author tint, avatars. Hex, so awareness sends no tint: y-codemirror derives
  it as `color + "33"`, as the author tint does.
- A file counts only while a tab shows it (Obsidian keeps naming a closed one
  active); away after 5 minutes without input in any window, popouts
  included, or with every window hidden.
- The header menu's "follow cursor" reads the doc awareness `user.key`
  (`live/text/cursors.ts` `watchCursor`): it watches edits too, since a
  relative cursor moves without a new awareness state, and scrolls a frame
  later, since y-codemirror changes awareness inside an editor update. It
  ends once the view shows another note or the room closes (the doc's
  `destroy`): their offsets would land in another text.
- Each manifest entry names its publisher: `by` indexes the manifest's
  `authors` (`{key, name}`: the person in a share, the device in the vault).
  The table only grows, so an unchanged entry stays byte-identical; the merged
  UI result drops it, each space indexing its own.
- A live note marks others' cursors on its scrollbar (`live/scroll-marks.ts`);
  a tick scrolls there, never follows.
- A read-only share's notes take no typing (`editor/read-only.ts`: CodeMirror
  `editable`/`readOnly` by the editor's file), with a lock in the note header.
  Its drawings stay in Excalidraw's view mode, set again if switched off; only
  views put there by the lock are let out.
- The tree's "new" dot: a pull (or auto-merge) that lands content another key
  published, past the space's first sync, marks those share files unseen on
  this device (`presence/unseen.ts`, vault localStorage) unless active; opening
  clears it, renames and deletions follow.
- `People` caches its per-space and per-note views and drops them at every
  change of what a channel knows (`ChannelPresence`'s `onEntriesChange`, a
  refresh, dispose); the returned lists are shared, never edited.
  `SpaceRecords.partition()` is memoized on the identity of `settings.spaces`,
  `pausedSpaces` and `localRoots`: replace those fields, never edit them in
  place, or every reader sees the old partition.
- The tree paints two layers (`ui/explorer/row-decorator.ts`): change, link and
  ignored marks, rebuilt only when the diff, links, partition or ignore state
  changed, and the presence layer (share badges, people, unseen), recomputed
  per pass. A people event repaints only the rows whose marks changed.

## Accepted limitations

- Every share owner is the key `owner` named "Owner": two shares of different
  owners show them alike. A remote cursor moves only while its window has
  focus (y-codemirror), so "follow cursor" goes where they last were there.
- The read-only lock is the editor's: Properties, renames and other plugins
  still change files there, which then wait unpushed as before. A note moved
  into a read-only root while open locks on reopening. A drawing locks once
  its view loaded (up to 500 ms), and scripts can still edit it.
- A writer that started from a file older than the editor's last save (a
  stale checkout) replaces what came between: Obsidian merges against that
  save, and nothing knows the writer's base. Git or another sync writing under
  an open drawing after its save is still dropped by Excalidraw.
- A session that seeded a room learns the log's name from its next `STATE`: a
  log lost before that shows only once the head falls behind.
- A rename leaves the room where it is when another note's room holds the new
  path or the room stays busy for 10 s: the others type on in the old room and
  the sync ends with both files, as before. So does a device that opens a
  stale copy of the old path before its file sync caught up.
- A note whose folder becomes a share leaves its vault room in the hub (rooms
  are never trimmed); other devices type there until the record's signal moves
  them, then fold those edits into the share's room.
- Excalidraw colours a drawing's pointers itself, from the person's key, so
  they do not match that person's avatar.
- The "new" dot knows only what this device pulled: a file changed and seen
  on another of the same person's devices is still new here. Deletions mark
  nothing.
- The vault's device list needs the vault key: until a sync knows the
  passphrase, settings say so instead of listing devices.
- Revocation is not automatic: a broker `unauthorized` stays the share's error
  and the participant leaves or opens a new link. The broker's KV is eventually consistent (~60 s,
  negative answers cached): a fresh token can look revoked. For the same reason
  People may lag an invite or revoke, and a hub `REVOKED` only mutes that slot.
- Re-inviting recognises a person by name, case-insensitively: one name is one
  participant, a renamed person is a new one, an unnamed invite is always new.
- `reset-remote-storage` leaves `shares/` and `spaces/`: resetting the vault does
  not end shares others depend on.
- Mounting over one's own copy: identical files converge; an edit made before
  the record arrived is a conflict with no base in the share.
- The vault drops a share folder's frozen entries at its next push, so they
  stop holding the folder's blobs (`sync/foreign.ts`); history keeps them until
  it rolls off. Until that push the vault lists them. A device whose refresh
  read the records just before the share was created, or that skipped the
  share's whole open period and first refreshes after Stop sharing before the
  owner pushes the folder back, reads them as deletions of unchanged files;
  the share or the owner's push brings them back. A share kept paused while
  it is edited and closed gives that device conflicts, not a clean pull.
- Closing where the folder is gone returns an empty root: entries the vault
  still lists (no vault push since the share opened) read as deletions (files
  edited since give a conflict). A share empties only by closing; deleting
  every file also hits `SpaceGoneError`.
- A root move rehashes the moved files once, deletes the vault's frozen copy at
  the old path on the next push if one is still listed (history keeps it), and
  two offline moves converge by LWW (the loser moves again).
- A failed share is retried on every refresh (one broker request), not backed
  off; an explicit operation on its paths shows its error, which the scheduler
  does not count.
- A read-only participant's local changes in the share stay pending: auto-push
  skips them, an explicit push holding any of them is refused, **Revert this
  file** drops them.
- Records belong to the vault storage they were traded with
  (`settings.spacesVault`): pointed at another vault, a device drops them
  rather than publish share keys into it, and their folders stay as plain files.
  It says so and forgets its state of them, so back at the first vault they
  mount afresh; a folder moved elsewhere meanwhile stays behind as vault
  content. Credentials are not the location: new keys to the same bucket keep
  every owned share.
- A folder moved outside Obsidian, or while it was closed, is a vanished root
  (`SpaceGoneError`) plus new vault content. A rename in Obsidian cancels the
  running operation, so a pull stops writing under the old path.
- An owner device resends its S3 credentials to the broker hourly after a good
  compare: another device's older keys lose within the hour once deleted.
- A closed share's `syncignore.md` stays as a plain file: the vault's rules
  govern the folder again. A read-only participant ignores only on their device.
- A new own share restarts the vault's socket, so live sessions resubscribe.
- A participant's other devices hear of an accepted share by signal only with
  a relay of their own.
- The manifest caches (`validators`, `publishedHeads`) live as long as their
  storage adapter; a share's root is in its adapter memo, so a new root is a
  new adapter.
- Grants ride in the hub URL: a browser WebSocket cannot send
  `Authorization`, and `Sec-WebSocket-Protocol` would be logged unredacted,
  while Cloudflare's logs redact hex and base64 ids in URLs by heuristics. A
  leaked owner grant admits for up to a day.
- The relay can still withhold, replay or reorder a document's frames:
  additional data binds a frame to where it belongs, not to when.
- The broker presigns DELETE too: a writer can remove a share's objects;
  history, not revocation, repairs that. `share/key.ts` is the whole boundary:
  it fails closed, and every change needs traversal tests.
