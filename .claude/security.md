# Security, privacy and compliance

Follow Obsidian's Developer Policies and Plugin Guidelines:

- Default to local/offline operation; make network requests only when essential to the feature, with an obvious user-facing reason and documentation.
- No hidden telemetry. Optional analytics require explicit opt-in, documented clearly in README.md and settings.
- Never execute remote code, fetch and eval scripts, or auto-update plugin code outside normal releases.
- Minimize scope: read/write only what's necessary inside the vault; do not access files outside it.
- Do not collect vault contents, filenames, or personal information unless strictly necessary and explicitly consented; store or transmit vault contents only when essential and consented.
- Clearly disclose any external services used, data sent, and risks. Features requiring cloud services need explicit opt-in.
- No deceptive patterns, ads, or spammy notifications.
- Shared folders: `data.json` holds each share's key and a participant's broker token in plain text, like the storage credentials; the vault key also opens them through the space records. To presign for participants the relay keeps the owner's S3 credentials (its KV), so its operator is trusted with them. A participant with write access can delete the share's objects; history, not revocation, repairs that.
- Share links: creating one sends a rendered copy of one note, sealed on the device, to the user's own relay (disclosed in README). `data.json` keeps each link whole, its key included, so the owner can copy it again; the passphrase is never stored. A reader who ticks **Remember on this browser** keeps the derived non-extractable key and gate in that browser's IndexedDB until the link expires or is gone, never the passphrase. The relay holds ciphertext, a SHA-256 of the passphrase check, the view limit and expiry. Everything published passes `links/sanitize.ts` (no properties, comments, embedded notes or paths) and the viewer's DOMPurify; the viewer page runs under a CSP with no inline script, no `unsafe-eval` and no framing, and the key stays in the URL fragment, which in-page jumps must not replace. The relay's operator serves the viewer script, so they are trusted as the owner.
- Register and clean up all DOM, app, and interval listeners with the provided `register*` helpers so the plugin unloads safely; teardown is idempotent so reload/unload leaks nothing.
