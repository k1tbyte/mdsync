# Viewer

Browser page for a share link; vanilla TypeScript, no framework. The relay serves `src/index.html` at `GET /s/<id>` and assets under `/viewer/`. Link model: `packages/plugin/src/features/links/README.md`. Constraints: `.claude/rules/links.md`, `.claude/rules/security.md`, `.claude/rules/ui.md`.

`build.mjs` bundles `src/main.ts` and `src/viewer.css` with esbuild (minified IIFE), copying HTML to `dist/viewer/`; it runs before relay dev, deploy and bundle.

## Map

- `src/main.ts`, `src/view.ts`: visit entry and state rendering.
- `src/link/`: `session.ts`, `cache.ts`, `keys.ts`, `api.ts`.
- `src/note/`: `sanitize.ts`, `sections.ts`, `anchors.ts`, `markdown.ts`.
- `src/chrome/`: `sidebar.ts`, `topbar.ts`, `facts.ts`.

## Visit

`parseLinkLocation` rejects missing/cut-short keys. `LinkSession` checks the tab cache, otherwise fetches meta; then derives unprotected keys, tries remembered keys, or asks for a passphrase. Without cache it opens through the relay, then `openLinkPayload` decrypts/inflates. A wrong passphrase shows only as a failed open, and the form returns; 401/429 keep the form with the `Retry-After` wait. An unprotected failed gate means a damaged address.

`idb-keyval` uses database `mdsync-viewer`; each visit sweeps expired keys. No-expiry keys remain until the relay reports gone.

## Rendering

DOMPurify uses HTML/SVG/MathML profiles; additionally forbids `style`, `link`, `meta`, `base`, `srcset`; inputs become disabled checkboxes. External links get `target=_blank`, `rel="noopener noreferrer nofollow"`. Unsupported browsers show an error, never raw markup.

Sections nest flat blocks under headings, leaving footnotes outside. Heading/chevron clicks fold unless selecting text or hitting links/buttons; callout titles fold too. `reveal` unfolds ancestors. A first H1 matching the name avoids a duplicate title. The tab icon is an inline SVG data URI: the CSP allows images only from `data:` and `https:`.

## Anchors

`uniqueSlug` deduplicates Unicode letters/digits; anchors can also be element ids (footnotes). Heading `#` buttons copy and jump; load/`hashchange` unfolds the target. In-note links become full addresses so copies and new tabs work.

## Page chrome

- Sidebar becomes a menu panel below 66rem: Escape/outside click closes, Tab stays inside. Facts refresh every 30 s; outline appears with 3+ headings and tracks reading position.
- Wide text persists in `localStorage` (`mdsync-viewer-wide`), applies only from 66rem, centers lone images.
- Markdown export (turndown + GFM) keeps callout fold marks, tasks, tables and TeX from `data-tex`; omits vault `data:` images and SVG drawings.
- `src/viewer.css` imports note/chrome styles. Obsidian variable names support note SVG and themes; light/dark follows `prefers-color-scheme`, with print styles. State timers stop on abort.

## Tests

`tests/` (jsdom, `fake-indexeddb`); `pnpm e2e:links` exercises a real relay and headless Chrome.

## Accepted limits

- Views count opens, not people: closing after response or failed decrypt still costs one; another tab/browser, including heading links, spends another.
- Blocked storage or sealed notes over about 3.9 MiB prevent caching; reload spends another view.
- The tab keeps showing content after last view/expiry until closed; the card warns.
- Remembered keys trade safety for convenience until expiry; off by default to protect shared computers.
- The operator serves this script and could read notes; no defense against its own server.
- No previews: generic shell, sealed note.
