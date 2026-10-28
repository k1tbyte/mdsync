import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/core/crypto";
import type { EngineDependencies } from "@/features/sync/engine";
import { pushPathsOp } from "@/features/sync/operations/push";
import { HistoryService } from "@/features/sync/runtime/history-service";

useEncryptionKey();

const encode = (text: string) => new TextEncoder().encode(text);

async function pushAll(session: TestSession): Promise<void> {
	const deps: EngineDependencies = {
		...session.deps(),
		history: { horizon: null },
	};
	const result = await session.compare();
	await pushPathsOp(
		deps,
		result,
		result.diff.localChanges.map((change) => change.path),
		session.context(),
	);
}

function serviceFor(session: TestSession) {
	const openSession = vi.fn(
		async (_path?: string): Promise<EngineDependencies | null> =>
			session.deps(),
	);
	const refresh = vi.fn(async () => undefined);
	let turns = 0;
	const service = new HistoryService({
		openSession,
		enqueue: (task) => {
			turns++;
			return task();
		},
		refresh,
		remember: () => undefined,
	});
	return { service, openSession, refresh, turns: () => turns };
}

describe("restoreFileVersions", () => {
	it("restores two files in one turn with one refresh, and reports the one that failed", async () => {
		const session = new TestSession();
		session.adapter.putText("a.md", "a1");
		session.adapter.putText("b.md", "b1");
		await pushAll(session);
		session.adapter.putText("a.md", "a2");
		session.adapter.putText("b.md", "b2");
		const { service, openSession, refresh, turns } = serviceFor(session);

		const failed = await service.restoreFileVersions([
			{ path: "a.md", hash: await sha256Hex(encode("a1")) },
			{ path: "gone.md", hash: "0".repeat(64) },
			{ path: "b.md", hash: await sha256Hex(encode("b1")) },
		]);

		expect(failed).toEqual(["gone.md"]);
		expect(session.text("a.md")).toBe("a1");
		expect(session.text("b.md")).toBe("b1");
		expect(session.adapter.hasFile("gone.md")).toBe(false);
		expect(turns()).toBe(1);
		expect(refresh).toHaveBeenCalledTimes(1);
		// A batch may span spaces, so each item opens the session of its own path.
		expect(openSession.mock.calls.map(([path]) => path)).toEqual([
			"a.md",
			"gone.md",
			"b.md",
		]);
	});

	it("does not refresh when no write landed", async () => {
		const session = new TestSession();
		const { service, refresh } = serviceFor(session);

		const failed = await service.restoreFileVersions([
			{ path: "a.md", hash: "0".repeat(64) },
		]);

		expect(failed).toEqual(["a.md"]);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("refreshes once for what landed even when the session is gone for a later item", async () => {
		const session = new TestSession();
		session.adapter.putText("a.md", "a1");
		await pushAll(session);
		session.adapter.putText("a.md", "a2");
		const { service, openSession, refresh } = serviceFor(session);
		openSession.mockImplementation(async (path?: string) =>
			path === "other/b.md" ? null : session.deps(),
		);

		const failed = await service.restoreFileVersions([
			{ path: "a.md", hash: await sha256Hex(encode("a1")) },
			{ path: "other/b.md", hash: await sha256Hex(encode("a1")) },
		]);

		expect(failed).toEqual(["other/b.md"]);
		expect(session.text("a.md")).toBe("a1");
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});
