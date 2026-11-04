# Share links

Share one note by a link that opens in any browser, with an optional passphrase, view limit and expiry. The plugin renders the note, seals it on the device and uploads the ciphertext to the owner's relay, which serves the viewer (`packages/viewer/README.md`). A read-only snapshot: no accounts, no sync, not a shared folder. Constraints: `.claude/rules/links.md`, `.claude/rules/security.md`.

## Decisions

| Choice | Why |
| --- | --- |
| Render with Obsidian's `MarkdownRenderer` | Callouts, math, Mermaid, tasks and plugin blocks follow Obsidian; no viewer Markdown parser |
| Static viewer on the relay | One deploy and origin; no CORS or third-party host |
| Gate derived from the fragment | Without the fragment, the operator cannot test passphrase guesses even offline |

## Map and entry points

- `ui/`: `link-menu.ts`, `share-link-modal.ts`, `manage-links-modal.ts`, `note-link-action.ts`. File menu, Sync settings, tree badge and note header open creation or management. Missing relay opens setup. The badge remains with file indicators off; a dot marks stale, `link-2` a symlinked path.
- Fixed command ids in `packages/plugin/src/app/commands.ts`: `share-note-link`, `update-note-links`, `manage-note-links`.
- `snapshot/`: `snapshot.ts`, `sanitize.ts`, `images.ts`, `math.ts`; `publish.ts` and `link-broker.ts` publish; `shared-links.ts` and `remote.ts` trade records.

Passphrases require 8+ characters. Upload locks the modal because its result shows the passphrase once. Payload `createdAt` is snapshot time; `title` is empty when the name is hidden.

## Snapshot

Wait for images and math (5 s cap; `complete: false` warns of an unfinished preview), swap math, then sanitize:

| Rendered DOM | Snapshot result |
| --- | --- |
| `pre.frontmatter` | Removed, including secret properties |
| Internal links; `href` outside http(s), mailto, `#` | Text only |
| `a.tag` | `span.tag` |
| External `a`; `a[href^="#"]` | Kept; viewer adds external `rel`/`target`, internal ones lose both |
| Non-image or missing `.internal-embed` | Removed, counted |
| Image embed | Unwrap `img`, strip `src` and path-like `alt`; read by embed link text, inline as `data:` or drop/count |
| External `img` | Kept, `no-referrer` |
| `img` outside `data:image/` or `https://` | Removed, counted |
| `audio video iframe object embed script style button` | Removed |
| Comments | Renderer drops them; remove empty paragraphs |
| `.callout-content` | Remove `style`, keep `is-collapsed` for viewer folding |
| Guarded Mermaid | Source code block, counted; rendered SVG kept |
| `mjx-container` | MathML: patch main-window `window.MathJax.tex2chtml`, tag TeX, convert via `tex2mml`, set `data-tex`; failed conversion stays TeX in `code` |
| `data-href`, `contenteditable`, `draggable`, `on*`, `node-insert-event` | Removed; other classes and `data-*` kept |
| Task checkboxes | Disabled |

Other flat images over 300 KB become WebP at 1600 px on the long edge only if smaller; GIF/SVG stay whole. Image budgets: 1.5 MiB each, 4 MiB total data URIs.

## Flows

- Preview: `snapshot/note-text.ts` prefers open-editor text; read `takenAt` just before rendering.
- Publish: seal -> broker `PUT` -> `SharedLinks.add`. Older relays return `not_found` or omit `expires`; the latter is revoked because it ignored `ttl`. Both prompt redeployment.
- Update: at most two renders per note (with/without images) -> seal -> `PUT ?update=1` -> `published`.
- Stale: `file.stat.mtime > publishedAt` (`noteLinks`, `isStale`); pulled writes get local mtimes.

## Records and trading

`SharedLinks.sync` runs after space records in the `spaces()` bootstrap hook, with vault storage only. Writes/deletes signal other devices; `add`/`remove` request refresh via `announce`. `tradeLinks` cases:

| Case | Result |
| --- | --- |
| `removed` | Delete by name, then forget; failure retries |
| Listed, unreadable | Keep local, never overwrite |
| Not listed, `vault` = this storage | Drop, even if locally edited |
| Not listed otherwise, or local `isNewer` | Write; set `vault` to this storage |
| Remote newer | Take remote |
| Same revision, `vault` = this storage | Keep local; no empty save |
| Remote only | Add |

## Relay (`packages/relay/src/link/`)

| Route | Auth | Does |
| --- | --- | --- |
| `PUT /link/<id>` | admin | Sealed body; query `maxViews`, `ttl`, `update=1`; headers `X-Mdsync-Gate`, `X-Mdsync-Salt` (protected). Returns `{stored, size, expires}`; 400 bad settings, 413 oversized |
| `DELETE /link/<id>` | admin | Erase |
| `GET /link/<id>/status` | admin | `{views, maxViews, expires, protected, size}`; 404 gone |
| `GET /link/<id>/meta` | none | `{protected, salt}` |
| `POST /link/<id>/open` | none | `{gate}` -> bytes, `X-Mdsync-Views-Left`, `X-Mdsync-Expires`; 401 wrong gate, 429 cooldown with `Retry-After` |
| `GET /s/<id>` | none | `ASSETS` viewer shell |

SQLite blobs use 1 MiB rows (2 MB value cap); expiry alarm erases and `deleteAll` frees the file. Cooldown: 5 consecutive misses, 1 min doubling to 1 h; even correct gates wait. Keep 128 clients per link, locked clients ranked by lock end. Shell also sets `no-referrer`, `noindex, nofollow`, `nosniff`. Deploy Relay builds the viewer first; older relays lack the DO/assets.

## Tests

`packages/plugin/tests/features/links/` (real-renderer fixture, jsdom), `packages/relay/tests/link/` (concurrent opens), `pnpm e2e:links`, `pnpm e2e:links-obsidian`.

## Accepted limits

- Not DRM: readers can copy/screenshot; immediate revocation cannot take back opened content.
- Without a passphrase, a leaked full URL opens until spent/expired.
- The owner/operator serves the viewer script and could read notes; one trust domain.
- Closed tabs after a response and failed decrypts still count; one address shares a cooldown.
- No previews: sealed content, generic shell.
- Owner-authored inline styles can overlay the page; external images expose readers' IPs.
- Static until Update, rendered as the owner's Obsidian; plugin output such as Dataview can include other notes. Check the preview.
- Touches, sync rewrites and unsaved-note autosaves can falsely mark links stale.
- Random public-route ids wake DOs; only relay cost limits bound that.
- No tombstones: two devices retaining a third's removed link can restore its list entry (never traded or traded with another storage), not its payload; remove again. Lagging listings drop a stored copy until next trade; other devices list removals until refresh.
- Ended links need manual removal; another relay's links require switching back to manage.
- Markdown only; no drawings, canvases or bases.
