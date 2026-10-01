import { createTestControllerHost } from "@tests/helpers/controller";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, vi } from "vitest";

import { decryptJson, sha256Hex } from "@/crypto";
import { DEFAULT_SETTINGS_SYNC } from "@/settings/model";
import { REMOTE_MANIFEST_KEY } from "@/sync/constants";
import { SyncController } from "@/sync/controller";
import { pushPaths } from "@/sync/engine";
import type { Manifest } from "@/sync/types";
import { createScopePolicy } from "@/vault/scope";

useEncryptionKey();

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
});
