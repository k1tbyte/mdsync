# Shared folders

**The plugin side no longer exists.** `src/share/`, the share broker storage
adapter, the share settings tab, the share modals and indicators were deleted:
the model they rested on was wrong at the root, not buggy at the edges. The
replacement is planned in [docs/spaces-and-live.md](../docs/spaces-and-live.md)
and not yet built.

What survives is `packages/relay`, and it survives because it was sound:

- The broker (`share.ts`) presigns one S3 URL per object under `shares/<id>/`.
  It holds no storage config of its own - an owner registers a share's location
  and current credentials with it. A share's relay room accepts a live share
  token, so revoking a participant also cuts their realtime access.
- `share-key.ts` is the whole security boundary. It must fail closed, and every
  change to it needs traversal tests.
- The broker presigns **DELETE** as well as GET and PUT, so any valid share
  token can remove objects under its prefix. Largely intended for a folder
  everyone may edit, but it means revocation is not a recovery mechanism.

Two things a rebuild must not repeat, both established by measurement rather
than opinion:

- Shares require S3-compatible storage; WebDAV and Google Drive cannot presign.
- A share's location (endpoint, bucket, prefix) is pinned once. Re-deriving it
  from current settings silently orphans the objects already there; only the
  credentials may be refreshed.

Presence and share indicators are not to be rebuilt as they were - the live
layer's awareness replaces them wholesale. "Sync is slow while the relay is
connected" was reported against the old code and is still undiagnosed.
