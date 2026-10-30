import { createTestControllerHost } from "@tests/helpers/controller";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";
import { REMOTE_MANIFEST_KEY } from "@/core/constants";

import { decryptJson, sha256Hex } from "@/core/crypto/cipher";
import { DEFAULT_SETTINGS_SYNC } from "@/core/settings/model";
import { OFFLINE_MESSAGE } from "@/core/shared/offline";
import { SyncController } from "@/features/sync/controller";
import { pushPaths } from "@/features/sync/engine";
import { createScopePolicy } from "@/features/sync/scope/scope";
import type { Manifest } from "@/features/sync/types";

useEncryptionKey();

const hashOf = (text: string) => sha256Hex(new TextEncoder().encode(text));

async function headFiles(session: ReturnType<typeof pairedSessions>[0]) {
	const bytes = session.storage.map.get(REMOTE_MANIFEST_KEY);
	if (!bytes) throw new Error("Missing head");
	return (await decryptJson<Manifest>(session.deps().key, bytes)).files;
}

function headReads(get: { mock: { calls: [string][] } }): number {
	return get.mock.calls.filter(([key]) => key === REMOTE_MANIFEST_KEY).length;
}

describe("serialized automatic refresh cycle", () => {
	it("pushes one file with one compare plus both manifest guards", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("note.md", "new");
		const host = createTestControllerHost(a);
		const controller = new SyncController(host);
		const get = vi.spyOn(a.storage, "get");
		await controller.refreshAndAutoSync();
		expect(headReads(get)).toBe(3);
		expect(controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 0,
		});
		expect(host.onPushComplete).toHaveBeenCalledOnce();
		controller.dispose();
	});

	it("pulls an initial file with one manifest read", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "remote");
		await pushPaths(a.deps(), await a.compare(), ["note.md"]);
		const controller = new SyncController(createTestControllerHost(b));
		const get = vi.spyOn(b.storage, "get");
		await controller.refreshAndAutoPull();
		expect(headReads(get)).toBe(1);
		expect(b.text("note.md")).toBe("remote");
		controller.dispose();
	});

	it("never pulls from the last comparison once the next refresh failed offline", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "remote");
		await pushPaths(a.deps(), await a.compare(), ["note.md"]);
		const controller = new SyncController(createTestControllerHost(b));
		await controller.refresh();
		expect(controller.getSnapshot().pendingRemote).toBe(1);

		vi.spyOn(b.storage, "get").mockRejectedValue(new Error("Failed to fetch"));
		await controller.refreshAndAutoPull();

		expect(controller.getSnapshot()).toMatchObject({
			error: OFFLINE_MESSAGE,
			offline: true,
		});
		expect(await b.adapter.exists("note.md")).toBe(false);
		controller.dispose();
	});

	it("compares again after a local change during refresh state persistence", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("note.md", "before");
		const host = createTestControllerHost(a);
		const persist = host.persistState;
		const controller = new SyncController(host);
		let changed = false;
		host.persistState = async (state) => {
			await persist(state);
			if (changed) return;
			changed = true;
			a.adapter.putText("note.md", "after");
			controller.noteLocalChange();
		};
		const get = vi.spyOn(a.storage, "get");
		await controller.refreshAndAutoSync();
		expect(headReads(get)).toBe(4);
		expect(controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 0,
		});
		const bytes = a.storage.map.get(REMOTE_MANIFEST_KEY);
		if (!bytes) throw new Error("Missing head");
		const manifest = await decryptJson<Manifest>(a.deps().key, bytes);
		expect(manifest.files["note.md"]?.hash).toBe(
			(await a.compare()).snapshot.files["note.md"]?.hash,
		);
		controller.dispose();
	});

	it("rescans hidden configuration without rereading the remote head", async () => {
		const [a] = pairedSessions();
		a.adapter.putText(".obsidian/app.json", "before");
		const host = createTestControllerHost(a);
		const open = host.openSession.getMockImplementation();
		host.openSession.mockImplementation(async (...args) => {
			const session = await open?.(...args);
			return session
				? {
						...session,
						scope: createScopePolicy({
							configDir: ".obsidian",
							settingsSync: { ...DEFAULT_SETTINGS_SYNC, coreSettings: true },
						}),
					}
				: null;
		});
		const persist = host.persistState;
		let changed = false;
		host.persistState = async (state) => {
			await persist(state);
			if (!changed) {
				changed = true;
				a.adapter.putText(".obsidian/app.json", "after");
			}
		};
		const controller = new SyncController(host);
		const get = vi.spyOn(a.storage, "get");
		await controller.refreshAndAutoSync();
		expect(headReads(get)).toBe(3);
		expect(controller.getSnapshot().error).toBeNull();
		const bytes = a.storage.map.get(REMOTE_MANIFEST_KEY);
		if (!bytes) throw new Error("Missing head");
		const manifest = await decryptJson<Manifest>(a.deps().key, bytes);
		expect(manifest.files[".obsidian/app.json"]?.hash).toBe(
			await sha256Hex(new TextEncoder().encode("after")),
		);
		controller.dispose();
	});

	it("does not publish after scope invalidation during refresh", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("note.md", "local");
		const host = createTestControllerHost(a);
		const persist = host.persistState;
		const controller = new SyncController(host);
		host.persistState = async (state) => {
			await persist(state);
			controller.invalidate("Scope changed.");
		};
		await controller.refreshAndAutoSync();
		expect(a.storage.map.has(REMOTE_MANIFEST_KEY)).toBe(false);
		expect(host.onPushComplete).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("does not let queued manual work interleave between compare and push", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("note.md", "local");
		const host = createTestControllerHost(a);
		const events: string[] = [];
		host.onPushComplete = vi.fn(() => {
			events.push("pushed");
		});
		const controller = new SyncController(host);
		const auto = controller.refreshAndAutoSync();
		const manual = controller.between(async () => {
			events.push("manual");
		});
		await Promise.all([auto, manual]);
		expect(events).toEqual(["pushed", "manual"]);
		controller.dispose();
	});

	it("holds back more deletions than the limit and pushes the rest", async () => {
		const [a] = pairedSessions();
		const names = ["F/a.md", "F/b.md", "c.md"];
		for (const name of names) a.adapter.putText(name, "one");
		const onDeletionsHeld = vi.fn();
		const controller = new SyncController({
			...createTestControllerHost(a),
			autoDeleteLimit: () => 1,
			onDeletionsHeld,
		});
		await controller.refreshAndAutoSync();
		await a.adapter.remove("F/a.md");
		await a.adapter.remove("F/b.md");
		a.adapter.putText("c.md", "two");
		await controller.refreshAndAutoSync();
		const bytes = a.storage.map.get(REMOTE_MANIFEST_KEY);
		if (!bytes) throw new Error("Missing head");
		const manifest = await decryptJson<Manifest>(a.deps().key, bytes);
		expect(Object.keys(manifest.files).sort()).toEqual(names);
		expect(manifest.files["c.md"]?.hash).toBe(
			await sha256Hex(new TextEncoder().encode("two")),
		);
		expect(onDeletionsHeld).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ id: "vault" }),
			["F/a.md", "F/b.md"],
		);
		expect(controller.getSnapshot().pendingLocal).toBe(2);
		controller.dispose();
	});

	it("keeps a restored file out of automatic pushes until it is edited", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("a.md", "one");
		const controller = new SyncController(createTestControllerHost(a));
		await controller.refreshAndAutoSync();
		a.adapter.putText("a.md", "two");
		await controller.refreshAndAutoSync();

		await controller.history.restoreFileVersion("a.md", await hashOf("one"));
		a.adapter.putText("b.md", "new");
		await controller.refreshAndAutoSync();
		expect((await headFiles(a))["a.md"]?.hash).toBe(await hashOf("two"));
		expect((await headFiles(a))["b.md"]?.hash).toBe(await hashOf("new"));
		expect(controller.getSnapshot().pendingLocal).toBe(1);

		a.adapter.putText("a.md", "three");
		await controller.refreshAndAutoSync();
		expect((await headFiles(a))["a.md"]?.hash).toBe(await hashOf("three"));
		controller.dispose();
	});

	it("ends a restore's hold at a push by hand, with automatic pushes off meanwhile", async () => {
		const [a] = pairedSessions();
		a.adapter.putText("a.md", "one");
		const controller = new SyncController(createTestControllerHost(a));
		await controller.refreshAndAutoSync();
		a.adapter.putText("a.md", "two");
		await controller.pushPaths(["a.md"]);
		await controller.history.restoreFileVersion("a.md", await hashOf("one"));
		await controller.pushPaths(["a.md"]);
		a.adapter.putText("a.md", "two");
		await controller.pushPaths(["a.md"]);

		a.adapter.putText("a.md", "one");
		await controller.refreshAndAutoSync();

		expect((await headFiles(a))["a.md"]?.hash).toBe(await hashOf("one"));
		controller.dispose();
	});
});
