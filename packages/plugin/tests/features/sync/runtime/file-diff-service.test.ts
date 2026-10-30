import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import type { CompareResult } from "@/features/sync/engine";
import { pushPathsOp } from "@/features/sync/operations/push";
import { FileDiffService } from "@/features/sync/runtime/file-diff-service";

useEncryptionKey();

async function push(session: TestSession, path: string): Promise<void> {
	const result = await session.compare();
	await pushPathsOp(session.deps(), result, [path], session.context());
}

function service(a: TestSession, result: CompareResult): FileDiffService {
	return new FileDiffService({
		openSession: async () => a.deps(),
		getResult: () => result,
		shareBases: () => undefined,
	});
}

/** `note.md` edited on both devices since the version they share. */
async function conflicted(): Promise<{
	a: TestSession;
	result: CompareResult;
}> {
	const [a, b] = pairedSessions();
	a.adapter.putText("note.md", "base\n");
	await push(a, "note.md");
	b.adapter.putText("note.md", "base\n");
	await b.adoptRemote();
	b.adapter.putText("note.md", "remote\n");
	await push(b, "note.md");
	a.adapter.putText("note.md", "local\n");
	return { a, result: await a.compare() };
}

describe("getConflictThreeWay", () => {
	it("gives the three versions with the compare's hashes", async () => {
		const { a, result } = await conflicted();
		const [conflict] = result.diff.conflicts;

		const texts = await service(a, result).getConflictThreeWay("note.md");

		expect(texts).toEqual({
			base: "base\n",
			local: "local\n",
			remote: "remote\n",
			expected: {
				localHash: conflict?.localHash,
				remoteHash: conflict?.remoteHash,
			},
		});
	});

	it("refuses a local file edited since the compare", async () => {
		const { a, result } = await conflicted();
		a.adapter.putText("note.md", "typed after the compare\n");

		const texts = await service(a, result).getConflictThreeWay("note.md");

		expect(texts).toMatch(/changed since the last compare/);
	});

	it("says why when the two versions share no earlier one", async () => {
		const [a, b] = pairedSessions();
		b.adapter.putText("new.md", "from b\n");
		await push(b, "new.md");
		a.adapter.putText("new.md", "from a\n");
		const result = await a.compare();

		const texts = await service(a, result).getConflictThreeWay("new.md");

		expect(texts).toMatch(/share no earlier one/);
	});
});
