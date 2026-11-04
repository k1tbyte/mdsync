# Setup wizard

A modal stepper takes a fresh install through storage, passphrase, features, optional relay and first sync. It also joins another device's vault or hands an invite to shared folders. Constraints: `.claude/rules/settings-setup.md`, `.claude/rules/ui.md`, `.claude/rules/security.md`.

## Entry points

`openSetupWizard(plugin, step, onClosed)` in `wizard.ts` reuses the open wizard, moving to the requested step; `closeSetupWizard()` runs on unload. Closing refreshes settings, Changes and status. A wizard in another document is closed and reopened in the settings tab's document.

Without a requested step: no storage -> Start; otherwise first unfinished step on `new`, else Ready. The status menu and unreadable-connection notice also enter setup.

## Paths and steps

`step-state.ts` holds `ESetupStep`, `ESetupPath` and `PATH_STEPS`.

- Start has no stepper: create (`new`), join (`join`), invite (`openInvite`, then close), or dismiss. Join comes first on a phone, rarely the first device.
- `new`: Storage -> Passphrase -> Features -> Relay -> Ready.
- `join`: Import -> Features -> Relay -> Ready; the link usually brings the relay, so a completed step shows a summary.
- Back follows the path, allowing `StepView.back` to undo within a step first. Skip appears only for unfinished Relay. Next needs a done step and no `blocksNext()`; otherwise the step's own action advances.

| Step | File | Flow |
|---|---|---|
| Start | `steps/start-step.ts` | Choose a path or hand off an invite |
| Storage | `steps/storage-step.ts` | R2 token -> `useR2`: bucket `mdsync-vaults`, S3 configuration, connection test. Prefix combines vault slug and hash to separate vaults on one account; replacement tokens keep it. R2 not enabled offers activation and retry. Other backends reuse `backendSection`; connection failure blocks Continue |
| Passphrase | `steps/passphrase-step.ts` | Try `passphrase.unlock()`; success calls `wizard.moveOn()` unless revisiting via Back. Otherwise `vaultHasKey()` selects creation with confirmation and `weakPassphrase`, or entry of the other device's passphrase. `PassphraseRotatedError` drops the wrong value and reports inline; unreachable storage offers retry |
| Import | `steps/import-step.ts` | Link and passphrase -> `transfer.importWith(link, passphrase)` |
| Features | `steps/features-step.ts` | Always done. `feature-choices.ts` maps Manual to automation off, Automatic to autosync plus push-after-change (5 minutes if interval was 0), Instant to Automatic plus real-time sync. Push-after-change alone reads as Automatic. Reuses settings rows for history, config scope, plugin levels (without remote clearing), and live editing once enabled; joined values apply only to this device |
| Relay | `steps/relay-step.ts` | Deploy, connect an existing relay, skip, or update a configured relay; flow below |
| Ready | `steps/ready-step.ts` | First-sync preview, device summary, then completion guide |

## First sync

`steps/first-sync.ts` compares with `controller.refresh()` without moving files, then shows upload/download/conflict counts and a route to Changes. Missing results (including a cancelled passphrase prompt) offer retry, not completion. The sync action calls `controller.refreshAndAutoSync()`, the scheduled cycle; non-overlapping note edits merge, remaining conflicts wait for a choice. `quietFooter` keeps Done secondary while work remains.

Once nothing remains, `steps/done-tour.ts` locates status (desktop), Changes, tree marks and editor margins, explains sync vocabulary, and offers a setup link or a relay.

## Modules

- `wizard.ts`: shell and `Wizard` interface; `stepper.ts`: header; `passphrase-meter.ts`: strength display; `styles/`: layout.
- `steps/relay-deploy-flow.ts`: deploy state machine without DOM; `steps/relay-deploy-view.ts`: renderer.
- `steps/cloudflare-token.ts`: shared token form, permission-template link, account picker, `connectCloudflare`.
- Domain logic (relative to `packages/plugin/src/`): `features/storage/cloudflare/` (login/R2), `features/relay/deploy/` and `features/relay/update/`, `features/transfer/`, `features/sync/remote/passphrase-manager.ts`.

## Relay step

Manual connection tests URL/secret with `testRelay` and saves only on success. Deploy reads the account's workers and workers.dev subdomain (`accountRelays`), then `planRelay` chooses a plan. When it asks, the user can supply an existing secret, change token if this device's relay is on another account, or choose a validated new name (`relayNameError`).

`ERelayDeployStep` shows address, storage, share page, code and public-address progress, followed by Answering.

## Recovery

An unreadable saved connection (copied vault or reset keychain) offers setup on layout ready. Refused storage keys lead to the Passphrase step's key repair or other backends' settings fields. A lost/refused relay leads to Relay, also reached from Connection's update action.

## Accepted limits

- No one can reset a lost passphrase.
- Unresolved conflicts hold the sync. Conflicts without `baselineHash` (both sides added a file) cannot auto-merge; the preview names them and routes to Changes for a choice.
- Skipping Relay leaves instant sync, live editing, invites and share links off.
- Relay activation waits about 3 minutes (`WAIT_MS`) for the matching version, then needs Check again.

## Tests

`packages/plugin/tests/features/setup/`, `packages/plugin/tests/features/storage/cloudflare/`, `packages/plugin/tests/features/relay/deploy/`, `packages/plugin/tests/features/transfer/transfer-controller.test.ts`; `pnpm e2e:setup` (`tests/e2e/setup.ts`). Real Cloudflare remains manual: R2 and deploy over an existing relay name.
