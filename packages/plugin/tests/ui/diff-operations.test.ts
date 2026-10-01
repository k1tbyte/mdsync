import { describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import { EDiffDirection, type FileDiffModel } from "@/sync/projection";
import { EChoiceKind, HunkChoices } from "@/ui/diff/choices";
import type { HistoryChange } from "@/ui/diff/history-state";
import type {
	DiffOperationCallbacks,
	DiffOperationState,
} from "@/ui/diff/operations";
import { DiffOperations } from "@/ui/diff/operations";

function fakeModel(overrides: Partial<FileDiffModel> = {}): FileDiffModel {
	return {
		path: "note.md",
		direction: EDiffDirection.History,
		changeType: "conflict",
		leftText: "old",
		rightText: "new",
		baseText: null,
		hunks: { hunks: [], leftLines: [], rightLines: [] },
		leftLabel: "Version",
		rightLabel: "Current",
		isBinary: false,
		leftHash: "aaa",
		rightHash: "bbb",
		forceTextAvailable: false,
		leftPresent: true,
		rightPresent: true,
		leftSize: 100,
		rightSize: 100,
		...overrides,
	};
}

function setup(stateOverrides: Partial<DiffOperationState> = {}) {
	const state: DiffOperationState = {
		path: "note.md",
		historyHash: "abc123",
		historyChange: null,
		model: fakeModel(),
		...stateOverrides,
	};

	const refreshFn = vi.fn().mockResolvedValue(undefined);
	const advanceFn = vi.fn().mockResolvedValue(undefined);
	const callbacks: DiffOperationCallbacks = {
		state: () => state,
		refresh: refreshFn,
		advance: advanceFn,
	};

	const restoreFn = vi.fn().mockResolvedValue(undefined);
	const restoreHunksFn = vi.fn().mockResolvedValue(undefined);

	const plugin = {
		app: {
			vault: { getAbstractFileByPath: () => null },
		},
		controller: {
			history: {
				restoreFileVersion: restoreFn,
				restoreHistoryHunks: restoreHunksFn,
			},
		},
	};

	const ops = new DiffOperations(plugin as unknown as PluginHost, callbacks);
	return { ops, restoreFn, restoreHunksFn, refreshFn, advanceFn };
}

describe("DiffOperations with historyChange", () => {
	it("applyChoices does nothing when historyChange is set", async () => {
		const change: HistoryChange = {
			before: { hash: "a", label: "Before" },
			after: { hash: "b", label: "After" },
		};
		const { ops, restoreHunksFn, refreshFn } = setup({
			historyChange: change,
		});

		const choices = new HunkChoices();
		choices.toggle({ hunk: 0, segment: 0 }, EChoiceKind.Restore);
		await ops.applyChoices(choices);

		expect(restoreHunksFn).not.toHaveBeenCalled();
		expect(refreshFn).not.toHaveBeenCalled();
	});

	it("applyChoices works normally without historyChange", async () => {
		const { ops, restoreHunksFn } = setup();

		const choices = new HunkChoices();
		choices.toggle({ hunk: 0, segment: 0 }, EChoiceKind.Restore);
		await ops.applyChoices(choices);

		expect(restoreHunksFn).toHaveBeenCalledOnce();
	});
});

describe("DiffOperations.restoreVersion uses selected hash", () => {
	it.each(["add", "modify", "delete"])(
		"confirms the correct %s side and label",
		async (action) => {
			const restoreMod = await import("@/ui/source-control/restore-modal");
			const spy = vi
				.spyOn(restoreMod, "confirmRestore")
				.mockResolvedValue(true);
			const before = { hash: "before", label: "Before push", size: 100 };
			const after = { hash: "after", label: "After push", size: 120 };
			const selected = action === "delete" ? before : after;
			const { ops, restoreFn } = setup({
				historyHash: selected.hash,
				historyChange: {
					before: action === "add" ? null : before,
					after: action === "delete" ? null : after,
				},
				model: fakeModel({
					leftLabel: action === "add" ? "(did not exist)" : before.label,
				}),
			});
			await ops.restoreVersion();
			expect(spy.mock.calls[0]?.[0].version).toEqual(selected);
			expect(restoreFn).toHaveBeenCalledWith("note.md", selected.hash);
			spy.mockRestore();
		},
	);

	it("does not restore if confirmation is cancelled", async () => {
		const restoreMod = await import("@/ui/source-control/restore-modal");
		const spy = vi.spyOn(restoreMod, "confirmRestore").mockResolvedValue(false);
		const { ops, restoreFn } = setup();
		await ops.restoreVersion();
		expect(restoreFn).not.toHaveBeenCalled();
		spy.mockRestore();
	});

	it("restores using the historyHash which is the selected version", async () => {
		const restoreMod = await import("@/ui/source-control/restore-modal");
		const spy = vi.spyOn(restoreMod, "confirmRestore").mockResolvedValue(true);

		const { ops, restoreFn } = setup({ historyHash: "selected-hash" });
		await ops.restoreVersion();

		expect(spy).toHaveBeenCalledOnce();
		const opts = spy.mock.calls[0]?.[0];
		expect(opts?.version.hash).toBe("selected-hash");
		expect(restoreFn).toHaveBeenCalledWith("note.md", "selected-hash");

		spy.mockRestore();
	});

	it("does nothing without historyHash", async () => {
		const { ops, restoreFn } = setup({ historyHash: null });
		await ops.restoreVersion();
		expect(restoreFn).not.toHaveBeenCalled();
	});
});
