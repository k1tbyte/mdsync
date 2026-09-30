import { describe, expect, it } from "vitest";
import { EChangeType } from "@/sync/types";
import {
	foldMoves,
	rowFromChange,
	rowFromConflict,
} from "@/ui/source-control/row-formatter";

describe("source control row formatting", () => {
	it("keeps a change size for compact display", () => {
		const row = rowFromChange(
			{
				path: "notes/example.md",
				type: EChangeType.LocalModify,
				localHash: "local",
				remoteHash: "remote",
			},
			2048,
			1024,
		);

		expect(row.size).toBe(2048);
		expect(row.sizeDelta).toBe(1024);
		expect(row.statusLetter).toBe("M");
	});

	it.each([
		{ size: 2048, previous: 1024, delta: 1024 },
		{ size: 512, previous: 1024, delta: -512 },
		{ size: 1024, previous: 1024, delta: 0 },
	])("calculates a $delta byte modified delta", ({ size, previous, delta }) => {
		const row = rowFromChange(
			{
				path: "notes/example.md",
				type: EChangeType.RemoteModify,
				localHash: "local",
				remoteHash: "remote",
			},
			size,
			previous,
		);

		expect(row.sizeDelta).toBe(delta);
	});

	it("preserves zero-byte sizes", () => {
		const row = rowFromConflict(
			{
				path: "empty.md",
				localHash: "local",
				remoteHash: "remote",
				baselineHash: null,
			},
			0,
		);

		expect(row.size).toBe(0);
		expect(row.statusLetter).toBe("C");
	});

	it("does not show a delta for additions", () => {
		const row = rowFromChange(
			{
				path: "new.md",
				type: EChangeType.LocalAdd,
				localHash: "local",
				remoteHash: null,
			},
			512,
			0,
		);

		expect(row.sizeDelta).toBeUndefined();
	});

	it("folds a move into one row at its new path", () => {
		const change = (path: string, type: EChangeType) => ({
			path,
			type,
			localHash: null,
			remoteHash: null,
		});
		const rows = foldMoves(
			[
				change("a.md", EChangeType.LocalDelete),
				change("x.md", EChangeType.LocalModify),
				change("b.md", EChangeType.LocalAdd),
			],
			[{ from: "a.md", to: "b.md", side: "local" }],
			(c) => rowFromChange(c),
		);
		expect(rows.map((r) => [r.path, r.from, r.statusLetter])).toEqual([
			["b.md", "a.md", "R"],
			["x.md", undefined, "M"],
		]);
	});
});
