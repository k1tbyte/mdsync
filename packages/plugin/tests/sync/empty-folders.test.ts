import {
	pairedSessions,
	TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";

import { compare } from "@/sync/engine";
import { pullPathsOp } from "@/sync/operations/pull";
import { pushPathsOp } from "@/sync/operations/push";

useEncryptionKey();

describe("a folder the scan cannot open", () => {
	it("keeps its empty folders published: unreadable is not absent", async () => {
		const a = new TestSession();
		await a.adapter.mkdir("locked");
		await a.adapter.mkdir("locked/empty");
		a.adapter.write("a.md", "A");
		const first = await compare(a.deps());
		await pushPathsOp(a.deps(), first, ["a.md"], a.context());
		expect(a.state.baseline?.folders).toContain("locked/empty");

		const list = a.adapter.list.bind(a.adapter);
		vi.spyOn(a.adapter, "list").mockImplementation((dir) =>
			dir === "locked" ? Promise.reject(new Error("EACCES")) : list(dir),
		);
		a.adapter.write("b.md", "B");
		const second = await compare(a.deps());
		const outcome = await pushPathsOp(a.deps(), second, ["b.md"], a.context());

		expect(outcome.newRemote?.folders).toContain("locked/empty");
	});
});

describe("an empty folder deleted on one device", () => {
	it("stays deleted through a pull, and the next push deletes it for everyone", async () => {
		const [a, b] = pairedSessions();
		await a.adapter.mkdir("empty");
		a.adapter.write("a.md", "A");
		const first = await compare(a.deps());
		await pushPathsOp(a.deps(), first, ["a.md"], a.context());
		const joined = await compare(b.deps());
		await pullPathsOp(b.deps(), joined, ["a.md"], b.context());
		b.adapter.write("b.md", "B");
		const theirs = await compare(b.deps());
		await pushPathsOp(b.deps(), theirs, ["b.md"], b.context());

		await a.adapter.rmdir("empty", false);
		const incoming = await compare(a.deps());
		await pullPathsOp(a.deps(), incoming, ["b.md"], a.context());
		expect(await a.adapter.exists("empty")).toBe(false);

		a.adapter.write("c.md", "C");
		const mine = await compare(a.deps());
		const outcome = await pushPathsOp(a.deps(), mine, ["c.md"], a.context());
		expect(outcome.newRemote?.folders ?? []).not.toContain("empty");
	});
});
