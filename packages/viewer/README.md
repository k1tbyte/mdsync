# Viewer

The page a share link opens. It reads the link's id from the path and its key from the `#fragment`, asks the relay for the sealed note, decrypts it in the browser and shows it. The relay serves it: `GET /s/<id>` returns this package's `packages/viewer/src/index.html` with the security headers (`packages/relay/src/link/shell.ts`), the scripts and styles are plain assets under `/viewer/` (`packages/relay/wrangler.toml`, `[assets]`). The link model, flows and format: `packages/plugin/src/features/links/README.md`. Constraints: `.claude/rules/links.md`.

Vanilla TypeScript, no framework. `packages/viewer/build.mjs` bundles `packages/viewer/src/main.ts` and `packages/viewer/src/viewer.css` with esbuild to `dist/viewer/` (an IIFE, minified) and copies `packages/viewer/src/index.html`. `pnpm --filter mdsync-viewer run build` runs before every relay dev, deploy and bundle. Dependencies: `@mdsync/protocol` (format), DOMPurify, `idb-keyval`, turndown with its GFM plugin.

## Visit

`main.ts` parses the address with `parseLinkLocation`; a missing or cut-short key shows `invalid`. `LinkSession` (`packages/viewer/src/session.ts`) drives one visit and tells the view what to show (`ViewState`: `loading`, `passphrase`, `content`, `gone`, `invalid`, `error`):

1. `cache.get(id)` (this tab's sealed copy), else `GET /link/<id>/meta`. 404 means `gone`, and any remembered keys for the id are dropped.
2. Unprotected: derive the keys from the fragment key alone. Protected: use remembered keys if the browser has them, else show the passphrase form.
3. `POST /link/<id>/open` with the gate counts a view and returns the sealed bytes, `X-Mdsync-Views-Left` and `X-Mdsync-Expires`. Without a cached copy this is the only call that spends a view.
4. `openLinkPayload` decrypts and inflates. A wrong passphrase is only known by failing to open: the form shows again with "Wrong passphrase.". A 401 or 429 shows the wait (`Retry-After`) and keeps the form; without a passphrase a failed gate means a damaged address.

The passphrase is trimmed and normalized before it is stretched (`packages/protocol/src/link.ts`), so a pasted trailing space is no wrong attempt.

## Cache and remembered keys

- `packages/viewer/src/cache.ts`: the sealed bytes, views left and expiry in `sessionStorage` per id. A reload decrypts locally and costs no view; the key and the passphrase are never written. Storage the browser blocks, or a note past the quota, just costs a view on reload.
- `packages/viewer/src/keys.ts`: **Remember on this browser** (passphrase form, off by default: a shared computer must not keep a note by accident) stores the derived non-extractable AES `CryptoKey` and the gate in IndexedDB (`idb-keyval`, database `mdsync-viewer`), never the passphrase. It is kept until the link's expiry (each visit sweeps every expired entry) or until the relay says the link is gone. Kept keys the relay refuses are dropped. A link with no expiry keeps them until the relay says gone.

## Rendering

- `packages/viewer/src/sanitize.ts` is the only way payload HTML reaches the page: DOMPurify with HTML, SVG and MathML profiles; forms, buttons, `style`, `link`, `meta`, `base` and `srcset` forbidden; links limited to `LINK_HREF_ALLOWED` (http(s) ones get `target=_blank` and `rel="noopener noreferrer nofollow"`), images to `LINK_IMAGE_SRC_ALLOWED`, inputs to disabled checkboxes. A browser DOMPurify does not support shows an error rather than raw markup.
- The viewer's own controls (code **Copy**, heading `#`, fold chevrons) are added after sanitizing, since the snapshot carries no script.
- `packages/viewer/src/sections.ts` nests the renderer's flat blocks under their headings (footnotes stay outside every section); a click on the heading or its chevron folds it, unless text is selected or a link or button was hit. `reveal` unfolds every section and callout around an element.
- Callouts fold on a click of their title. `packages/viewer/src/code.ts` adds a **Copy** button per code block. `packages/viewer/src/images.ts` marks a paragraph holding only an image (`lone-image`).
- A note whose first element is an H1 equal to its name shows the name once; the document title is the name, or "Shared note".
- Tab icon: an inline SVG data URI in `packages/viewer/src/index.html`, since the CSP allows images from `data:` and `https:` only. The viewer itself requests only the two link routes (a note's own external images load from their hosts); the footer credit is a plain link to the project.

## Anchors

An address is `/s/<id>#<key>/<anchor>`; the anchor is a heading's slug (`uniqueSlug`: Unicode letters and digits, deduplicated) or an element id such as a footnote's.

- Each heading gets a `#` button (`packages/viewer/src/anchors.ts`): it copies the address, puts it in the bar with `history.replaceState` (key kept) and scrolls there.
- A load or `hashchange` with an anchor jumps to it, unfolding what hides it (`currentAnchor`).
- In-note `a[href^="#"]` links are rewritten to the full address: the bare `#fn-1` would replace the key, and a copy or a new tab would be dead. Clicks `preventDefault` and call the same jump.

## Page chrome

- `packages/viewer/src/sidebar.ts`: a column left of the note from 66rem; below it a panel behind a menu button (Escape or an outside click closes it, Tab stays inside while open). It holds the link card (`packages/viewer/src/facts.ts`: views left and the expiry, counting down every 30 s; a warning once the note lives only in this tab), the outline and the credit.
- `packages/viewer/src/outline.ts`: the headings as a list (three or more) that marks the one being read.
- `packages/viewer/src/topbar.ts`: name, fact chips, **Wide text** and **Copy as Markdown**. Wide text is kept in `localStorage` (`mdsync-viewer-wide`) and only applies from 66rem up (below it the toggle is hidden); a lone image is centered while wide.
- **Copy as Markdown** (`packages/viewer/src/markdown.ts`, turndown + GFM) converts the sanitized page, not the author's file, so nothing the snapshot dropped can come back. Callouts become `> [!type]` blocks (fold mark kept), tasks `- [x]`, tables GFM, a formula is written back as TeX from `data-tex` on its `<math>`; vault images (`data:`) and SVG drawings are left out.
- CSS is written once: `packages/viewer/src/viewer.css` (variables, page, layout) imports `packages/viewer/src/note.css`, `packages/viewer/src/sidebar.css`, `packages/viewer/src/topbar.css` and `packages/viewer/src/gate.css`. It uses Obsidian's variable names (`--h2-size`, `--code-keyword`, `--color-blue-rgb`...) because the note's SVG reads them and a theme could set them. Light and dark follow `prefers-color-scheme`; print styles are included.
- Every listener of a shown state is tied to its `AbortSignal` (`createView`'s `show` aborts the previous one); timers stop with it.

## Tests

`packages/viewer/tests/` under jsdom (`pnpm --filter mdsync-viewer test`; IndexedDB through `fake-indexeddb`). The page against a real relay and headless Chrome: `pnpm e2e:links` (`tests/e2e/links-viewer.ts`: text, passphrase, limit gone, reload costs no view).

## Accepted limits

- A view counts when the ciphertext is served. A closed tab after the response, or a failed decrypt, still costs one; another tab or browser spends another (views count opens, not people).
- The cache is per tab: a heading link opened in a new tab counts a view. A sealed note over about 3.9 MiB does not fit `sessionStorage`, so its reload spends another view.
- Once the last view or the expiry passes, the tab keeps showing the note until it is closed; the card says so.
- Remembering keys trades safety for convenience on that browser until the link expires; it is off by default.
- The relay's operator serves this script and could read a note; the page cannot defend against its own server (one trust domain, see the rule).
- No link previews: the shell is generic and the note is sealed.
