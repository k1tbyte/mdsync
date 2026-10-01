import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import type { EngineDependencies } from "@/sync/engine";
import { pushPathsOp } from "@/sync/operations/push";
import { HistoryService } from "@/sync/runtime/history-service";
import { createIgnoreMatcher } from "@/vault/ignore";
import { createScopePolicy } from "@/vault/scope";

useEncryptionKey();

const ignoringDrafts = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
	localIgnore: createIgnoreMatcher("drafts/"),
});

function withHistory(session: TestSession): EngineDependencies {
	return { ...session.deps(), history: { maxSnapshots: 10 } };
}

async function pushAll(session: TestSession): Promise<void> {
	const result = await session.compare();
	await pushPathsOp(
		withHistory(session),
		result,
		result.diff.localChanges.map((change) => change.path),
		session.context(),
	);
}

function serviceFor(session: TestSession): HistoryService {
	return new HistoryService({
		openSession: async () => ({
			...withHistory(session),
			scope: ignoringDrafts,
		}),
		enqueue: (task) => task(),
		refresh: async () => undefined,
	});
}

describe("history on a device that ignores a folder", () => {
	it("leaves an ignored path out of the deleted files", async () => {
		const session = new TestSession();
		session.adapter.putText("notes/b.md", "b");
		session.adapter.putText("drafts/x.md", "x");
		await pushAll(session);
		await session.adapter.remove("notes/b.md");
		await session.adapter.remove("drafts/x.md");
		await pushAll(session);

		const { files } = await serviceFor(session).listDeletedFiles();

		expect(files.map((file) => file.path)).toEqual(["notes/b.md"]);
	});

	it("restores a snapshot without writing the ignored path", async () => {
		const session = new TestSession();
		session.adapter.putText("notes/a.md", "a1");
		session.adapter.putText("drafts/x.md", "x1");
		await pushAll(session);
		session.adapter.putText("notes/a.md", "a2");
		session.adapter.putText("drafts/x.md", "x2");
		await pushAll(session);
		const service = serviceFor(session);
		const { snapshots } = await service.listSnapshots();
		const first = snapshots[snapshots.length - 1];
		if (!first) throw new Error("expected two snapshots");

		const preview = await service.previewVaultRestore(first.id);
		const { plan, applied } = await service.restoreVault(first.id, preview);

		expect(applied).toBe(true);
		expect(session.text("notes/a.md")).toBe("a1");
		expect(session.text("drafts/x.md")).toBe("x2");
		expect(plan.ignored).toEqual(["drafts/x.md"]);
	});

	it("vault restore applies nothing when the vault moved since the confirmation", async () => {
		const session = new TestSession();
		session.adapter.putText("notes/a.md", "a1");
		await pushAll(session);
		session.adapter.putText("notes/a.md", "a2");
		await pushAll(session);
		const service = serviceFor(session);
		const { snapshots } = await service.listSnapshots();
		const first = snapshots[snapshots.length - 1];
		if (!first) throw new Error("expected two snapshots");
		const preview = await service.previewVaultRestore(first.id);

		session.adapter.putText("notes/new.md", "written while the modal was open");
		const { plan, applied } = await service.restoreVault(first.id, preview);

		expect(applied).toBe(false);
		expect(plan.remove).toEqual(["notes/new.md"]);
		expect(session.text("notes/a.md")).toBe("a2");
		expect(session.text("notes/new.md")).toBe(
			"written while the modal was open",
		);
	});
});
