---
paths:
  - 'packages/plugin/src/features/links/**'
  - 'packages/viewer/src/**'
  - 'packages/relay/src/link/**'
  - 'packages/protocol/src/link*'
---

# Share links

Flows, snapshot table, trade cases and accepted limits: `features/links/README.md`, `packages/viewer/README.md`.

## Format and crypto

- `packages/protocol/src/link.ts` is the only definition of the seal format (plugin seals, viewer opens, relay checks the gate). Never copy it.
- Link `https://<relay>/s/<id>#<key>[/<anchor>]`: key and anchor stay in the fragment, which no server sees. Build and read it with `linkUrl` / `parseLinkLocation`, never by string concat.
- Payload JSON -> deflate -> AES-GCM, AAD `link:<id>`: a blob opens under its own id only. Inflate with a limit (`MAX_PLAINTEXT_BYTES`), deflate ratios reach 1000x.
- Content key and gate are two HKDF outputs of the fragment key (plus PBKDF2 of the trimmed NFC passphrase when protected). Every link has a gate; the relay keeps only its hash, compared in constant time, so the id alone serves and updates nothing.
- The passphrase is never stored: not in settings, records, the vault storage or the viewer. "Remember on this browser" keeps only the derived non-extractable `CryptoKey` and the gate.
- Size, views and ttl caps are `LINK_MAX_*` in the protocol; the relay enforces all, the plugin checks size (`features/links/publish.ts`) and ttl (`features/links/describe.ts`) first.

## Snapshot (plugin)

- Everything published passes `features/links/snapshot/sanitize.ts`, then the viewer's DOMPurify. Properties, comments, embedded notes, internal links and vault paths never leave the device.
- Render into an element attached to the document (`.mdsync-link-render`, off screen): detached, callout icons stay empty. Tear down in `finally`: component unload, host removal, MathJax patch restored (`untag`).
- Vault images go only as `data:` URIs: JPEGs always redrawn (drops EXIF/GPS), per-image cap `IMAGE_MAX_BYTES`, total budget; one that fails is dropped and counted, never sent raw.
- Create publishes the exact `Snapshot` the owner previewed; `publishLink` never renders again. The preview frame is `sandbox=""` under its own CSP.

## Records and trade (plugin)

- `SharedLinks` (`features/links/shared-links.ts`, `plugin.sharedLinks`) is the only writer of `settings.links`. Every local change goes through `edit`: save, notify, bump `rev` and `author` of each replaced record. Read through `all()` / `of()` (they hide `removed`) and re-read the settings object per call, an import replaces it.
- A record keeps the whole link, key included: the only way to copy or stop it. `parseStoredLink` repairs a record that still has `id` and `url`; never drop one with its key.
- `vault` and `removed` are local-only: `tradedLink` strips them, `parseTradedLink` ignores them. Links never enter a settings transfer.
- Publish: if the record cannot be saved, revoke the link again (live with no key here to stop it); if that fails too the record stays in memory for the next save.
- Revoke at the relay first, then forget; unreachable keeps it listed. Only the relay that made a link manages it (`onRelay`: same origin, no cleartext), asked per call (`adminFor`); otherwise remove from the list only.
- Update keeps id, key, counter, limits and expiry; a protected link needs its passphrase, the relay checks the gate. One update per id at a time (`updating`).
- Rename moves a note's links (`move`); delete detaches them (`detach`, `registerLinkPaths`): live and listed, no Update, a new note at that path starts clean.
- Trade only through `readRecords` / `writeRecord` / `removeRecord` (`features/storage/records.ts`): one `links/<id>.json.enc` per link, vault key, no manifest, no remote tombstones; `isNewer` (rev, then author) decides.
- A removed link is flagged `removed` first, even one never traded (any trade, a failed one too, may have written it), deleted by name (a listing lags), forgotten only after the delete succeeded.
- A copy traded with this storage that it no longer lists was removed elsewhere: drop it, even edited here (removal beats edit). An object that will not decode is never written over or dropped, unless removed here.
- `SharedLinks.sync` replays edits made during a trade (`pending`) above what the trade took in, also those that matched nothing yet. A failed trade warns and never fails the vault refresh (`app/bootstrap.ts`).

## Relay (`packages/relay/src/link/`)

- Admin routes call `isAdmin` first. `meta` and `open` are public: missing, expired and spent links all answer 404 `gone`; `open` reads at most 1 KiB of body.
- `LinkStore` is synchronous: a view is counted and a spent link erased in one Durable Object turn, so two opens never share the last view. No `await` between check and count; KV is eventually consistent, not for this.
- A view counts when `open` serves ciphertext, not when the shell loads (preview bots fetch the shell).
- Wrong gates cool down the client (hashed IP, IPv6 as /64), never the link: a per-link lockout lets anyone holding the id lock readers out.
- A creation never inherits a counter (409 if one stands). An update needs a standing link and the same gate (403 `gate`), keeps limits, expiry and counter, never revives a spent link. `ttl` is counted on the relay's clock.
- `handleShellRequest` owns the viewer headers. Never loosen the CSP: no inline script, no `unsafe-eval`, no framing; `style-src-attr 'unsafe-inline'` is the only inline allowance. Link route answers stay `no-store`.
- Only `/s/*` runs the worker first (`packages/relay/wrangler.toml`). A new Durable Object class needs a new migration tag; never edit an old one.

## Viewer (`packages/viewer/src/`)

- Payload HTML is attached only through `sanitizeNote` (DOMPurify, `LINK_HREF_ALLOWED`, `LINK_IMAGE_SRC_ALLOWED`); other payload text (the title) goes in as a text node, never as HTML. Buttons and forms are forbidden in notes; the viewer adds its own after sanitizing.
- Never set `location.hash` to a bare `#x`: it replaces the key and kills the link. In-page jumps use `linkUrl(...)` with `replaceState` (`addressOf` in `packages/viewer/src/anchors.ts`) and `preventDefault`.
- Own requests go only to the relay's link routes (`connect-src 'self'`); no analytics, no third-party assets.
- `sessionStorage` holds sealed bytes only, so a reload costs no view; keys and passphrase are never written there. Remembered keys (IndexedDB) expire with the link and are dropped when the relay says gone or refuses the gate.
- Copy as Markdown converts the sanitized page, never the author's file: nothing the snapshot dropped can come back.
- Listeners of a shown state end with its `AbortSignal`; `show` aborts the previous state.
