import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import { sha256Hex } from "@/core/crypto";
import { objectKey } from "@/features/sync/content/keys";
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
	const restored = vi.fn();
	let turns = 0;
	const service = new HistoryService({
		openSession,
		enqueue: (task) => {
			turns++;
			return task();
		},
		refresh,
		remember: () => undefined,
		restored,
	});
	return { service, openSession, refresh, restored, turns: () => turns };
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

describe("restoreVault", () => {
	it("keeps what is edited while it runs: a file it downloads for, a file it would remove", async () => {
		const session = new TestSession();
		session.adapter.putText("a.md", "a1");
		session.adapter.putText("b.md", "b1");
		await pushAll(session);
		const first = session.state.baseline?.snapshotId as string;
		session.adapter.putText("a.md", "a2");
		session.adapter.putText("b.md", "b2");
		session.adapter.putText("c.md", "c1");
		await pushAll(session);
		const { service } = serviceFor(session);
		const confirmed = await service.previewVaultRestore(first);
		const a1 = objectKey(await sha256Hex(encode("a1")));
		const get = session.storage.get.bind(session.storage);
		vi.spyOn(session.storage, "get").mockImplementation(async (storageKey) => {
			// Saved while the restore downloads.
			if (storageKey === a1) {
				session.adapter.putText("a.md", "mine");
				session.adapter.putText("c.md", "c2");
			}
			return get(storageKey);
		});

		const { applied } = await service.restoreVault(first, confirmed);

		expect(applied).toBe(true);
		expect(session.text("a.md")).toBe("mine");
		expect(session.text("b.md")).toBe("b1");
		expect(session.text("c.md")).toBe("c2");
	});

	it("holds what it writes, then what it removes, out of automatic pushes", async () => {
		const session = new TestSession();
		session.adapter.putText("a.md", "a1");
		await pushAll(session);
		const first = session.state.baseline?.snapshotId as string;
		session.adapter.putText("a.md", "a2");
		session.adapter.putText("c.md", "c1");
		await pushAll(session);
		const { service, restored } = serviceFor(session);

		await service.restoreVault(first, await service.previewVaultRestore(first));

		expect(restored.mock.calls).toEqual([
			[
				expect.objectContaining({ id: "vault" }),
				new Map([["a.md", await sha256Hex(encode("a1"))]]),
			],
			[expect.objectContaining({ id: "vault" }), new Map([["c.md", null]])],
		]);
	});

	it("holds no removal when a write fails", async () => {
		const session = new TestSession();
		session.adapter.putText("a.md", "a1");
		await pushAll(session);
		const first = session.state.baseline?.snapshotId as string;
		session.adapter.putText("a.md", "a2");
		session.adapter.putText("c.md", "c1");
		await pushAll(session);
		const { service, restored } = serviceFor(session);
		const confirmed = await service.previewVaultRestore(first);
		const a1 = objectKey(await sha256Hex(encode("a1")));
		const get = session.storage.get.bind(session.storage);
		vi.spyOn(session.storage, "get").mockImplementation(async (key) => {
			if (key === a1) throw new Error("offline");
			return get(key);
		});

		await expect(service.restoreVault(first, confirmed)).rejects.toThrow();

		expect(restored).toHaveBeenCalledOnce();
		expect(session.text("c.md")).toBe("c1");
	});

	it("writes over a file a case-blind disk holds under another spelling", async () => {
		const session = new TestSession();
		session.adapter.putText("notes/a.md", "a1");
		await pushAll(session);
		const first = session.state.baseline?.snapshotId as string;
		session.adapter.remove("notes/a.md");
		session.adapter.putText("Notes/A.md", "a2");
		await pushAll(session);
		const stat = session.adapter.stat.bind(session.adapter);
		vi.spyOn(session.adapter, "stat").mockImplementation((path) =>
			stat(path === "notes/a.md" ? "Notes/A.md" : path),
		);
		const { service, restored } = serviceFor(session);

		const confirmed = await service.previewVaultRestore(first);
		await service.restoreVault(first, confirmed);

		expect(session.text("notes/a.md")).toBe("a1");
		const hash = await sha256Hex(encode("a1"));
		expect(restored).toHaveBeenCalledWith(
			expect.objectContaining({ id: "vault" }),
			new Map([
				["notes/a.md", hash],
				["Notes/A.md", hash],
			]),
		);
	});
});

describe("space routing", () => {
	it("restores to another path with the version read in the space that stored it", async () => {
		const session = new TestSession();
		session.adapter.putText("a.md", "a1");
		await pushAll(session);
		const { service, openSession } = serviceFor(session);

		await service.restoreFileVersion(
			"Shared/a.md",
			await sha256Hex(encode("a1")),
			"a.md",
		);

		expect(session.text("Shared/a.md")).toBe("a1");
		expect(openSession.mock.calls.map(([path]) => path)).toEqual([
			"a.md",
			"Shared/a.md",
		]);
	});

	it("previews a restore-to in the space of its source", async () => {
		const session = new TestSession();
		const { service, openSession } = serviceFor(session);
		openSession.mockResolvedValue(null);

		await service.getHistoryDiff({
			path: "Shared/a.md",
			source: "a.md",
			left: { current: true },
			right: { current: true },
		});

		expect(openSession).toHaveBeenCalledWith("a.md");
	});

	it("pins in the space of the file whose History it came from", async () => {
		const session = new TestSession();
		const { service, openSession } = serviceFor(session);
		openSession.mockResolvedValue(null);

		await expect(
			service.setSnapshotPinned("s1", false, undefined, "Shared/a.md"),
		).rejects.toThrow();
		expect(openSession).toHaveBeenCalledWith("Shared/a.md");
	});
});
