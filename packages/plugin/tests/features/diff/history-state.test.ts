import { describe, expect, it } from "vitest";
import {
	buildHistoryRequest,
	changesDiffer,
	fileTarget,
	type HistoryChange,
	type HistoryModeInput,
	hunkHintText,
	readTarget,
	sameTarget,
	selectHistoryMode,
	targetState,
} from "@/features/diff/history-state";
import { HUNK_TEXT_MAX_BYTES } from "@/features/sync/constants";
import {
	EDiffDirection,
	type FileDiffModel,
} from "@/features/sync/hunks/projection";

function modeInput(
	overrides: Partial<HistoryModeInput> = {},
): HistoryModeInput {
	return {
		historyHash: "abc123",
		historyChange: null,
		historyPreviewIfMissing: false,
		against: null,
		localExists: true,
		...overrides,
	};
}

describe("selectHistoryMode", () => {
	it("returns diff when no historyHash", () => {
		expect(selectHistoryMode(modeInput({ historyHash: null }))).toBe("diff");
	});

	it("returns change when historyChange is set", () => {
		const change: HistoryChange = {
			before: { hash: "a", label: "Before" },
			after: { hash: "b", label: "After" },
		};
		expect(selectHistoryMode(modeInput({ historyChange: change }))).toBe(
			"change",
		);
	});

	it("returns diff when against is set (even with previewIfMissing)", () => {
		expect(
			selectHistoryMode(
				modeInput({
					against: { hash: "x", label: "Other" },
					historyPreviewIfMissing: true,
					localExists: false,
				}),
			),
		).toBe("diff");
	});

	it("returns preview when previewIfMissing and local missing", () => {
		expect(
			selectHistoryMode(
				modeInput({ historyPreviewIfMissing: true, localExists: false }),
			),
		).toBe("preview");
	});

	it("returns diff when previewIfMissing but local exists", () => {
		expect(
			selectHistoryMode(
				modeInput({ historyPreviewIfMissing: true, localExists: true }),
			),
		).toBe("diff");
	});

	it("change takes priority over previewIfMissing", () => {
		const change: HistoryChange = {
			before: null,
			after: { hash: "b", label: "After" },
		};
		expect(
			selectHistoryMode(
				modeInput({
					historyChange: change,
					historyPreviewIfMissing: true,
					localExists: false,
				}),
			),
		).toBe("change");
	});
});

describe("buildHistoryRequest", () => {
	it("builds change request with absent before (added file)", () => {
		const change: HistoryChange = {
			before: null,
			after: { hash: "h2", label: "After", size: 200 },
		};
		const req = buildHistoryRequest({
			path: "note.md",
			historyHash: "h2",
			historyLabel: "After",
			historySize: 200,
			historyChange: change,
			against: null,
			forceText: false,
		});
		expect(req.left).toEqual({ absent: true, label: "(did not exist)" });
		expect(req.right).toEqual({
			version: { hash: "h2", label: "After", size: 200 },
		});
	});

	it("builds change request with absent after (deleted file)", () => {
		const change: HistoryChange = {
			before: { hash: "h1", label: "Before", size: 100 },
			after: null,
		};
		const req = buildHistoryRequest({
			path: "note.md",
			historyHash: "h1",
			historyLabel: "Before",
			historySize: 100,
			historyChange: change,
			against: null,
			forceText: false,
		});
		expect(req.left).toEqual({
			version: { hash: "h1", label: "Before", size: 100 },
		});
		expect(req.right).toEqual({ absent: true, label: "(deleted)" });
	});

	it("builds diff request with current right side when no against", () => {
		const req = buildHistoryRequest({
			path: "note.md",
			historyHash: "abc",
			historyLabel: "Version",
			historySize: 50,
			historyChange: null,
			against: null,
			forceText: true,
		});
		expect(req.left).toEqual({
			version: { hash: "abc", label: "Version", size: 50 },
		});
		expect(req.right).toEqual({ current: true });
		expect(req.forceText).toBe(true);
	});

	it("builds diff request with against version", () => {
		const against = { hash: "xyz", label: "Other", size: 300 };
		const req = buildHistoryRequest({
			path: "note.md",
			historyHash: "abc",
			historyLabel: "V1",
			historySize: 50,
			historyChange: null,
			against,
			forceText: false,
		});
		expect(req.right).toEqual({ version: against });
	});
});

describe("diff targets", () => {
	const version = readTarget(
		{ path: "a.md", historyHash: "h1", historyLabel: "Pin", historySize: 5 },
		null,
	);

	it("keeps the current path for a state without one, and resets the rest", () => {
		expect(readTarget({ historyHash: "h1" }, "a.md")).toMatchObject({
			path: "a.md",
			historyLabel: "Version",
			against: null,
		});
	});

	it("round-trips through the stored state", () => {
		const against = readTarget(
			{ ...targetState(version), againstHash: "h2", againstLabel: "B" },
			null,
		);
		expect(readTarget(targetState(against), null)).toEqual(against);
	});

	it("reloads for another version or a renamed pin, not for a size", () => {
		expect(sameTarget(version, { ...version, historySize: 9 })).toBe(true);
		expect(sameTarget(version, { ...version, historyLabel: "Renamed" })).toBe(
			false,
		);
		expect(sameTarget(version, { ...version, historyHash: "h2" })).toBe(false);
		expect(sameTarget(version, fileTarget("a.md"))).toBe(false);
	});

	it("ignores a label on the file itself", () => {
		const file = fileTarget("a.md");
		expect(sameTarget(file, { ...file, historyLabel: "Other" })).toBe(true);
	});
});

describe("changesDiffer", () => {
	it("returns false for identical nulls", () => {
		expect(changesDiffer(null, null)).toBe(false);
	});

	it("returns true when one is null", () => {
		expect(changesDiffer({ before: null, after: null }, null)).toBe(true);
		expect(changesDiffer(null, { before: null, after: null })).toBe(true);
	});

	it("refreshes labels even when hashes match", () => {
		const a: HistoryChange = {
			before: { hash: "a", label: "A" },
			after: { hash: "b", label: "B" },
		};
		const b: HistoryChange = {
			before: { hash: "a", label: "Different" },
			after: { hash: "b", label: "Also different" },
		};
		expect(changesDiffer(a, b)).toBe(true);
	});

	it("returns true when hashes differ", () => {
		const a: HistoryChange = {
			before: { hash: "a", label: "A" },
			after: { hash: "b", label: "B" },
		};
		const b: HistoryChange = {
			before: { hash: "a", label: "A" },
			after: { hash: "c", label: "C" },
		};
		expect(changesDiffer(a, b)).toBe(true);
	});

	it("returns same reference as not different", () => {
		const a: HistoryChange = { before: null, after: { hash: "x", label: "X" } };
		expect(changesDiffer(a, a)).toBe(false);
	});
});

function fakeModel(overrides: Partial<FileDiffModel> = {}): FileDiffModel {
	return {
		path: "note.md",
		direction: EDiffDirection.History,
		changeType: "conflict",
		leftText: "",
		rightText: "",
		baseText: null,
		hunks: { hunks: [], leftLines: [], rightLines: [] },
		leftLabel: "Version",
		rightLabel: "Current",
		isBinary: false,
		leftHash: "a",
		rightHash: "b",
		forceTextAvailable: false,
		leftPresent: true,
		rightPresent: true,
		leftSize: 100,
		rightSize: 100,
		...overrides,
	};
}

describe("hunkHintText", () => {
	it("mentions too large when over limit", () => {
		const text = hunkHintText({
			model: fakeModel({ leftSize: HUNK_TEXT_MAX_BYTES + 1 }),
			historyChange: null,
			against: null,
		});
		expect(text).toContain("too large");
	});

	it("mentions historical change when historyChange set", () => {
		const text = hunkHintText({
			model: fakeModel(),
			historyChange: { before: null, after: { hash: "x", label: "X" } },
			against: null,
		});
		expect(text).toContain("historical change");
	});

	it("mentions comparing versions when against set", () => {
		const text = hunkHintText({
			model: fakeModel(),
			historyChange: null,
			against: { hash: "y", label: "Y" },
		});
		expect(text).toContain("Comparing two stored versions");
	});

	it("mentions a missing vault file", () => {
		const text = hunkHintText({
			model: fakeModel({ rightPresent: false }),
			historyChange: null,
			against: null,
		});
		expect(text).toContain("not in the vault");
	});

	it("has nothing to say when per-change actions are on", () => {
		const text = hunkHintText({
			model: fakeModel(),
			historyChange: null,
			against: null,
		});
		expect(text).toBeNull();
	});
});
