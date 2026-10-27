---
paths:
  - 'packages/plugin/src/features/sync/hunks/**'
  - 'packages/plugin/src/features/sync/operations/**'
  - 'packages/plugin/src/features/diff/**'
  - 'packages/plugin/src/features/editor-signs/**'
---

# Hunks, diff views and gutter marks

A view that diffs one pair of texts while the operation recomputes from another applies the wrong hunk. Why, and the flow: `features/sync/README.md`. Engine-wide invariants: `.claude/rules/sync-integrity.md`.

## Sides and hashes

- A hunk operation takes both texts from `loadHunkSides` (`features/sync/operations/text-loaders.ts`) with the `EHunkPair` the view used: `Local` is baseline vs local, `Remote` is local vs remote (conflicts too). The projection (`features/sync/hunks/projection.ts`) builds its own sides from the same texts, its baseline through `hunkBaseline`, never `deps.state.baseline` directly.
- Every operation verifies the sha256 of each side against the `expected` hashes the view drew (`assertSidesUnchanged`); a view passes `leftHash` / `rightHash` of its `FileDiffModel`. A file edited since gets an error, never a stale index applied.
- `loadHunkSides` refuses a path outside the sync scope.

## Patch order

- Hunk and segment indices belong to one patch: `computeHunks(left, right)` in `features/sync/hunks/hunks.ts`, called with the same argument order by the view and the operation. `applyHunks` takes the right side for selected segments; keeping the left side of one means selecting the others (`complementSelection`).
- History restore numbers hunks from `computeHunks(version, current)`: `restoreHistoryHunks` (`features/sync/runtime/history-service.ts`) computes in that order, inverts the selection, and checks the working copy's sha256 against the one the view drew (`model.rightHash`).
- Push and revert of one file run in one operation (`localHunksOp`): both derive from the same baseline/local pair, so a revert cannot shift the push's indices. The result keeps the file's line endings (`withEolOf`).
- A hunk push refuses a file with a conflict or a remote change (pull first). A hunk pull advances the baseline for the path only when it takes every segment (`isFullSelection`); a partial pull's baseline would hide the left-behind segments and the next push would overwrite them.
- A diff of a moved file applies no hunks: its sides sit at two paths (`movedFrom`; `hunkHintText` in `features/diff/history-state.ts` says why). Per-hunk actions are off over `HUNK_TEXT_MAX_BYTES`, for a historical change, between two stored versions, and for a history side with no working file.

## Gutter marks

- Editor gutter marks are the push/revert segments, never a second diff: `markedChanges` (`features/editor-signs/helpers.ts`) runs `computeHunks` and `hunkSegments`, the unit `pushHunk` and `segmentRevert` act on. Blank lines make diffs ambiguous; a mark must show exactly what Push and Revert move.
- `pushHunk` (`features/editor-signs/provider.ts`) sends the baseline hash and the sha256 of the editor's current text as `expected`, so an unsaved buffer never pushes a different hunk. A revert from the popup edits the editor through `segmentRevert` (`features/editor-signs/popup/hunk-revert.ts`), whole lines out of the baseline, terminator included.

## Size and binary

- A diff view never loads unshowable content: classify each side from `adapter.stat()`, manifest entry sizes and `KNOWN_BINARY_EXTENSIONS` (`hasKnownBinaryExtension`) before reading or downloading anything (`resolveSide` in `features/sync/hunks/projection.ts`, `localSide` / `decodeRemote` in `features/sync/operations/text-loaders.ts`, `isTextMergeCandidate` in `features/sync/apply/auto-merge.ts`). Only sides that pass are sniffed for NUL bytes.
- Limits are `HUNK_TEXT_MAX_BYTES` (hunk-level actions) and `FORCE_DIFF_MAX_BYTES` (an on-demand "show anyway" diff) in `features/sync/constants.ts`; a known-binary extension is never forceable. Keep this when touching any diff or merge path.
- An absent side reads as empty text: `leftPresent` / `rightPresent` tell absent from an empty file.
- Diff work past `DIFF_BUDGET` falls back to `anchoredHunks` / `changedMiddle`, never an unbounded exact diff (the editor recomputes on every keystroke).
- The diff model cache (`features/sync/hunks/diff-cache.ts`) is bounded by entries and bytes and is keyed by change kind, path, move source and the local, remote and baseline hashes; a new key part is needed for any new input of a model.
