# Performance review backlog

From the 2026-10-25 review swarms. Paths are under `packages/plugin/src/`.

## Pass 1 (done, uncommitted)

- [x] 1. Storage 30 s timeout also covers body transfers and is retried 4x: a large file on a slow link never syncs and leaves overlapping transfers - `storage/adapters/util.ts`, `s3-store.ts`, `webdav.ts`, `google-drive-request.ts`
- [x] 2. Signs re-diff every open note on each refresh even when the baseline is unchanged - `editor/signs/provider.ts` `broadcast`
- [x] 3. Local live cursor: two Y.Text walks on every editor update, scroll included - `live/text/remote-selections.ts` `publishLocal`
- [x] 4. `track()` reports a change for an already-ignored note: each autosave rebuilds explorer decorations - `plugin/ignore-state.ts`
- [x] 5. Diff view reloads its model on every status broadcast, immutable history versions and hidden tabs included - `ui/diff-view.ts`
- [x] 6. Conflict preview cache keeps full three-way models for 10-line previews, unbounded - `ui/source-control/conflict-preview-manager.ts`
- [x] 7. History GC reads pinned manifests serially before a push completes - `sync/history/gc.ts` `addPinnedHashes`
- [x] 8. History and Trash hold every pinned manifest at once - `sync/history/query.ts` `readPins`
- [x] 9. Integrity check skips `prepareReads`: one Drive lookup per object - `sync/maintenance.ts`
- [x] 10. Drive write priming lists the whole objects prefix for a 256+ batch - `storage/adapters/google-drive.ts`
- [x] 11. Records read with unbounded `Promise.all` - `storage/records.ts`
- [x] 12. Scanner walks the config dir twice on startup and full refresh - `vault/scanner.ts`
- [x] 18. Logs build up to 10k hidden detail rows - `settings/logs-view.ts`
- [x] 19. Extra copy of the sealed payload - `storage/adapters/link-broker.ts`
- [x] 20. Ignore-file events routed twice - `plugin/events.ts`, `plugin/ignore-state.ts`

## Later

- [ ] 13. Changes filter rebuilds the whole pane per keystroke - `ui/source-control/changes-tab.ts`
- [ ] 14. Share links modal rebuilds the whole list per status response - `ui/links/manage-links-modal.ts`
- [ ] 15. Link snapshot serializes `innerHTML` every 100 ms while waiting - `links/snapshot.ts`
- [ ] 16. Live Join answer bypasses the 250 ms awareness batcher - `live/session/session.ts`
- [ ] 17. Offline drawing edits keep every batch in the outbox - `live/session/session.ts`, `outbox.ts`
- [x] 21. Explorer, Changes and counts follow a saved file without a full refresh: `sync/runtime/saved-refresh.ts` re-hashes the saved path through a local-only opener and patches the display result; signs follow `resultRevision`, not result identity
- [ ] 22. Blob reads outside the pull path carry no size hint, so a large one keeps the 30 s deadline - `sync/maintenance.ts`, `sync/history/query.ts`, `sync/projection.ts`, `sync/operations/resolve.ts`
