# Share links

Share one note by a link that opens in any browser, with an optional passphrase, view limit and expiry. The plugin renders the note to HTML, seals it on the device and uploads the ciphertext to the owner's relay; the page a link opens is `packages/viewer` (`packages/viewer/README.md`), served by the relay. Not a shared folder (`features/spaces`): no accounts, no sync, a read-only snapshot. Constraints: `.claude/rules/links.md`.

## Decisions

| Decision | Why |
| --- | --- |
| The plugin renders the note (`MarkdownRenderer`) and uploads that HTML, sealed | callouts, math, mermaid, code, tasks and other plugins' blocks come free and follow Obsidian; the viewer needs no Markdown parser |
| Random key in the URL `#fragment`; the relay stores ciphertext | zero knowledge; the fragment never reaches a server |
| The viewer is a static package served by the relay worker (Workers Static Assets) | one deploy, one origin, no CORS, no third-party host |
| One `Link` Durable Object per link holds blob, counter, gate, expiry | the view limit must be atomic; KV is eventually consistent (a spent link could be served again) |
| A view counts when the ciphertext is served, not when the page loads | link-preview bots fetch only the shell |
| Every link has a gate derived from the fragment key (plus the passphrase), checked by the relay before it serves or updates | the id alone burns no view and yields no ciphertext; a wrong guess burns no view; without the fragment the operator cannot test a guess, even offline |
| Link records travel through the vault storage (`links/<id>.json.enc`, vault key), last writer wins, no tombstones | any device of the person can copy, update or stop a link; the link, key included, must be re-copyable |

## Format

`https://<relay>/s/<id>#<key>[/<anchor>]`: `id` 16 random bytes base64url, `key` 16 random bytes base64url, `anchor` an optional heading slug, URI-encoded (base64url has no `/`, so it cannot run into the key). Payload `{title, html, createdAt}` (`createdAt` = snapshot time; `title` is empty when **Show the note's name** is off) -> JSON -> deflate -> AES-GCM. Content key and gate are two HKDF outputs; a protected link also mixes in PBKDF2 (600k) of the trimmed passphrase and a stored salt. Defined once in `packages/protocol/src/link.ts`.

The relay knows: id, size, expiry, view limit and count, protected yes/no, salt, timings. Not the title, text or key.

## Entry points

- Note file menu **MDSync: Share link** (`features/links/ui/link-menu.ts`), command `share-note-link`; hidden for non-Markdown and Excalidraw files. Without a configured relay the item reads "(set up a relay)" and opens the setup wizard's relay step.
- Commands `update-note-links` (the active note's links) and `manage-note-links` (**Manage share links**); settings Sync tab **Share links**; menu item **Share links of this note (n)**. Ids are in `app/commands.ts` and never change.
- A `globe` badge in the file tree (`features/explorer/file-explorer-badges.ts`, shown even with file indicators off; `link-2` marks a symlinked path) and a header button on the open note (`features/links/ui/note-link-action.ts`) open the note's links; a dot marks stale.
- **Share a link** modal (`features/links/ui/share-link-modal.ts`): Expires (5 minutes to 30 days, never, or an exact date 1 minute to 365 days ahead), Views (1, 5, 25, unlimited), Passphrase (optional, 8+ characters, **Generate**), Include images, Show the note's name, and a "Left out of the link" line from the snapshot. Create is disabled until the preview exists; the modal cannot close while the upload runs, because the passphrase is shown once in the result and never stored.
- **Manage** modal (`features/links/ui/manage-links-modal.ts`): a row per link with views left (status call), expiry, **Copy link**, **Update**, **Stop sharing**. An ended link, or one made through another relay than the current one, can only be removed from the list.

## Snapshot

`features/links/snapshot/snapshot.ts` renders with `MarkdownRenderer.render` into an element attached to the document and hidden off screen (`.mdsync-link-render`, `features/links/ui/links.css`) with a throwaway `Component`; detached, callout icons stay empty. It waits until images and math settle (5 s cap; `complete: false` warns that the preview may be unfinished), swaps math, then runs `features/links/snapshot/sanitize.ts`, a DOM pass. Properties are never published: the renderer does not draw them, and `pre.frontmatter` is removed anyway.

| In the rendered DOM | Becomes |
| --- | --- |
| `pre.frontmatter` (raw YAML) | removed: it holds every property, secrets included |
| `a.internal-link` (any vault link) and any `href` that is not http(s), mailto or `#` | its text, no element |
| `a.tag` | its text in `span.tag` |
| external `a` | kept; the viewer adds `rel` and `target` |
| `a[href^="#"]` (footnotes) | kept, `target` and `rel` dropped |
| `.internal-embed` of a note, audio, video, pdf or a missing file | removed, counted |
| `.internal-embed` with an `img` (image embed) | the `img`, its `src` and path-like `alt` removed, then inlined as a `data:` URI read from the vault by the embed's link text (`features/links/snapshot/images.ts`), or dropped and counted |
| external `img` | kept (the viewer's IP goes to that host; `no-referrer` is set) |
| `img` with a `src` that is not `data:image/` or `https://` | removed, counted |
| `audio video iframe object embed script style button` (incl. copy-code buttons) | removed |
| `%%comment%%`, `<!-- -->` | dropped by the renderer, leaving an empty `<p>`: empty paragraphs removed |
| `.callout-content` with `style` (folded) | style removed; Obsidian's `is-collapsed` class stays, the viewer folds |
| `.mermaid-wrapper.is-guarded` (the vault has not allowed Mermaid) | its source as a code block, counted; a rendered `svg` is kept |
| `mjx-container` (MathJax CHTML, no TeX kept) | MathML (`features/links/snapshot/math.ts`): patches `window.MathJax.tex2chtml` (the main window's global, not `activeWindow`) while a snapshot runs, tags each node with its TeX, converts with `tex2mml`, sets `data-tex`. One MathJax cannot convert stays as TeX in `code` |
| `data-href`, `contenteditable`, `draggable`, `on*`, class `node-insert-event` | removed; other `class` and `data-*` kept |
| task checkboxes | disabled |

Images: JPEGs are always redrawn (drops EXIF and GPS); other flat images over 300 KB are re-encoded to WebP at 1600 px on the long edge when that is smaller; GIF and SVG are kept whole. Per image 1.5 MiB, total 4 MiB of data URIs, then dropped and counted.

## Flows

- **Preview**: `previewLink` reads the note (`features/links/snapshot/note-text.ts`: an open editor's text wins over the file) and takes the snapshot; `takenAt` is read just before. **Create** publishes that exact `Snapshot`.
- **Publish** (`features/links/publish.ts`): new id, key and salt, seal, `PUT /link/<id>` through `features/links/link-broker.ts` (`requestUrl`, admin header), then `SharedLinks.add`. An older relay answers `not_found`, or a creation without `expires` (it ignores `ttl`, so the link is revoked again): the error says to redeploy the relay. If the record cannot be saved the link is revoked again; if that fails too the record stays in memory for the next save.
- **Update**: render again (links of one note share at most two renders: with and without images), seal with the same id, key and passphrase (asked for a protected link), `PUT ?update=1`, then `published`. The relay keeps counter, limits and expiry, so an update never revives a spent link; a wrong passphrase is refused (403 `gate`) and cannot re-key it.
- **Stop**: `DELETE /link/<id>`, then `SharedLinks.remove`. Unreachable keeps it listed to try again.
- **Moves**: `registerLinkPaths` (`features/links/register.ts`): rename moves the stored path (also under a renamed folder), delete detaches (the links stay live and listed under Manage with no Update; a new note at that path starts clean).
- **Stale**: `file.stat.mtime > publishedAt` (`noteLinks`, `isStale`); a pulled write gets a local mtime. The list starts such a row with "Changed since it was shared."

## Records and trading

`settings.links` holds `StoredLink`s: the published `LinkRecord` (`id`, `url` with key, `path`, `showTitle`, `createdAt`, `publishedAt`, `expires` as the relay set it, `maxViews`, `salt`, `images`, `detached`, `rev`, `author`) plus local-only `vault` (storage identity last traded with) and `removed`. In the plugin data file they sit in the device-key envelope (`app/settings-envelope.ts`); in the vault storage each is sealed under the vault key.

`SharedLinks.sync` runs from the `spaces()` hook in `app/bootstrap.ts` after the space records, only with vault storage; a write or delete there signals the person's other devices. `add` and `remove` ask for a refresh (`announce`). `tradeLinks` (`features/links/remote.ts`) per local link:

| Case | Result |
| --- | --- |
| `removed` | delete the object by name (listed or not), forget; a failed delete throws and is retried |
| object listed but unreadable | keep local, never write over |
| not listed, `vault` = this storage | removed elsewhere: dropped, even if edited here |
| not listed otherwise, or local `isNewer` | write, `vault` = this storage (a copy last traded with another storage is published to this one) |
| remote newer | take remote |
| same revision, `vault` = this storage | keep local, so a trade that brought nothing saves nothing |
| listed remotely only | added |

Edits made while a trade runs are replayed onto its outcome with a fresh revision above what it took in, also those that matched nothing yet (a rename of a link the trade brings in).

## Relay (`packages/relay/src/link/`)

| Route | Auth | Does |
| --- | --- | --- |
| `PUT /link/<id>` | admin | body = sealed bytes; query `maxViews`, `ttl` (seconds on the relay's clock); headers `X-Mdsync-Gate` (required), `X-Mdsync-Salt` (protected). Creates (409 if one stands) and answers `{stored, size, expires}`; `?update=1` replaces only the blob of a standing link (404 `gone` if not, 403 `gate` on another gate). 400 bad settings, 413 over 6 MiB |
| `DELETE /link/<id>` | admin | revoke: erase everything |
| `GET /link/<id>/status` | admin | `{views, maxViews, expires, protected, size}`; 404 when gone |
| `GET /link/<id>/meta` | none | `{protected, salt}`; counts nothing |
| `POST /link/<id>/open` | none | `{gate}` (body 1 KiB max) -> sealed bytes with `X-Mdsync-Views-Left` / `X-Mdsync-Expires`; counts a view; 401 wrong gate, 429 cooldown (`Retry-After`), 404 missing, expired and spent alike |
| `GET /s/<id>` | none | viewer shell from `ASSETS` with the CSP |

- `Link` DO (SQLite, migration `v3` in `packages/relay/wrangler.toml`): blob in 1 MiB rows (a SQLite value caps at 2 MB), 6 MiB sealed in total. `open` runs in one synchronous turn: expiry, cooldown, gate, `views++`, erase when spent. An alarm at the expiry erases too and `deleteAll` frees the file.
- Cooldown per client (`CF-Connecting-IP` hashed, IPv6 reduced to its /64): 5 misses in a row, then 1 min doubling up to 1 h, even the right gate refused meanwhile; 128 clients remembered per link, a locked one ranks by when its lock ends.
- Shell headers: CSP (`default-src 'none'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src data: https:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`, `nosniff`. `open`, `meta` and `status` answer `Cache-Control: no-store`.
- Deploying: the Deploy Relay workflow builds the viewer first; an older relay lacks the `Link` DO and assets.

## Tests

`packages/plugin/tests/features/links/` (the sanitizer runs on the real renderer's output, `packages/plugin/tests/features/links/snapshot/fixtures/rendered-note.html`, under jsdom), `packages/relay/tests/link/` (in-process DO store, one-view link with concurrent opens), `pnpm e2e:links` (`wrangler dev` and headless Chrome), `pnpm e2e:links-obsidian` (a real Obsidian: menu, modal, passphrase, view count, update, stop).

## Accepted limitations

- A view limit and a passphrase deter, they are not DRM: a reader can copy or screenshot. Stopping a link is immediate, but whoever opened it keeps what they saw.
- Without a passphrase the link is the capability: a leaked full URL opens until the limit or expiry.
- The relay serves the viewer script, so a hostile operator could read a note. The operator is the owner of the deployment (one trust domain).
- A closed tab after the response, or a failed decrypt, still counts a view. Readers behind one address share a cooldown.
- No link previews: the content is sealed, the shell is generic.
- Pasted HTML with `style` attributes can position or overlay parts of the page (the CSP allows inline style attributes); the author is the link's owner. External images tell their host the reader's IP.
- The snapshot is static until **Update**, rendered as the owner's Obsidian. Other plugins' output (Dataview) is published as rendered and can include data from other notes: the preview is the check.
- "Changed since it was shared" compares file times, so a touch, a sync rewrite or an autosave of an unsaved note can show it falsely.
- Every random id asked of the public routes wakes a Durable Object; only the relay's own cost limits that.
- No remote tombstones. Known risk: two devices that each still hold a link removed on a third can bring it back as a list entry (a copy never traded, or last traded with another storage, is published to the current one). Its relay payload stays gone; remove it again. A lagging listing only drops a copy the storage still holds, and the next trade restores it. Other devices list a removed link until their next refresh.
- Ended links stay listed until someone removes them; a link made through another relay is manageable only after setting that relay again.
- Markdown notes only: drawings, canvases and bases are not offered.
