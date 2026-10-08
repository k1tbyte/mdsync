# Share links

Status: built (protocol, relay, viewer, plugin), tested in-process and end to
end (`pnpm e2e:links` against `wrangler dev` and Chrome, `pnpm
e2e:links-obsidian` through a real Obsidian). Share one note by a link that opens in any
browser, with optional passphrase, view limit and expiry. Not the same as a
shared folder ([shares](shares.md)): no accounts, no sync, a read-only snapshot.

## Decisions

| Decision | Why |
| --- | --- |
| The plugin renders the note to HTML (`MarkdownRenderer`) and uploads that, sealed | callouts, math, mermaid, code, tasks and other plugins' blocks come free and keep following Obsidian; the viewer needs no markdown parser |
| End to end: random key in the URL `#fragment`, the relay stores ciphertext | same zero-knowledge as the rest; the fragment never reaches a server |
| The viewer is a static package served by the relay worker (Workers Static Assets) | one deploy, one origin, no CORS, no third-party host |
| One `Link` Durable Object per link holds blob, counter, gate, expiry | view limit must be atomic; KV is eventually consistent (a fresh blob could miss, a spent link could re-serve) |
| A view is counted when the ciphertext is served, not when the page loads | link-preview bots fetch only the shell |
| Every link has a gate derived from the fragment key (plus the passphrase when there is one), checked by the relay before it serves or updates | the id alone burns no view and yields no ciphertext; a wrong guess burns no view; operator alone cannot decrypt |
| Seal format lives in `packages/protocol` | plugin and viewer share one source of truth |
| Link list is device-local (`settings.links`) | YAGNI; the link itself (with its key) must be re-copyable |

## Link format

`https://<relay>/s/<id>#<key>[/<anchor>]`: `id` 16 random bytes base64url, `key`
16 random bytes base64url, `anchor` an optional heading slug, URI-encoded
(base64url has no `/`, so it cannot run into the key). The whole fragment stays
in the browser.

Payload: `{title, html, createdAt}` (`createdAt` is the snapshot time) -> JSON
-> deflate -> AES-GCM. Content key = HKDF(`key` [+ PBKDF2(trimmed passphrase,
salt) when protected]); AAD `link:<id>`. A second HKDF output (other `info`) is
the **gate**, with or without a passphrase; the relay stores only its hash and
compares it in constant time. A salt is stored exactly for protected links.

The relay knows: id, size, expiry, view limit and count, protected yes/no,
timings. Not the title, text or key.

## Relay (`packages/relay/src/link/`)

| Route | Auth | Does |
| --- | --- | --- |
| `PUT /link/<id>` | admin | body is the sealed bytes; query `maxViews`, `ttl` (seconds, counted on the relay's clock, so a wrong device clock cannot misdate it); headers `X-Mdsync-Gate` (required), `X-Mdsync-Salt` (protected links). Creates (409 if one stands) and answers `{expires}`; `?update=1` replaces only the blob of a standing link (404 when gone) and needs the same gate (403 `gate` otherwise, so a mistyped passphrase cannot re-key it), keeping limits, expiry and counter: an update never brings a spent link back and a creation never inherits a counter |
| `DELETE /link/<id>` | admin | revoke: `deleteAll` |
| `GET /link/<id>/status` | admin | `{views, maxViews, expires, protected, size}` for the plugin's list |
| `GET /link/<id>/meta` | none | `{protected, salt}`; counts nothing; 404 when gone |
| `POST /link/<id>/open` | none | `{gate}` (body capped at 1 KiB) -> sealed bytes, `X-Mdsync-Views-Left` when limited, `X-Mdsync-Expires` when it expires; counts a view; 401 wrong gate; 429 in cooldown; 404 for missing, expired, spent alike |
| `GET /s/<id>` | none | viewer shell from `ASSETS` |

- `Link` DO (SQLite, migration `v3` in `wrangler.toml`): blob in rows of at
  most 1 MiB (a SQLite value caps at 2 MB), total cap 6 MiB sealed. `open`
  runs in one DO turn: expiry, cooldown, gate, `views++`, delete everything
  when `views >= maxViews`. An alarm at `expiresAt` deletes too.
- Gate failures cool down the client, never the link (anyone holding only
  the id could lock the readers out otherwise): after 5 in a row from one
  client (`CF-Connecting-IP`, an IPv6 reduced to its /64, hashed) a cooldown of
  1 min, doubling, capped at 1 h, during which even the right gate is refused
  for that client. The gate is checked in the Durable Object's synchronous
  turn on a hash the worker computed, so counting stays atomic. 128 clients
  are remembered per link, the least recent first.
- Response headers on the shell: CSP `default-src 'none'; script-src 'self';
  style-src 'self'; style-src-attr 'unsafe-inline'; img-src data: https:;
  connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors
  'none'`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, `Cache-Control:
  no-store` on `open`.
- `wrangler.toml`: `[assets] directory = "../viewer/dist"`, `binding = "ASSETS"`,
  `run_worker_first` so `/hub`, `/share`, `/link`, `/auth` keep going to code.

## Viewer (`packages/viewer`)

Vanilla TS, esbuild to `dist/`. States: loading, passphrase form, content,
gone ("expired or reached its view limit"), error.

- Reads `id` and `#key`, `GET meta`, asks the passphrase if protected, `POST
  open`, decrypts with `@mdsync/protocol`, inflates (`DecompressionStream`),
  sanitizes with DOMPurify (SVG on, scripts and handlers off), injects.
- Caches the sealed blob in `sessionStorage` per id: a reload decrypts locally
  and costs no view. Views count opens, not people: another tab or browser
  spends one.
- **Remember on this browser** (passphrase form, off by default: a shared
  computer must not keep a note by accident) keeps the derived keys in
  IndexedDB (`keys.ts`, `idb-keyval`): the non-extractable AES `CryptoKey` and
  the gate, never the passphrase. Kept until the link's expiry (each visit
  erases every expired entry), or until the relay says it is gone; a kept gate
  the relay refuses is dropped.
- A passphrase is trimmed before it is stretched (`protocol`), so a pasted
  trailing space is no wrong attempt.
- CSS written once (`viewer.css` page and layout, `note.css` the note,
  `sidebar.css`), on Obsidian's variable names (`--code-keyword`, `--h2-size`,
  `--color-blue-rgb`...) so its SVG reads them and a theme could set them:
  typography, callout colour per type, Prism tokens, checkboxes, tables,
  footnotes; light and dark by `prefers-color-scheme`; print styles.
- The reading view's behaviour is the viewer's, since the snapshot carries no
  script: `sections.ts` nests the flat top-level blocks under their headings
  (footnotes stay out); a click on the heading or its chevron folds it.
  `anchors.ts` gives each heading a `#` button: it copies the link with the
  heading's slug, puts it in the address (`replaceState`, key kept) and
  scrolls there; a load or `hashchange` with an anchor jumps to it, unfolding.
  `code.ts` puts a **Copy** button on each code block. A note opening with an
  H1 equal to its name shows the name once.
- `sidebar.ts`: a column left of the note (a panel behind a menu button on a
  narrow screen) with a card (views left, expiry from `X-Mdsync-Expires`,
  **Copy as Markdown**, **Wide text** kept in `localStorage`) and `outline.ts`,
  the headings (3 or more) marking the one being read. **Wide text** only
  applies from 66rem up (below it the toggle is hidden); a paragraph holding
  only an image (`images.ts`, `lone-image`) is centered while wide.
- **Copy as Markdown** (`markdown.ts`, turndown + GFM) converts the sanitized
  page, not the author's file, so nothing the snapshot dropped can come back.
  Callouts become `> [!type]` blocks (fold kept), tasks `- [x]`, tables GFM;
  a formula is written back as TeX from `data-tex` on its `<math>` (set by the
  plugin's `math.ts`); vault images (`data:`) and drawings are left out.
- The tab icon is an inline SVG data URI in `index.html`: the CSP allows images
  from `data:` and `https:` only, so a file served by the relay would be blocked.
- Footer text only, no analytics, no external requests of its own.

## Plugin (`packages/plugin/src/links/`)

- Entry: note file menu **Share link** and command `share-note-link` (stable
  ID); hidden for non-markdown and Excalidraw files; disabled with the reason
  when no relay is set (`RELAY_TEXT["no-relay"]`).
- Modal (`ui/links/share-link-modal.ts`): **Expires** (5 minutes, 15 minutes,
  1 hour, 1 day, 7 days default, 30 days, never, or **Pick a date…** with an
  exact local date and time, 1 minute to 365 days ahead), **Views** (1, 5, 25,
  unlimited), **Passphrase**
  (optional, at least 8 characters, **Generate** uses the invite password
  generator), **Include images** (on), **Show the note's name** (on), and a
  line saying what was left out (counts from the snapshot, rerun when images
  toggle). **Create link** then shows the link and the passphrase with
  **Copy**; the passphrase is never stored, so the modal does not close while
  the link is being made.
- Snapshot (`snapshot.ts`): `MarkdownRenderer.render` into an element
  **attached** to the document (hidden off screen) with a throwaway `Component`:
  detached, callout icons stay empty `<svg>`s, which Obsidian fills on insert.
  Wait until it settles (images loaded, math rendered; 5 s cap). Then
  `sanitize.ts`, a pure DOM pass. What the renderer really emits (spike on
  Obsidian 1.13, `temp/spike-render.ts`) and what it becomes:

| In the rendered DOM | Becomes |
| --- | --- |
| `pre.frontmatter` (raw YAML, hidden by an inline style) | removed: it holds every property, secrets included |
| `a.internal-link` (any vault link, also `[x](Other.md)`) | its text (alias or `Note > Heading`), no element |
| `a.tag` (`href="#tag"`) | its text in `span.tag` |
| `a.external-link` | kept; the viewer adds `rel` and `target` |
| footnote `a[href^="#"]` | kept, its `target` and `rel` dropped |
| `span.internal-embed.markdown-embed` (the other note's whole body inlined) | removed, counted; never published |
| `span.internal-embed` that is audio, video, pdf, missing (`mod-empty-attachment`) | removed, counted |
| `span.image-embed > img[src=app://...]` | `img` with a `data:` URI read from the vault by the span's `src` link text; width kept; over 1600 px re-encoded smaller; per image 1.5 MiB, total within the cap, else dropped and counted |
| external `img` | kept (the viewer's IP goes to that host; `no-referrer` is set) |
| `%%comment%%`, `<!-- -->` | dropped by the renderer, leaving an empty `<p>`: empty paragraphs removed |
| `button.copy-code-button` | removed |
| `.callout-content[style="display: none"]` (folded) | style removed; `is-collapsed` on the callout and the viewer's CSS fold it |
| `.mermaid-wrapper.is-guarded` (the vault has not allowed Mermaid) | replaced by its source as a code block; a rendered `svg` is kept |
| `mjx-container` (MathJax CHTML: per-glyph rules in a runtime stylesheet, fonts loaded from `app://`, no TeX kept) | replaced by MathML. `math.ts` patches `window.MathJax.tex2chtml` (the main window's global; `activeWindow` is not it) while a snapshot runs, tagging each node with its TeX and display mode, then converts with `MathJax.tex2mml`. The viewer's browser draws MathML itself: no stylesheet, fonts or payload field travel. A formula MathJax cannot convert stays as its TeX in `code`. |
| `node-insert-event`, `data-href`, `dir`, `contenteditable`, `draggable`, handlers | removed; other `class` and `data-*` kept |
| task checkboxes | disabled |

Properties are never published (no option): the renderer does not draw them.

- Publish: seal (protocol), then `PUT /link/<id>` through
  `storage/adapters/link-broker.ts` (beside `share-broker.ts`, `requestUrl`,
  admin header); `relayAdmin` moves from `ui/shares/share-action.ts` to
  `settings/model.ts` beside `RelayConfig`, so links never import `ui/shares`.
  Then record `LinkRecord` (`links/record.ts`: id, url with key, path,
  showTitle, createdAt, publishedAt, expiry as the relay set it, view limit,
  salt, images, detached) in `settings.links` (device-local, never in device
  transfer). If the record cannot be saved the link is revoked again, or it
  would be live with no key here to stop it. Loading keeps any record with an
  id and a link (`parseLinkRecord` repairs the rest): a record is never dropped
  with its key. An older relay answers `not_found`: the error says to redeploy it.
- `SharedLinks` (`links/shared-links.ts`, `plugin.sharedLinks`) is the only
  writer of `settings.links`: add, remove, `published` (Update), `move`
  (rename), `detach` (the note was deleted: its links stay live and listed
  under Manage, with no Update, and a new note at that path starts clean);
  each change saves and notifies subscribers.
- Shared-note marks: `noteLinks` (`links/note-links.ts`) gives a note's
  unexpired links and `stale` (`file.stat.mtime > publishedAt`; `publishedAt`
  is taken just before the note is read, and a pulled write gets a local
  mtime). A `globe` badge in the file tree (`mdsync-published-badge`, shown
  even with file indicators off; not `link-2`, which marks a symlinked path)
  and a header button on the open note (`ui/links/note-link-action.ts`) open
  the note's links; a dot marks stale. The list starts a stale row with
  "Changed since it was shared." Command `update-note-links` updates the
  active note's links.
- Management (`ui/links/manage-links-modal.ts`, opened by the command **Manage
  share links**, the settings Sync tab's **Share links**, or the note menu's
  **Share links of this note (n)**): a row per link with views left (status
  call), expiry, **Copy link**, **Update** (re-render, same id and key,
  counter, limits and expiry kept; a protected link asks for its passphrase
  and the relay refuses one that is not the link's) and **Stop sharing** (revoke at the relay, then forget). An ended
  link, or one made through another relay than the vault's current one, can
  only be removed from the list: nothing here can stop it. A rename (of the
  note or a folder above it) updates the stored path (`plugin/links.ts`).
- `data.json` keeps the link with its key in plain text, like share keys; add
  it to the security notes.

## Steps

Each step ships green (`pnpm lint`, `typecheck`, `test`) on its own.

1. **Protocol**: `packages/protocol/src/link.ts` (keys, gate, seal, open);
   vectors, wrong key, wrong AAD, tamper.
2. **Relay**: `Link` DO, routes, admin and public auth, migration `v3`, caps,
   cooldown, alarm. Tests in-process like the hub's (`memory-sql`): one-view
   link with N concurrent opens serves exactly one, expiry, gate and
   cooldown, update keeps the counter, revoke, oversize, admin-only routes.
3. **Viewer + serving**: package, build, `[assets]`, `/s/<id>`, headers; the
   `pnpm build`, `typecheck`, `lint` and the Deploy Relay workflow build it
   first. Tested with `wrangler dev` and a fixed payload (`pnpm e2e:links`,
   a headless browser over CDP: text, passphrase, limit gone, reload costs no
   view).
4. **Spike, in a real Obsidian over CDP** (done): the table above comes from
   it. `require("obsidian")` is not reachable from the console, so the spike
   loads a two-line plugin that exposes it.
5. **Snapshot**: `sanitize.ts` with unit tests on the spike's HTML as a
   fixture (`tests/links/fixtures/rendered-note.html`; jsdom as a plugin
   devDependency, per test file; tests run in `node` by default), `images.ts`
   (budget), `math.ts` (MathML), `snapshot.ts`.
6. **Create flow**: modal, publish, copy, `settings.links`, commands, file
   menu, no-relay and old-relay messages, `styles/links.css`.
7. **Manage**: list with status, update, stop, rename tracking.
   `pnpm e2e:links-obsidian` runs the whole loop in a real Obsidian: menu,
   modal, passphrase, view count, update, stop.
8. **Docs and release**: README, `security.md`, `commands-and-settings.md`,
   `architecture.md`, `testing.md`, `CHANGELOG.md`.

Deploying: run the Deploy Relay workflow again (it builds the viewer; the
relay gains the `Link` Durable Object, migration `v3`, and static assets).

## Open checks

- `run_worker_first` array and negation syntax in wrangler ^4.131 (step 3).
- `MarkdownRenderer.render` is current for `minAppVersion` 1.13 (step 4).
- Settled in steps 1 and 2: the passphrase stretch is its own PBKDF2 (600k) in
  `packages/protocol/src/link.ts`, not the vault's `deriveKey`; a blob is
  chunked at 1 MiB and checked in workerd up to the 6 MiB cap
  (`pnpm e2e:links`); `deleteAll` then a new link on the same id works.

## Accepted limitations

- A view limit and a passphrase deter, they are not DRM: a reader can copy or
  screenshot.
- Without a passphrase the link is the capability: a leaked full URL opens
  until the limit or expiry. Revoke is immediate.
- The relay serves the viewer script, so a hostile operator could read a
  note. The operator here is the owner of the deployment (one trust domain).
- No link previews: the content is sealed, the shell is generic.
- A closed tab after the response, or a failed decrypt, still counts a view.
- A sealed note over about 3.9 MiB does not fit the tab's `sessionStorage`, so a
  reload of it spends another view.
- Pasted HTML with `style` attributes can still position or overlay parts of
  the page (the CSP allows inline style attributes for the note's own layout).
  The author is the link's owner.
- Every random id asked of the public routes wakes a Durable Object; only the
  relay's own cost limits that.
- "Changed since it was shared" compares file times, so a touch, a sync rewrite
  or an autosave after sharing an unsaved note can show it falsely.
- A heading link opened in another tab counts a view: the cache is per tab.
- The snapshot is static until **Update**; it looks as the owner's Obsidian,
  theme-independent, rendered. Other plugins' output (Dataview) is published
  as rendered, which can include data from other notes: the preview is the
  check.
- The link list is per device: another device does not list or revoke it.
- Markdown notes only: drawings, canvases and bases are not offered.
