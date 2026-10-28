---
paths:
  - 'packages/plugin/src/features/**/ui/**'
  - 'packages/plugin/src/features/{diff,source-control,explorer,status,note-header,editor-signs,setup,settings}/**'
  - 'packages/plugin/src/core/ui/**'
  - 'packages/plugin/src/**/*.css'
---

# UI

Paths are relative to `packages/plugin/src/`. Stylesheet order, tokens and row metrics: the structure rule.

## Reuse `core/ui` (`@/core/ui`) before building

| Need | Use |
|---|---|
| a message | `notifyInfo`, `notifyError`, `notifyAction` (one button, for what a background task cannot open a modal for), `reportError`, `runWithNotice`, `attempt` (`core/ui/notices.ts`). Never `new Notice` |
| a window | `renderModalHead` + `modalSection`, `modalCard`, `modalHint`, `modalWarning`, `modalFooter` (`core/ui/modal-frame.ts`): icon tile (red `tone: "danger"` for a destructive question), footer buttons, bottom sheet on a phone (`asDrawer`). The setup wizard keeps its own layout |
| a question | `openConfirmModal`, `openChoiceModal`, `openPromptModal`, `askPassphrase`, `askNewPassphrase`; a custom modal that returns a value uses `openPromiseModal` |
| icon button, labeled button | `appendIconButton`, `appendLabeledButton` |
| clickable non-button | `makeActivatable` (role, tabindex, Enter and Space) |
| one choice of a few | `renderSegments` (native radios, locks while saving) |
| inline state, warning | `callout`, `alertLine`, `copyable`, `renderPath`, `slideWhenCut` / `measureSlide` (cut paths slide) |
| redraw keeping focus | `renderKeepingFocus`, `focusKey`, `onEnter`, `onLongPress` |
| wizard-only parts | `choiceCard`, `actionRow`, `busyLine`, `renderTokenForm` (`features/setup/`) |

When one falls short, extend it in `core/ui` instead of writing a second.

## Copy

- Sentence case for headings, buttons and titles. Short, action-oriented imperatives, no jargon, consistent words across windows (the code says `spaces`, the UI says shared folders).
- **Bold** for literal UI labels, "select" for interactions, arrow notation for navigation: **Settings → Community plugins**.
- A destructive or irreversible action says what it deletes and what it keeps, and is confirmation-gated.
- A guard on a feature says why and what to do (needs a relay, read-only, paused), never a bare disabled control.

## Tooltips

- Never set `title`: Obsidian renders its own tooltip from `aria-label`, so both would overlap. `aria-label` (or `setTooltip` on a component) is the only source, worded as one since it is also the accessible name.
- `appendIconButton` and `makeActivatable` set `aria-label`; pass the text, do not add the attribute after. A button with visible text needs none (`appendLabeledButton`).
- On a phone a mark with a tooltip shows it as a notice on tap (`features/explorer/file-explorer-badges.ts`).

## Style

- Change states use one palette per theme, not the theme's accents: `--mdsync-added`, `--mdsync-modified`, `--mdsync-deleted` (`-rgb` for tints) in `core/ui/styles/tokens.css`, for letters, chips, size deltas, explorer marks, editor change bars and diff lines. Conflicts, warnings, errors and success stay on theme colours.
- Obsidian variables and tokens first: colors `--color-*`, `--text-*`, `--background-*`; spacing, radii and fonts from Obsidian's scales. A fixed colour is only a fallback inside `var(--color-x, #hex)`, one fixed on-color text (`features/presence/ui/presence.css`), or the change-state palette.
- Class names start `mdsync-`. Obsidian's own classes (`.modal`, `.nav-file-title`, `.cm-line`) appear only as the target of an override.
- A changed file shows its change by colour and a mark (dot, arrow or warning sign); `showChangeMarks` turns only the mark off, the name keeps the colour.

## Phone

- Check `Platform.isPhone` in script, `body.is-phone` / `body.is-tablet` in css. Touch targets are at least `--mdsync-touch`; the pass is `core/ui/styles/mobile.css`, other phone rules sit beside their component.
- A view that renders differently on a phone redraws when the class changes: `redrawOnPhoneChange`.
- Windows rise as a bottom sheet (`mdsync-drawer`); while a field is typed in, the sheet scrolls whole (`is-typing`), the keyboard leaves little room.
- A row keeps one fixed height on a phone: the size goes under the name, the menu shows the whole path, a cut path shows its end.
- A phone has no hover: what lives only behind a pointer or a hover also gets a command (`show-live-status`, `show-note-live-menu` in `app/commands.ts`).
- A source-control leaf waits in the right sidebar on mobile (`keepInRightSidebar`, after onload: a reload gets its leaves back only then). Its back arrow closes the drawer and keeps the leaf.
