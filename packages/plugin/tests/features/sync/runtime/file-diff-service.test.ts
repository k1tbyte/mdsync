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

/** `path` edited on both devices since the version they share. */
async function conflicted(
	path = "note.md",
	[base, local, remote] = ["base\n", "local\n", "remote\n"],
): Promise<{ a: TestSession; result: CompareResult }> {
	const [a, b] = pairedSessions();
	a.adapter.putText(path, base);
	await push(a, path);
	b.adapter.putText(path, base);
	await b.adoptRemote();
	b.adapter.putText(path, remote);
	await push(b, path);
	a.adapter.putText(path, local);
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

	it("gives JSON base and remote in local's key order", async () => {
		const json = (value: unknown) => JSON.stringify(value, null, 2);
		const { a, result } = await conflicted("data.json", [
			json({ a: 1, b: 1 }),
			json({ b: 2, a: 1 }),
			json({ a: 3, b: 1 }),
		]);

		const texts = await service(a, result).getConflictThreeWay("data.json");

		expect(texts).toMatchObject({
			base: json({ b: 1, a: 1 }),
			local: json({ b: 2, a: 1 }),
			remote: json({ b: 1, a: 3 }),
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
