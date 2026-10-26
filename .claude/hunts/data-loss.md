# Hunt: silent data loss

Find where the sync loses, truncates, reverts, resurrects or misplaces content without telling anyone: the bugs users find weeks later. Read `AGENTS.md`, `.claude/sync-invariants.md` and `.claude/platform-contracts.md` first. Breaking a stated invariant or ignoring a platform contract is in scope; an accepted limit listed there is not.

## What counts

- Content lost, truncated, reverted or resurrected on any device, or published so.
- A deletion reaching past what the person deleted.
- A file left in a state nobody chose: a step name, half a write, a duplicate.
- A clean status while devices hold different content.

## Where to look

Pick an interruption, a platform contract and a sequence, then follow it to the push that publishes the damage.

- **Interruptions**: the process killed between any two awaits of a pull, push, merge, revert, restore, rename or state persist; one worker failing while others still write; a refresh racing an edit.
- **Platform**: every line of the platform contracts, above all non-atomic writes, mobile `exists()` false on errors, case-blind disks and listings that normalize names.
- **Time**: a device offline for days while peers edit, delete, rename and revert; clock skew; coarse mtimes (FAT, exFAT) hiding a same-size edit from `unchangedSince` and the hash cache.
- **State**: a baseline lagging the disk, a stale comparison reused, a share moved or closed mid-cycle, a journal entry outliving its space.
- **Live**: a room opening on a file the sync is writing, or half wrote; a room's save racing a pull.

## Proof

A finding names the trigger sequence and the code path that publishes the damage, best as a failing vitest on `tests/helpers` (`pairedSessions`, `InMemoryAdapter`, `createTestControllerHost`), the way `tests/sync/cut-short.test.ts` kills a write part way. "Could race" without a sequence is no finding.
