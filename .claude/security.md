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
- Register and clean up all DOM, app, and interval listeners with the provided `register*` helpers so the plugin unloads safely; teardown is idempotent so reload/unload leaks nothing.
