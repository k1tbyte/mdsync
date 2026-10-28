---
paths:
  - 'packages/plugin/src/core/crypto/**'
  - 'packages/plugin/src/app/settings/**'
  - 'packages/plugin/src/features/transfer/**'
  - 'packages/plugin/src/features/links/**'
  - 'packages/plugin/src/features/storage/**'
  - 'packages/relay/src/**'
  - 'packages/protocol/src/**'
---

# Security, privacy and compliance

Follows Obsidian's Developer Policies and Plugin Guidelines. Link model and limits: `features/links/README.md`.

## Policy

- No telemetry, ads or deceptive patterns. Offline by default: a request needs a feature that asks for it and a reason the user can see. Analytics, if ever, are opt-in and documented in `README.md` and settings.
- Every service the plugin reaches is listed under "Privacy and network" in `README.md` (the user's storage, their own relay, the Cloudflare API from the wizard only, one GitHub clip on demand). A new endpoint or kind of data sent updates it in the same change.
- Never execute remote code: no `eval`, `new Function`, fetched scripts, self-update. The relay the plugin deploys is the bundle built from the same commit (`packages/plugin/esbuild.relay-bundle.mjs`).
- Read and write only inside the vault. Notes, names and personal data leave the device only for a feature the user turned on (sync, shared folder, share link).
- Consent comes first: publishing a link is the Create button after a preview, deploying or updating the relay is an explicit button, stopping a link or any destructive step asks (`openConfirmModal`).

## Secrets on the device

- Secret settings live in one AES-GCM envelope under `secrets` in the plugin's data.json (`app/settings/envelope.ts`, the `SEALED` list); the other settings stay readable. A new secret field joins `SEALED` in the same change or it is written in the clear.
- One blob on purpose: storage credentials and share records (each share's key, a participant's broker token) are kept or lost together; storage without share records would read shared folders as vault files. The vault key also opens share records through the space records in the vault storage.
- The envelope's key, and the passphrase cache's, is the device key (`core/crypto/device-key.ts`) in Obsidian's SecretStorage (`mdsync-device-key`): per vault id, outside the vault, never synced, never a file. A copy of the vault folder opens nothing.
- `DeviceKey.readOrCreate` yields one key however many callers ask (a second would orphan what the first sealed); `read` never creates. The legacy `device.key` file moves into SecretStorage and is deleted.
- An envelope this device cannot open is held and written back untouched until the sealed settings change; a transient keychain failure must not destroy the credentials. The user is told once to import a setup link or set up again.
- Secrets of an earlier build found in the clear are sealed at load (`inTheClear`), not at the next change.
- Passphrase cache: `passphrase.enc` sealed with the device key, bound to the storage identity (`core/crypto/passphrase-cache.ts`); `cachePassphrase` off (`PassphraseManager.applyCachePreference`) or Forget clears it from disk (`clearCachedPassphrase`).
- A settings transfer (setup link, `features/transfer/`) is sealed under the vault passphrase and carries only what the user ticked (storage credentials, scope, automation, relay URL and secret). Never share records, links or the Cloudflare token.
- Recovery after a lost device key: a setup link from another device (storage, passphrase, relay); share records and links return from the vault storage (`spaces/`, `links/`); a guest with no vault storage needs new invites.
- The plugin's own folder is outside the sync scope (`features/sync/scope/scope.ts`), and syncing it with another tool is unsupported: the other device cannot open this device's envelope.
- Other plugins can read SecretStorage as they can read data.json: the envelope defends against copies of the folder, not against code running on the device.

## Blob envelopes

- Version byte `0x01` AES-GCM, `0x02` gzip then AES-GCM, `0x03` described (`BLOB_VERSION_DESCRIBED`): gzip-sealed like `0x02`, its plaintext a length-prefixed JSON header then a payload (`encryptDescribed`). `0x02` and `0x03` bind the version as additional data, so a relabelled blob fails; padding hides compressed length.
- `decryptBytes` refuses `0x03` on purpose: it also opens JSON, keys and links, and described content is only for file content (`features/sync/content/`). Only `decryptDescribed` opens it, and its header is validated there before anything is rebuilt.

## What the relay may see

- Ciphertext, sizes, timings, a hash of the storage identity, a device id per connection. Never file contents, names or keys: frames and presence are sealed under the space's key with the frame's place as additional data (`core/crypto/seal.ts`).
- For a shared folder with participants it keeps the owner's S3 credentials (KV) to presign and the names invited; with Google Drive it sees the refresh token. For a link: id, size, expiry, view limit and count, protected yes/no, a SHA-256 of the gate. Never title, text or key.
- The relay's operator is the owner (one trust domain, `RELAY_SECRET`) and serves the viewer script, so a hostile operator could read link notes. A relay can also withhold, replay or reorder frames (additional data binds place, not time).
- Admin checks go through `isAdmin` / `secretsEqual` (digests, constant time); an empty `RELAY_SECRET` fails closed. A link's gate is stored as a `fingerprint` hash, and the hub keeps a grant fingerprint per socket, not the token.
- The secret rides every request: a relay over plain http is refused unless local (`isCleartextRemote`).
- `packages/relay/src/share/key.ts` is the whole boundary between a participant's object name and the bucket key. It fails closed (escapes are rejected, not cleaned); every change needs traversal tests.
- A participant with write access can delete the share's objects; history, not revocation, repairs that. A link revoke is immediate.

## Share links

- Creating one sends a rendered copy of one note, sealed on the device, to the user's own relay (disclosed in `README.md`). The envelope keeps each link whole, key included; the vault storage carries it sealed under the vault key. The passphrase is never stored.

## Cleanup

- Register every DOM, app and interval listener with `registerEvent`, `registerDomEvent`, `registerInterval` or `plugin.register(...)`; a subscription that returns an unsubscribe goes through `plugin.register`. A modal removes its own listeners and timers in `onClose`.
- Teardown is idempotent, and each `onunload` step is isolated (`safely` in `main.ts`) so one throw leaves nothing running.
