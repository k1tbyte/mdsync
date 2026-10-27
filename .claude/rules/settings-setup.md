---
paths:
  - 'packages/plugin/src/features/{settings,setup,transfer,relay}/**'
  - 'packages/plugin/src/core/settings/**'
  - 'packages/plugin/src/app/settings/**'
  - 'packages/plugin/src/features/*/settings.ts'
  - 'packages/plugin/src/app/commands.ts'
---

# Commands, settings, setup, relay deploy

Paths are relative to `packages/plugin/src/`. Wizard steps and modules: `features/setup/README.md`.

## Commands

- User commands are `addCommand` calls in `app/commands.ts` with stable ids: never rename or remove one once released. Hidden-when-unavailable commands use `checkCallback`.
- Sync is manual by default (`compare`, `push`, `pull`); autosync and push-after-change are opt-in. Push and pull run a compare preflight and surface conflicts, never choose a side silently.
- `reset-remote-storage` stays confirmation-gated (`confirmRemoteReset`, `features/sync/ui/reset-modal.ts`). It deletes `manifest.json.enc`, `objects/`, `history/`, the legacy `history.json.enc` and `pins/` under the prefix (history must not outlive its objects), keeps local files, clears local `baseline` and `vaultId`, and keeps the salt and key file so the passphrase-derived key stays valid.
- An automatic push (autosync push-after-pull, after changes settle, shares right away) publishing more than `bulkDeleteLimit` deletions (default 5) holds all of them for review with a notice; `confirmBulkDeletes` turns that off. Manual pushes are never held.

## Settings

- Every write goes through `plugin.saveSettings()`; the plugin's saved settings file is read and written, one write at a time, by `SettingsStore` (`app/settings/store.ts`) and sealed by `SettingsEnvelope` (`app/settings/envelope.ts`). A new secret field joins its `SEALED` list, or it is stored in the clear.
- `MdsyncSettings` is declared in `core/settings/model.ts` (`CoreSettings`: defaults `DEFAULT_CORE_SETTINGS`, bounds `NUMERIC_BOUNDS`, `mergeCoreSettings`). A field typed by a feature is added by that feature through module augmentation of `@/core/settings`, next to its parser: `storageConfigs`, `activeStorageKind` (`features/storage/settings.ts`), `spaces` (`features/spaces/record.ts`), `links` (`features/links/record.ts`). `mergeSettings` and `DEFAULT_SETTINGS` (`app/settings/index.ts`) compose them; a new parsed field joins there, or `tsc` fails. A value from a file or token is clamped by its parser. A removed setting goes in `RETIRED_KEYS` (secrets are deleted, not kept).
- Selectors live with their owner: `activeStorage`, `isStorageConfigured` (storage), `canSync`, `isGuest` (sync), `ownerStorage`, `relayAdmin` (spaces), `isRelayConfigured` (core). A transfer re-parses only what it carries (`mergeTransferredSettings`).
- Rows are declarative fields (`fieldRow`, `group`, `checkRow`, `renderDefinitions`, `EFieldKind` in `core/settings/fields.ts`). Text that applies on typing goes through `onSettled` (a relay URL typed letter by letter must not open a socket per prefix); closing the tab flushes it (`settleTyping`). A scope-affecting field sets `refreshScope`.
- Sections belong to the feature they configure (`links/ui`, `relay/ui`, `spaces/ui`, `sync/ui`, `sync/scope`, `transfer/ui`, `storage/ui`); `features/settings/sections/` holds only cross-cutting ones, and `features/settings/tab.ts` orders them.
- Never transferred (not in `TRANSFER_FIELDS`): `cloudflareToken`, `cloudflareAccountId`, `liveSendMs`, `showChangeMarks`, `showLiveAuthors`, `cachePassphrase`, `spaces`, `links`, the cached passphrase. Also never published to the vault storage: `useSharedFolders`, `pausedSpaces`, `pauseArrivingShares`, `localRoots`; `spaces` and `links` are traded sealed through it.
- Logs are device-local in `<configDir>/plugins/mdsync/logs.json` (`core/logs/store.ts`), under the plugin folder `ScopePolicy` never syncs.
- Config categories (core settings, hotkeys, plugin list, plugins, snippets, themes) are per device, default off. A disabled category is invisible: nothing scanned, diffed, pulled or published, and the remote keeps what other devices synced. Turning one off never deletes anything.
- **Clear on remote** is the only way to remove a category from the remote: it bumps `resetGenerations` so every device forgets that category's baseline instead of reading deletions (`features/sync/operations/config-reset.ts`). Local files stay, enabled devices re-upload, it is confirmation-gated, and it stamps the current manifest version so older clients refuse the cleared remote.

## Device transfer (`features/transfer/`)

- `TRANSFER_FIELDS` in `features/transfer/transfer.ts` is an allowlist: a setting not listed there is not exported. Payload uses short keys, omits default-valued fields, deflates only when that is smaller.
- Import needs the same passphrase and explicit consent: the import modal asks for typed `IMPORT` after listing the sections it replaces (`importedSections`); the wizard's `importWith` has the passphrase typed beside the link and its button is the consent, with the step saying what it replaces.
- An imported section replaces every field in it: one left default on the other device resets here. In the wizard import the passphrase becomes this device's only when the link carried storage; without storage it opens nothing here.

## Setup wizard (`features/setup/`)

- Which steps are done is computed (`isStepDone`, `firstStep` in `features/setup/step-state.ts`), never stored, so the wizard cannot disagree with the settings tab. A fresh install (`loadData()` returned null) saves settings first, then opens it on layout ready, so closing it does not bring it back.
- Other entries open it through `plugin.openSetup(step?)`: command `open-setup-wizard`, settings, the Changes tab prompt, the relay section, the link menu without a relay. A background sync without storage shows a notice with **Set up** (`onNoStorage`), never a modal.
- Consent before action: nothing irreversible (R2 bucket, relay deploy, import over settings, replacing a relay) runs without a button that says what it does. A relay that is not this device's, or whose secret is unknown, is updated only after the user types its secret or picks a new name.
- Late results: an async step moves on only while its view is still on screen (`wizard.isShowing(view)`; `isLive()` for a closed wizard), and rechecks before saving settings, since a reopened wizard may hold other input. Async buttons use `runAction` (`features/setup/run-action.ts`); the storage step ignores Back while a connect runs (it would apply to the choice left behind).
- Add a step as `create*Step` in `steps/` plus a `STEPS` entry in `features/setup/wizard.ts`; reuse `choiceCard`, `actionRow`, `busyLine`, `renderTokenForm`.

## Relay deploy and update (`features/relay/`, `features/storage/cloudflare/`)

- The deployed secret is saved the moment the worker holds it (`onUploaded` in `features/relay/deploy/deploy-flow.ts`), not when the wizard closes: closing mid-deploy must not lose a live relay's secret.
- One deploy at a time, module-level and outliving the wizard: a reopened wizard attaches (`runningRelayDeploy`) instead of starting a second. A deploy whose answer was lost is remembered (`failedRelay`) and retried with its own secret, only while no relay is configured (a stale secret must not replace a working relay).
- `planRelay` updates in place only when this device's relay is on the account and answers; a silent relay proves nothing (another device may have changed its secret). A new relay takes `RELAY_NAME` or the first free `mdsync-relay-N`; an existing relay keeps its KV namespace (a new one orphans every share token).
- `activateRelay` is one shared wait that survives a closed wizard, stops on unload (`plugin.unloaded`), and turns `realtimeSync` on once the relay answers with this plugin's build (`useRelay`).
- Relay versions are `<release>+<hash>`: `relayBehind` never offers a downgrade and never redeploys an unchanged relay. `mdsync:relay-bundle` is imported only inside `features/relay/deploy/`.
- Update offer (`features/relay/update/relay-update.ts`): once per relay per launch, on hub connect, when this device's token reaches the relay's account. **Not now** holds until a newer build ships (`mdsync-relay-update-skipped`). State is read at use: a forgotten token, a switched relay or an edited, untested secret must not deploy (it would lock other devices out).
- The Cloudflare token is verified before it is kept (`connectCloudflare`); one that R2 refuses is forgotten so the token form returns (`isRefusedToken`). R2 keys derive from it: deleting it stops sync, so the wizard says so; `rekeyR2` and the storage-refused modal repair it.
