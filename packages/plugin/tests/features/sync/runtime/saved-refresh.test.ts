import { createTestControllerHost } from "@tests/helpers/controller";
import {
	pairedSessions,
	type TestSession,
	useEncryptionKey,
} from "@tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LocalSession } from "@/features/sync";
import { SyncController } from "@/features/sync/controller";
import type { CompareResult } from "@/features/sync/engine";
import { pushPathsOp } from "@/features/sync/operations/push";
import { type Space, VAULT_SPACE } from "@/features/sync/remote/space";
import { SyncControllerRuntimeState } from "@/features/sync/runtime/controller-state";
import { SavedRefresh } from "@/features/sync/runtime/saved-refresh";
import { projectSession } from "@/features/sync/session-state";

useEncryptionKey();

const QUIET_MS = 300;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** The files pushed, so the vault reads clean until something is saved. */
async function pushed(
	session: TestSession,
	files: Record<string, string>,
): Promise<CompareResult> {
	for (const [path, text] of Object.entries(files)) {
		session.adapter.putText(path, text);
	}
	await pushPathsOp(
		session.deps(),
		await session.compare(),
		Object.keys(files),
		session.context(),
	);
	return session.compare();
}

function localOf(session: TestSession, space: Space): LocalSession {
	const { adapter, scope, state, maxFileBytes, storage } = session.deps();
	return {
		space,
		adapter,
		scope,
		state,
		maxFileBytes,
		identity: storage.identity(),
	};
}

async function harness(files: Record<string, string> = { "note.md": "one" }) {
	const [session] = pairedSessions();
	const first = await pushed(session, files);
	const state = new SyncControllerRuntimeState();
	state.setResult(VAULT_SPACE, first);
	const busy: boolean[] = [];
	state.subscribe((snapshot) => busy.push(snapshot.busy));
	const openLocal = vi.fn(async (space: Space) => localOf(session, space));
	const saved = new SavedRefresh({ runtimeState: state, host: { openLocal } });
	const patch = vi.spyOn(state, "patchResult");
	return {
		session,
		state,
		first,
		busy,
		openLocal,
		saved,
		patch,
		/** Past the quiet period, then until the queued task is done. */
		async run() {
			await vi.advanceTimersByTimeAsync(QUIET_MS);
			await state.enqueueQuiet(async () => undefined);
		},
	};
}

describe("SavedRefresh", () => {
	it("patches a changed file into the result without ever going busy", async () => {
		const h = await harness();
		const { lastCompareAt: at, resultRevision } = h.state.getSnapshot();
		h.session.adapter.putText("note.md", "two");

		h.saved.request("note.md");
		await h.run();

		const snapshot = h.state.getSnapshot();
		expect(snapshot.result?.diff.localChanges).toMatchObject([
			{ path: "note.md" },
		]);
		expect(snapshot.pendingLocal).toBe(1);
		expect(snapshot.lastCompareAt).toBe(at);
		expect(snapshot.resultRevision).toBe(resultRevision);
		expect(h.busy).not.toContain(true);
		h.saved.dispose();
	});

	it("installs nothing when the saved bytes hash the same", async () => {
		const h = await harness();
		h.session.adapter.putText("note.md", "one");

		h.saved.request("note.md");
		await h.run();

		expect(h.patch).not.toHaveBeenCalled();
		expect(h.state.getResult()).toBe(h.first);
		h.saved.dispose();
	});

	it("ignores a path the last compare did not see", async () => {
		const h = await harness();
		h.session.adapter.putText("fresh.md", "new");

		h.saved.request("fresh.md");
		await h.run();

		expect(h.patch).not.toHaveBeenCalled();
		expect(h.state.getResult()).toBe(h.first);
		h.saved.dispose();
	});

	it("skips a space whose storage changed since its compare", async () => {
		const h = await harness();
		h.session.adapter.putText("note.md", "two");
		h.openLocal.mockImplementation(async (space) => ({
			...localOf(h.session, space),
			identity: "another-storage",
		}));

		h.saved.request("note.md");
		await h.run();

		expect(h.patch).not.toHaveBeenCalled();
		h.saved.dispose();
	});

	it("skips a file over the size limit", async () => {
		const h = await harness();
		h.session.adapter.putText("note.md", "x".repeat(50));
		h.openLocal.mockImplementation(async (space) => ({
			...localOf(h.session, space),
			maxFileBytes: 10,
		}));

		h.saved.request("note.md");
		await h.run();

		expect(h.patch).not.toHaveBeenCalled();
		h.saved.dispose();
	});

	it("does not overwrite a result replaced while it looked", async () => {
		const h = await harness();
		h.session.adapter.putText("note.md", "two");
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.openLocal.mockImplementationOnce(async (space) => {
			await gate;
			return localOf(h.session, space);
		});

		h.saved.request("note.md");
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		const newer = { ...h.first };
		h.state.setResult(VAULT_SPACE, newer);
		release();
		await h.state.enqueueQuiet(async () => undefined);

		expect(h.patch).not.toHaveBeenCalled();
		expect(h.state.getResult()).toBe(newer);
		h.saved.dispose();
	});

	it("does not install after an invalidation, even onto the same result", async () => {
		const h = await harness();
		h.session.adapter.putText("note.md", "two");
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.openLocal.mockImplementationOnce(async (space) => {
			await gate;
			return localOf(h.session, space);
		});

		h.saved.request("note.md");
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		h.state.invalidate("Scope changed.");
		h.state.setResult(VAULT_SPACE, h.first);
		release();
		await h.state.enqueueQuiet(async () => undefined);

		expect(h.patch).not.toHaveBeenCalled();
		expect(h.state.getResult()).toBe(h.first);
		h.saved.dispose();
	});

	it("runs one task for several saves inside the quiet period", async () => {
		const h = await harness({ "a.md": "a", "b.md": "b" });
		h.session.adapter.putText("a.md", "a2");
		h.session.adapter.putText("b.md", "b2");

		h.saved.request("a.md");
		await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
		h.saved.request("b.md");
		await vi.advanceTimersByTimeAsync(QUIET_MS - 100);
		expect(h.openLocal).not.toHaveBeenCalled();
		await h.run();

		expect(h.openLocal).toHaveBeenCalledOnce();
		expect(h.patch).toHaveBeenCalledOnce();
		expect(h.state.getSnapshot().pendingLocal).toBe(2);
		h.saved.dispose();
	});

	it("skips a paused space and one without a result", async () => {
		const h = await harness();
		const paused: Space = { id: "rest", root: "Rest", paused: true };
		const bare: Space = { id: "bare", root: "Bare" };
		h.state.setSpaces([VAULT_SPACE, paused, bare]);

		h.saved.request("Rest/a.md");
		h.saved.request("Bare/b.md");
		await h.run();

		expect(h.openLocal).not.toHaveBeenCalled();
		h.saved.dispose();
	});

	it("drops its waiting paths on dispose", async () => {
		const h = await harness();
		h.session.adapter.putText("note.md", "two");

		h.saved.request("note.md");
		h.saved.dispose();
		await h.run();

		expect(h.openLocal).not.toHaveBeenCalled();
	});
});

describe("SyncController.refreshSaved", () => {
	it("opens the space locally only, never as a session", async () => {
		const [session] = pairedSessions();
		session.adapter.putText("note.md", "one");
		const host = createTestControllerHost(session);
		const identity = session.storage.identity();
		// The persisted baseline, as the real opener projects it.
		const openLocal = vi.fn(async (space: Space) => ({
			...localOf(session, space),
			state: projectSession(host.getState(), identity, space.root),
		}));
		const controller = new SyncController({ ...host, openLocal });
		await controller.refreshAndAutoSync();
		host.openSession.mockClear();
		session.adapter.putText("note.md", "two");

		controller.refreshSaved("note.md");
		await vi.advanceTimersByTimeAsync(QUIET_MS);
		await vi.waitFor(() =>
			expect(controller.getSnapshot().pendingLocal).toBe(1),
		);

		expect(openLocal).toHaveBeenCalledWith(VAULT_SPACE, [VAULT_SPACE]);
		expect(host.openSession).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("does nothing after dispose", async () => {
		const [session] = pairedSessions();
		const host = createTestControllerHost(session);
		const openLocal = vi.fn(async (space: Space) => localOf(session, space));
		const controller = new SyncController({ ...host, openLocal });

		controller.refreshSaved("note.md");
		controller.dispose();
		await vi.advanceTimersByTimeAsync(QUIET_MS * 2);

		expect(openLocal).not.toHaveBeenCalled();
	});
});
