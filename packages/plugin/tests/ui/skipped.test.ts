import { describe, expect, it } from "vitest";

import type { SyncController } from "@/sync/controller";
import type { SkippedFile } from "@/sync/types";
import { skippedFiles, skippedText } from "@/ui/common";

const MIB = 1024 * 1024;

describe("files the sync leaves out", () => {
	it("say why, and what brings them back", () => {
		const big: SkippedFile = {
			path: "a.png",
			reason: "too-large",
			size: 100 * MIB + 1,
		};
		expect(skippedText(big, 100 * MIB)).toBe(
			"Not synced: 100.0 MB, over the 100.0 MB limit. Raise Max file size in MDSync settings to sync it.",
		);
		expect(
			skippedText({ path: "B.md", reason: "case-clash", other: "b.md" }, MIB),
		).toContain('differs from "b.md" only in case');
		expect(
			skippedText(
				{ path: "c.md", reason: "unreadable", detail: "EACCES" },
				MIB,
			),
		).toBe("Not synced: it could not be read (EACCES).");
	});

	it("are one list while nothing was compared, so a cache keyed on it holds", () => {
		const controller = {
			getSnapshot: () => ({ result: null }),
		} as unknown as SyncController;
		expect(skippedFiles(controller)).toBe(skippedFiles(controller));
	});
});
