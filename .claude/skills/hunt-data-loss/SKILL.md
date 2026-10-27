---
name: hunt-data-loss
description: Hunt silent data loss in the MDSync sync engine - content lost, truncated, reverted, resurrected or misplaced without telling anyone, or remote deletions that reach past what the person deleted. Use when asked to audit, review or hunt bugs in packages/plugin/src/features/sync (pull, push, merge, revert, restore, rename, state persist, history GC), or when a report says files vanished, came back or differ between devices.
---

# Hunt: silent data loss

Find where the sync loses, truncates, reverts, resurrects or misplaces content without telling anyone: the bugs users find weeks later. Read `.claude/rules/sync-integrity.md`, `.claude/rules/vault-io.md` and `packages/plugin/src/features/sync/README.md` first (`.claude/rules/hunks.md`, `.claude/rules/history.md` and `.claude/rules/live.md` for those areas). Breaking a stated invariant or ignoring a platform contract is in scope; an accepted limit listed in the README or a rule is not.

## What counts

- Content lost, truncated, reverted or resurrected on any device, or published so.
- A deletion reaching past what the person deleted.
- A file left in a state nobody chose: a step name, half a write, a duplicate.
- A clean status while devices hold different content.

## Where to look

Pick an interruption, a platform contract and a sequence, then follow it to the push that publishes the damage.

- **Interruptions**: the process killed between any two awaits of a pull, push, merge, revert, restore, rename or state persist (`features/sync/apply/`, `features/sync/operations/`, `features/sync/recovery/`, `features/sync/runtime/history-service.ts`); one worker failing while others still write; a refresh racing an edit.
- **Platform**: every line of `.claude/rules/vault-io.md`, above all non-atomic writes, mobile `exists()` false on errors, case-blind disks and listings that normalize names.
- **Time**: a device offline for days while peers edit, delete, rename and revert; clock skew; coarse mtimes (FAT, exFAT) hiding a same-size edit from `unchangedSince` and the hash cache (`features/sync/scope/scanner.ts`).
- **State**: a baseline lagging the disk, a stale comparison reused (`runOperationNow` in `features/sync/runtime/operation-runner.ts`), a share moved, paused or closed mid-cycle, a journal entry outliving its space.
- **Live**: a room opening on a file the sync is writing, or half wrote; a room's save racing a pull (`features/sync/live-notes.ts`, `features/live/workspace/`).

## Proof

A finding names the trigger sequence and the code path that publishes the damage, best as a failing vitest on the shared harness in `packages/plugin/tests/helpers/`: `pairedSessions` (`packages/plugin/tests/helpers/session.ts`), `InMemoryAdapter` (`packages/plugin/tests/helpers/in-memory-adapter.ts`), `createTestControllerHost` (`packages/plugin/tests/helpers/controller.ts`), faults from `packages/plugin/tests/helpers/faults.ts` (`killNextWrite`, `failIo`), as `packages/plugin/tests/features/sync/recovery/cut-short.test.ts` kills a write part way. "Could race" without a sequence is no finding.
