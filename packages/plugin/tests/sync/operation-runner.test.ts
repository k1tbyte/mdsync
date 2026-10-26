import { createTestControllerHost } from "@tests/helpers/controller";
import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ESyncLogOperation } from "@/logs/store";
import { OFFLINE_MESSAGE } from "@/shared";
import { ShareRefusedError, StorageRequestError } from "@/storage";
import { StorageHttpError } from "@/storage/adapters/util";
import { SyncCancelledError } from "@/sync/cancel";
import { splitSpaceErrors } from "@/sync/controller";
import { ConcurrentPushError } from "@/sync/manifest";
import { pushPathsOp } from "@/sync/operations/push";
import { SyncControllerRuntimeState } from "@/sync/runtime/controller-state";
import { OperationRunner } from "@/sync/runtime/operation-runner";
import { VAULT_SPACE } from "@/sync/space";
import type { Manifest } from "@/sync/types";

useEncryptionKey();

function createTestRunner(session: TestSession) {
	const host = createTestControllerHost(session);
	const runtimeState = new SyncControllerRuntimeState();
	onTestFinished(() => runtimeState.dispose());
	const runner = new OperationRunner({
		host,
		runtimeState,
		clearFileDiffs: () => {},
	});
	return { runner, runtimeState, host };
}

const unchanged = async () => ({
	newRemote: null,
	touchedPaths: new Set<string>(),
});

describe("OperationRunner.runOperation", () => {
	it("reports completion only after a push that published", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		expect(
			await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, unchanged),
		).toEqual({ ok: true });
		expect(host.onPushComplete).not.toHaveBeenCalled();

		const published = async () => ({
			newRemote: { snapshotId: "next" } as Manifest,
			touchedPaths: new Set(["a.md"]),
		});
		await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, published);
		expect(host.onPushComplete).toHaveBeenCalledOnce();
	});

	it("refuses an operation whose space left the partition before it ran", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		const fn = vi.fn(unchanged);
		const share = { id: "team", root: "Team" };
		runtimeState.setSpaces([VAULT_SPACE, share]);
		const queued = runner.runOperation(share, ESyncLogOperation.Push, fn);
		runtimeState.setSpaces([VAULT_SPACE, { ...share, root: "Projects/Team" }]);

		expect(await queued).toMatchObject({ ok: false });
		expect(fn).not.toHaveBeenCalled();
	});

	it("returns the same failure recorded in the snapshot and logs", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const error = "Upload rejected";
		const result = await runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			async () => {
				throw new Error(error);
			},
		);
		expect(result).toEqual({ ok: false, error });
		expect(runtimeState.getSnapshot().error).toBe(error);
		expect(host.logError).toHaveBeenCalledWith(ESyncLogOperation.Push, error);
		expect(host.onPushComplete).not.toHaveBeenCalled();
	});

	it("keeps S3 transport details in logs while shortening the UI error", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const detail =
			"S3 refused the request: this device's clock is off (RequestTimeTooSkewed)";
		const message =
			"This device's clock is off. Set the date and time automatically, then sync again.";
		const result = await runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			async () => {
				throw new StorageRequestError(detail, message);
			},
		);

		expect(result).toEqual({ ok: false, error: message });
		expect(runtimeState.getSnapshot().error).toBe(message);
		expect(host.logError).toHaveBeenCalledWith(ESyncLogOperation.Push, detail);
	});

	it("does not run or announce an operation without a session", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		host.openSession.mockResolvedValue(null);
		const operation = vi.fn(unchanged);
		expect(
			await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, operation),
		).toEqual({ ok: false });
		expect(operation).not.toHaveBeenCalled();
		expect(host.onPushComplete).not.toHaveBeenCalled();
	});

	it("does not execute an operation after a failed compare", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		vi.spyOn(session.storage, "get").mockRejectedValue(
			new Error("Compare failed"),
		);
		const operation = vi.fn(unchanged);
		expect(
			await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, operation),
		).toEqual({ ok: false, error: "Compare failed" });
		expect(operation).not.toHaveBeenCalled();
		expect(runtimeState.getSnapshot().error).toBe("Compare failed");
	});

	it("reports the vault's storage refusing its credentials, not other failures", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		const onStorageRefused = vi.fn();
		Object.assign(host, { onStorageRefused });
		const get = vi.spyOn(session.storage, "get");

		get.mockRejectedValue(new StorageHttpError(401, "Unauthorized"));
		await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, unchanged);
		expect(onStorageRefused).toHaveBeenCalledExactlyOnceWith(VAULT_SPACE);

		onStorageRefused.mockClear();
		get.mockRejectedValue(new StorageHttpError(404, "Not found"));
		await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, unchanged);
		get.mockRejectedValue(new Error("Offline"));
		await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, unchanged);
		expect(onStorageRefused).not.toHaveBeenCalled();
	});

	it("keeps cancellation separate from failure and success", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const result = await runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			async () => {
				throw new SyncCancelledError();
			},
			true,
		);
		expect(result).toEqual({ ok: false });
		expect(runtimeState.getSnapshot()).toMatchObject({
			error: null,
			cancellable: false,
			staleReason: "Stopped before publishing. Nothing on the remote changed.",
		});
		expect(host.logWarn).toHaveBeenCalledWith(
			ESyncLogOperation.Push,
			"Cancelled by the user.",
		);
		expect(host.onPushComplete).not.toHaveBeenCalled();
	});

	it("does not report a partial cancelled operation as completed", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const result = await runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Pull,
			async () => ({
				newRemote: null,
				touchedPaths: new Set(["note.md"]),
				cancelled: true,
			}),
			true,
		);
		expect(result).toEqual({ ok: false });
		expect(runtimeState.getSnapshot()).toMatchObject({
			error: null,
			cancellable: false,
			staleReason:
				"Stopped after 1 file(s). Compare again to see where things stand.",
		});
		expect(host.onPushComplete).not.toHaveBeenCalled();
	});

	it("does not report concurrent-head recovery as a successful push", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		const result = await runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			async () => {
				throw new ConcurrentPushError("Remote changed");
			},
		);
		expect(result).toEqual({ ok: false, error: "Remote changed" });
		expect(host.openSession).toHaveBeenCalledTimes(2);
		expect(host.logWarn).toHaveBeenCalledWith(
			ESyncLogOperation.Push,
			"Remote changed",
		);
		expect(host.onPushComplete).not.toHaveBeenCalled();
	});

	it("publishes no result from an operation invalidated while it ran", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		await runner.runOperation(VAULT_SPACE, ESyncLogOperation.Push, async () => {
			runtimeState.invalidate("Shared folder moved.");
			return unchanged();
		});
		expect(runtimeState.getSnapshot()).toMatchObject({
			result: null,
			staleReason: "Shared folder moved.",
		});
	});

	it("preserves the failed result when the next queued operation clears the error", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		const first = runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			async () => {
				throw new Error("First failed");
			},
		);
		const second = runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			unchanged,
		);
		expect(await Promise.all([first, second])).toEqual([
			{ ok: false, error: "First failed" },
			{ ok: true },
		]);
		expect(runtimeState.getSnapshot().error).toBeNull();
	});
});
describe("OperationRunner.refreshNow", () => {
	it("adopts converged files without adopting the remote's empty folders", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "shared\n");
		const first = await a.compare();
		await pushPathsOp(a.deps(), first, ["note.md"], a.context());
		b.adapter.putText("note.md", "shared\n");
		await b.adoptRemote();

		await b.adapter.mkdir("EmptyFolder");
		b.adapter.putText("note.md", "same edit\n");
		const bResult = await b.compare();
		const pushed = await pushPathsOp(
			b.deps(),
			bResult,
			["note.md"],
			b.context(),
		);
		a.adapter.putText("note.md", "same edit\n");

		const baseline = await refreshedBaseline(a);

		expect(baseline?.files["note.md"]?.hash).toBe(
			pushed.newRemote?.files["note.md"]?.hash,
		);
		// Nothing created the folder here, so the next push must not read it as deleted.
		expect(baseline?.folders ?? []).toEqual([]);
	});

	it("names the storage the vault compared against", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		expect(runtimeState.getSnapshot().vaultCheck).toBeNull();

		await runner.refreshNow();

		expect(runtimeState.getSnapshot().vaultCheck?.storage).toBe(
			session.storage.identity(),
		);
	});

	it("records the empty folders a first refresh finds on both sides", async () => {
		const [a, b] = pairedSessions();
		a.adapter.putText("note.md", "shared\n");
		await a.adapter.mkdir("Shared");
		const first = await a.compare();
		await pushPathsOp(a.deps(), first, ["note.md"], a.context());
		// A copy of the same vault, syncing for the first time.
		b.adapter.putText("note.md", "shared\n");
		await b.adapter.mkdir("Shared");

		const baseline = await refreshedBaseline(b);

		// So deleting the folder on A later removes it here too.
		expect(baseline?.folders).toEqual(["Shared"]);
	});

	it("refreshes the vault past a share that fails, and names that share", async () => {
		const [session] = pairedSessions();
		session.adapter.putText("note.md", "local\n");
		const { runner, runtimeState, host } = createTestRunner(session);
		const share = { id: "share", root: "Team" };
		host.spaces = async () => [VAULT_SPACE, share];
		const open = host.openSession.getMockImplementation();
		host.openSession.mockImplementation(async (space, partition) => {
			if (space === share) throw new Error("Access denied");
			return open?.(space, partition) ?? null;
		});

		await runner.refreshNow();

		expect(runtimeState.resultOf(VAULT_SPACE)).not.toBeNull();
		expect(runtimeState.resultOf(share)).toBeNull();
		expect(runtimeState.getSnapshot()).toMatchObject({
			error: null,
			spaceErrors: [{ root: "Team", message: "Access denied" }],
			pendingLocal: 1,
		});

		host.openSession.mockImplementation(open ?? (async () => null));
		await runner.runOperation(share, ESyncLogOperation.Compare, unchanged);
		expect(runtimeState.getSnapshot().spaceErrors).toEqual([]);
	});

	it("sets apart a share whose storage cannot be reached from one that broke", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const team = { id: "team", root: "Team" };
		const docs = { id: "docs", root: "Docs" };
		host.spaces = async () => [VAULT_SPACE, team, docs];
		const open = host.openSession.getMockImplementation();
		host.openSession.mockImplementation(async (space, partition) => {
			if (space === team) throw new Error("Failed to fetch");
			if (space === docs) throw new Error("Access denied");
			return open?.(space, partition) ?? null;
		});

		await runner.refreshNow();

		const snapshot = runtimeState.getSnapshot();
		expect(snapshot).toMatchObject({ error: null, offline: false });
		expect(snapshot.spaceErrors).toEqual([
			{ root: "Team", message: OFFLINE_MESSAGE, offline: true },
			{ root: "Docs", message: "Access denied" },
		]);
		expect(splitSpaceErrors(snapshot.spaceErrors)).toEqual({
			unreachable: [snapshot.spaceErrors[0]],
			broken: [snapshot.spaceErrors[1]],
		});
	});

	it("reports a share's refused link, not any other storage refusal", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		const onShareRefused = vi.fn();
		Object.assign(host, { onShareRefused });
		const share = { id: "share", root: "Team" };
		host.spaces = async () => [VAULT_SPACE, share];
		const open = host.openSession.getMockImplementation();
		let refusal: Error = new StorageRequestError("403", "Access denied");
		host.openSession.mockImplementation(async (space, partition) => {
			const deps = await open?.(space, partition);
			if (!deps || space !== share) return deps ?? null;
			const storage = new Proxy(deps.storage, {
				get: (_, key) =>
					key === "identity"
						? () => "broker|share"
						: () => Promise.reject(refusal),
			});
			return { ...deps, space: share, storage };
		});

		await runner.refreshNow();
		expect(onShareRefused).not.toHaveBeenCalled();

		refusal = new ShareRefusedError("401", "Invite no longer valid");
		await runner.refreshNow();
		expect(onShareRefused).toHaveBeenCalledExactlyOnceWith(share);
	});

	it("reports a share's refused storage credentials, not other failures", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		const onStorageRefused = vi.fn();
		Object.assign(host, { onStorageRefused });
		const share = { id: "share", root: "Team" };
		host.spaces = async () => [VAULT_SPACE, share];
		const open = host.openSession.getMockImplementation();
		let refusal: Error = new StorageHttpError(403, "Forbidden");
		host.openSession.mockImplementation(async (space, partition) => {
			const deps = await open?.(space, partition);
			if (!deps || space !== share) return deps ?? null;
			const storage = new Proxy(deps.storage, {
				get: (_, key) =>
					key === "identity" ? () => "s3|share" : () => Promise.reject(refusal),
			});
			return { ...deps, space: share, storage };
		});

		await runner.refreshNow();
		expect(onStorageRefused).toHaveBeenCalledExactlyOnceWith(share);

		onStorageRefused.mockClear();
		for (const other of [
			new StorageHttpError(404, "Not found"),
			new Error("Offline"),
		]) {
			refusal = other;
			await runner.refreshNow();
		}
		expect(onStorageRefused).not.toHaveBeenCalled();
	});

	it("forgets a share's baseline wherever it was mounted, with no storage to open", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		const slot = { vaultId: "v", baseline: null };
		await host.persistState({
			...host.getState(),
			storages: {
				vault: slot,
				old: { ...slot, root: "Old/Team", space: "share" },
				// Another share at that root, left out of the partition.
				other: { ...slot, root: "Team", space: "other" },
			},
		});
		host.openSession.mockRejectedValue(new Error("Offline"));

		await runner.forget({ id: "share", root: "Team" });

		expect(Object.keys(host.getState().storages)).toEqual(["vault", "other"]);
	});

	it("empties a closed share's storage, never the vault's", async () => {
		const [session] = pairedSessions();
		session.storage.map.set("objects/a", Uint8Array.of(1));
		const { runner, host } = createTestRunner(session);

		await expect(
			runner.forget(VAULT_SPACE, { deleteRemote: true }),
		).rejects.toThrow();
		expect(session.storage.map.size).toBe(1);

		const share = { id: "share", root: "Team" };
		host.openSession.mockResolvedValue({ ...session.deps(), space: share });
		await runner.forget(share, { deleteRemote: true });
		expect(session.storage.map.size).toBe(0);
	});

	it("drops a refresh invalidated while it ran, so nothing acts on it", async () => {
		const [session] = pairedSessions();
		session.adapter.putText("note.md", "local\n");
		const { runner, runtimeState, host } = createTestRunner(session);
		const open = host.openSession.getMockImplementation();
		host.openSession.mockImplementation(async (space, partition) => {
			runtimeState.invalidate("Shared folder moved.");
			return open?.(space, partition) ?? null;
		});

		await runner.refreshNow();

		expect(runtimeState.getSnapshot()).toMatchObject({
			result: null,
			staleReason: "Shared folder moved.",
		});
	});

	it("fails the whole refresh when the vault fails", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		host.spaces = async () => [VAULT_SPACE, { id: "share", root: "Team" }];
		host.openSession.mockRejectedValue(new Error("Access denied"));

		await runner.refreshNow();

		expect(runtimeState.getSnapshot()).toMatchObject({
			error: "Access denied",
			spaceErrors: [],
			result: null,
		});
	});
});

describe("OperationRunner offline", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("reads a lost connection as offline, yet still as a failed cycle", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		host.openSession.mockRejectedValueOnce(
			new Error("net::ERR_INTERNET_DISCONNECTED"),
		);

		await runner.refreshNow();

		// `error` stays set so nothing that gates on it acts on the comparison it kept.
		expect(runtimeState.getSnapshot()).toMatchObject({
			offline: true,
			error: OFFLINE_MESSAGE,
		});
		expect(host.logWarn).toHaveBeenCalled();
		expect(host.logError).not.toHaveBeenCalled();

		await runner.refreshNow();
		expect(runtimeState.getSnapshot()).toMatchObject({
			offline: false,
			error: null,
		});
	});

	it("answers an operation with the offline line", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		const result = await runner.runOperation(
			VAULT_SPACE,
			ESyncLogOperation.Push,
			async () => {
				throw new Error("Failed to fetch");
			},
		);
		expect(result).toEqual({ ok: false, error: OFFLINE_MESSAGE });
		expect(runtimeState.getSnapshot()).toMatchObject({
			offline: true,
			error: OFFLINE_MESSAGE,
		});
	});

	it("takes any failure for offline while the browser is", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		vi.stubGlobal("navigator", { onLine: false });
		host.openSession.mockRejectedValueOnce(new Error("Something unrecognised"));

		await runner.refreshNow();

		expect(runtimeState.getSnapshot()).toMatchObject({
			offline: true,
			error: OFFLINE_MESSAGE,
		});
	});
});

/** Refreshes through the runner and returns the baseline it persisted. */
async function refreshedBaseline(
	session: TestSession,
): Promise<Manifest | null> {
	const { runner, runtimeState, host } = createTestRunner(session);
	await runner.refreshNow();
	expect(runtimeState.getSnapshot().error).toBeNull();
	return host.getState().storages[session.storage.identity()]?.baseline ?? null;
}
