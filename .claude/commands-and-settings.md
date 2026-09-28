# Commands, settings and UI copy

## Commands

- Add user-facing commands via `this.addCommand(...)` with stable IDs; never rename once released.
- Sync flow is manual: `compare`, `push`, `pull`. Push/pull run a compare preflight and must surface conflicts instead of choosing a side silently.
- The `reset-remote-storage` command is destructive and must remain confirmation-gated. It deletes `manifest.json.enc`, `objects/`, `history.json.enc`, and `pins/` in the configured remote prefix (history must not outlive the objects it references), preserves local vault files, clears local `baseline`/`vaultId`, and keeps `salt.bin` and `keys.json` so the current passphrase-derived key remains valid.
- **Share folder** (folder menu, S3 only) makes the folder a space of its own under `<prefix>/shares/<id>/` with its own key, opens its window and pushes it there meanwhile. The owner's other devices mount it on their next refresh. The vault keeps the folder's last state frozen.
- **The share's window** (**Manage sharing** in a share root's folder menu, its badge in the file explorer, **Manage** in the settings, command `manage-shared-folder` for the open file's share) holds everything about one share: who is here now (presence; a person in a note opens it), who has access with **Revoke** (owner, with the relay), the invite form, **Pause/Resume on this device**, **Stop sharing** / **Leave**.
- **Invite** (the share's window, owner, needs the relay) registers the share's storage with the relay's broker, issues a token for one person and shows an `obsidian://obsync-share` link with a generated password to send separately. Opening the link asks for the password and a new or empty folder (default `Shared/<name>`), then pulls the share there. The participant never holds storage credentials. A **Read-only** invite is pulled but never auto-pushed; the broker refuses a manual push. Inviting the same name again (any case) replaces that person's link.
- **Shared folders** (settings, Sync tab) lists this person's open shares, each with **Manage**, so a share whose folder is gone here can still be closed. **Stop sharing** (owner; ends every token at the broker) or **Leave** (participant) closes the record on all of the person's devices; the folder's files stay and sync with the vault again. **Pause/Resume on this device** stops syncing the share on this device only; the folder stays out of the vault meanwhile. After a refresh in which an owned share compared fine, the device sends its current S3 credentials to the broker again when they changed, so rotated keys reach participants without a new invite. Renaming a shared folder (or a folder above it) in Obsidian moves it on the person's other devices too, each at its next refresh; where the new path is taken the share keeps syncing at the old one, with a notice. A move into another shared folder or a hidden one is renamed back.
- `rebuild-live-note` is available only for the active note bound to a live room. It moves the room into its next generation from the current text, shedding the edit history; attribution survives.
- Presence: each open note's header shows whether it is live (and why not) and who else has it open, as coloured rings with their initial; tapping it lists them with **go to cursor**. The file explorer marks share roots by kind with a headcount of people in its notes, and people on the notes they have open (a collapsed folder gathers them); the desktop status bar shows the relay state and who is in shared notes.
- `toggle-live-authors` tints, in every live editor, the text people other than this one typed, in their colour, with their name on hover; this app session only. Names are the ones the owner invited people by (the owner is "Owner"); in the vault everything is this person's, so nothing is tinted. Attribution is advisory: each client names its own edits.

## Settings

- Provide a settings tab with sensible defaults and validation; persist via `this.loadData()` / `this.saveData()`.
- Device transfer exports only the main sync settings as a compact `obsidian://obsync?d=...` URL/QR. The payload uses short field names, omits default-valued fields, and may compress before encryption when that makes the token smaller. Never include the cached passphrase, passphrase cache settings, or local-only display preferences. Import requires the same passphrase and explicit confirmation.
- Local diagnostics are stored only on the current device in `<configDir>/plugins/obsync/logs.json` and surfaced in the second tab of the plugin settings. They must stay excluded from sync.
- Configuration categories (core settings, hotkeys, plugin list, plugins, snippets, themes) are per device and default to off. A disabled category is invisible to that device: nothing is scanned, diffed, pulled or published for it, and the remote keeps whatever other devices synced. Turning a category off never deletes anything anywhere. Obsync's own plugin folder is never synced.
- **Clear on remote** beside a category is the only way to remove a category from the remote. It bumps that category's reset generation so every device forgets its baseline for it instead of reading the removal as deletions; local files stay everywhere, and enabled devices re-upload on their next push. Confirmation-gated.

## UI copy

- Sentence case for headings, buttons, and titles.
- Clear, action-oriented imperatives in step-by-step copy; keep in-app strings short, consistent, free of jargon.
- **Bold** for literal UI labels; prefer "select" for interactions.
- Arrow notation for navigation: **Settings → Community plugins**.

## Tooltips

- Never set the `title` attribute. Obsidian already renders its own tooltip from
  `aria-label`, so a `title` beside one produces two overlapping tooltips.
  `aria-label` is the only tooltip source; write it to read as one, since it is
  also the accessible name.
- `appendIconButton` and `makeActivatable` set `aria-label` for you - pass the
  text you want shown rather than adding an attribute afterwards.
- A button with visible text needs no `aria-label`: the text already names it,
  and adding one only duplicates it in a hover bubble (`appendLabeledButton`).
