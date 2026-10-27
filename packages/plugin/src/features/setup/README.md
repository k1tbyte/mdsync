# Setup wizard

One modal stepper takes a fresh install to a syncing vault: storage (Cloudflare R2 from a token by default), passphrase, relay (deployed from the plugin), first sync and toggles. It replaces "configure first" toasts with a way into the right step. Constraints: `.claude/rules/settings-setup.md`.

## Entry points

- `openSetupWizard(plugin, step, onClosed)` (`features/setup/wizard.ts`), reached through `plugin.openSetup(step?)` in `main.ts`; the callback refreshes the settings tab, the Changes tab and the status bar the wizard changed under. One wizard at a time: asking again moves the open one to `step`. `closeSetupWizard()` runs on unload.
- Without a step it opens where this device stands (`firstStep` in `features/setup/step-state.ts`): no storage -> Start; otherwise the first step of the `new` path not done; else Ready. Never stored: `isStepDone` reads the settings, so the wizard agrees with the settings tab.
- Callers: a fresh install (`main.ts`: `loadData()` returned null, settings saved first so closing it does not bring it back, then on layout ready); command `open-setup-wizard` ("Set up sync", `app/commands.ts`); the **Setup wizard** button of the settings overview (`features/settings/overview.ts`); the status menu; the notice **Set up** when a sync has no storage or the saved connection cannot be read; the relay section (`ESetupStep.Relay`); the link menu and `openShareLink` without a relay (`ESetupStep.Relay`); the Changes tab prompt (`features/source-control/setup-prompt.ts`, also `ESetupStep.Import`).

## Paths and steps

`features/setup/step-state.ts` holds `ESetupStep`, `ESetupPath` and `PATH_STEPS`.

- Start (no stepper, `features/setup/steps/start-step.ts`): **Start syncing this vault** (path `new`), **Connect to a vault set up on another device** (path `join`), **Accept an invite to a shared folder** (hands off to `openInvite` of spaces, closes), **Not now**.
- `new`: Storage -> Passphrase -> Relay -> Ready. `join`: Import -> Relay -> Ready (the setup link usually brings the relay; a done step shows its summary and **Next**).
- Back walks the path; a step may undo inside itself first (`StepView.back`). **Skip** shows on the optional Relay step while it is not done. **Next** is off until the step is done and `blocksNext()` is false.

| Step | File | What it does |
|---|---|---|
| Storage | `features/setup/steps/storage-step.ts` | **Cloudflare R2** (recommended) or **Other storage**. R2: token form, then `useR2` (`features/storage/cloudflare/r2-select.ts`): bucket `mdsync-vaults` via `ensureBucket`, S3 keys derived from the token (`r2Keys`), `prefix` = vault-name slug plus a hash so two vaults on one account stay apart, active kind S3, then `testConnection`. `R2NotEnabledError` shows **Open R2** and **Try again**. A refused token (`isRefusedToken`) is forgotten so the form returns, and the new token lands in the same prefix. Warns that deleting the token in Cloudflare stops sync. Other: `backendSection` as in settings; **Continue** runs `testConnection` and blocks on failure |
| Passphrase | `features/setup/steps/passphrase-step.ts` | `passphrase.unlock()` first (a saved one just moves on), else `vaultHasKey()`: none -> new passphrase and confirm held to `weakPassphrase` ("nobody can reset it"); present -> "enter the passphrase from your other device". A wrong one (`PassphraseRotatedError`) is dropped and shown inline. Storage unreachable offers **Try again**, and **Update keys** (`openStorageRefusedModal`) when the storage refused R2 keys |
| Import | `features/setup/steps/import-step.ts` | setup link and passphrase, then `transfer.importWith(link, passphrase)`. No prompt modal and no typed `IMPORT`: the step says it replaces storage and relay settings and the button is the consent |
| Relay | `features/setup/steps/relay-step.ts`, `features/setup/steps/relay-deploy-view.ts` | see Relay below |
| Ready | `features/setup/steps/ready-step.ts` | summary rows (storage, encryption, relay); **Sync now** = `controller.refreshAndAutoSync(true)` with progress text, then conflicts or pending changes offer **Open changes**; Autosync, Real-time sync and Live editing toggles from `SETUP_FIELDS` of `features/settings/sections/automation.ts`; **Show setup link** for another device (`showSettingsTransferExport`) |

## Modules

- `features/setup/wizard.ts` - modal shell, `STEPS` table (label, icon, `create*Step`), stepper header, Back, Skip and Next footer. `Wizard` is what steps get: `redraw`, `next`, `choose(path)`, `close`, `isShowing(view)`, `isLive()`.
- `features/setup/stepper.ts`, `features/setup/choice-card.ts`, `features/setup/form.ts` (`actionRow`, `busyLine`), `features/setup/passphrase-meter.ts`, `features/setup/run-action.ts` (busy and error wrapper for every async button), `features/setup/styles/`.
- `features/setup/steps/cloudflare-token.ts` - the token form shared by the Storage and Relay steps: **Open Cloudflare** (`tokenTemplateUrl`, permissions preselected), paste, account picker when the token reaches several accounts, then `connectCloudflare`.
- Non-UI logic lives with its domain: Cloudflare login and R2 in `features/storage/cloudflare/`, deploy and update in `features/relay/deploy/` and `features/relay/update/`, `importWith` in `features/transfer/`, `unlock` and `vaultHasKey` in `PassphraseManager` (`features/sync/remote/passphrase-manager.ts`).

## Relay step

- Choices: **Deploy to my Cloudflare** (recommended), **I already have a relay** (URL and secret, **Connect** runs `testRelay`, settings saved only on success and only while that manual view is still showing), or **Skip**, which lists what stays off (instant sync, live editing, invites, share links). With a relay already set the step shows its version against the bundled one and **Update**.
- Deploy (`relayDeployView`): token form if none, then the account's workers and workers.dev subdomain (`accountRelays`). `planRelay` decides: this device's relay on the account that answers -> update in place with its secret; no relay and the default name free -> new relay with a random secret; otherwise ask. Asking offers **Update it** (type the existing relay's secret, checked with `testRelay` before deploying), **Use another token** when this device's relay is not on the account, and **Deploy new** with a name (first free `mdsync-relay-N` proposed, `relayNameError` validates).
- Progress is the `ERelayDeployStep` checklist (workers address, storage, share page files, relay code, public address) plus **Answering**, then `activateRelay` polls `/status` until `version === RELAY_VERSION`, about 3 minutes (`WAIT_MS`), then **Check again**. On success `relayUrl`, `relaySecret` are saved at upload and `realtimeSync` turns on once it answers (`useRelay`).

## Lifetime and races

- The deploy outlives the wizard: `deploying` in `features/relay/deploy/deploy-flow.ts` is module-level. A wizard closed mid-deploy leaves it running; a reopened one shows "still deploying from earlier" and attaches (`runningRelayDeploy`) instead of starting a second. The URL and secret are saved the moment the worker holds the secret (`onUploaded`), so a closed wizard never loses a live relay's secret.
- A deploy that broke off is remembered with its secret (`failedRelay`); **Try again** repeats it with that secret. It is used only while no relay is configured, so a stale secret cannot replace a working relay.
- Late results move on only from the step still on screen (`wizard.isShowing(view)`); `isLive()` guards redraws after a close. An edited token or secret is compared with what was sent before the result is applied.
- The settings tab is its own document: a wizard left in another one is hidden or went away with it, so `openSetupWizard` closes it and opens anew.

## Recovery

- No storage when sync runs: notice **Set up** (`onNoStorage` from `app/bootstrap.ts`), never a modal from a background sync.
- Saved connection unreadable (vault copied, keychain reset): notice **Set up** on layout ready; the sealed envelope is kept untouched until storage is set up again (`app/settings-envelope.ts`).
- Storage refused the keys: Passphrase step **Update keys**, or the settings storage fields for other backends. R2 keys derive from the Cloudflare token, so a rolled token needs `rekeyR2`; the saved login is replaced when it was that token.
- Relay refused or lost: the Relay step, or **Settings → MDSync → Connection → Update relay**, which opens the wizard at Relay and updates in place.

## Tests

`packages/plugin/tests/features/setup/` (`step-state`, `stepper`, `run-action`, `passphrase-meter`, `steps/relay-step`), `packages/plugin/tests/features/storage/cloudflare/`, `packages/plugin/tests/features/relay/deploy/` (fake Cloudflare: existing relay, new name, R2 not enabled, version wait), `packages/plugin/tests/features/transfer/transfer-controller.test.ts`. Real processes: `pnpm e2e:setup` (`tests/e2e/setup.ts`). Real Cloudflare is checked by hand: R2 plus a deploy over an existing relay name.
