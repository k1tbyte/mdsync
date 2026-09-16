import { createTestControllerHost } from "@tests/helpers/controller";
import type { TestSession } from "@tests/helpers/session";
import { pairedSessions, useEncryptionKey } from "@tests/helpers/session";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { ESyncLogOperation } from "@/logs/store";
import { StorageRequestError } from "@/storage";
import { SyncCancelledError } from "@/sync/cancel";
import { ConcurrentPushError } from "@/sync/manifest";
import { pushPathsOp } from "@/sync/operations/push";
import { SyncControllerRuntimeState } from "@/sync/runtime/controller-state";
import { OperationRunner } from "@/sync/runtime/operation-runner";
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
	it("reports completion only after a successful operation", async () => {
		const [session] = pairedSessions();
		const { runner, host } = createTestRunner(session);
		expect(
			await runner.runOperation(ESyncLogOperation.Push, unchanged),
		).toEqual({ ok: true });
		expect(host.onPushComplete).toHaveBeenCalledOnce();
	});

	it("returns the same failure recorded in the snapshot and logs", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const error = "Request Failed. IOException Stream closed";
		const result = await runner.runOperation(
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
			'S3 HEAD to "objects/example" failed: Request Failed. IOException Stream closed';
		const message =
			"S3 request failed on this device. Check the connection and try again. See Obsync logs for details.";
		const result = await runner.runOperation(
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
			await runner.runOperation(ESyncLogOperation.Push, operation),
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
			await runner.runOperation(ESyncLogOperation.Push, operation),
		).toEqual({ ok: false, error: "Compare failed" });
		expect(operation).not.toHaveBeenCalled();
		expect(runtimeState.getSnapshot().error).toBe("Compare failed");
	});

	it("keeps cancellation separate from failure and success", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState, host } = createTestRunner(session);
		const result = await runner.runOperation(
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
			ESyncLogOperation.Push,
			async () => {
				throw new ConcurrentPushError("Remote changed", null);
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

	it("preserves the failed result when the next queued operation clears the error", async () => {
		const [session] = pairedSessions();
		const { runner, runtimeState } = createTestRunner(session);
		const first = runner.runOperation(ESyncLogOperation.Push, async () => {
			throw new Error("First failed");
		});
		const second = runner.runOperation(ESyncLogOperation.Push, unchanged);
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
