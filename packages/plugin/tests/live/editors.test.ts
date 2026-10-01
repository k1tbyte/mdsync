import type { App } from "obsidian";
import { describe, expect, it } from "vitest";

import { EDITORS, readOpen } from "@/live/workspace/editors";

describe("readOpen", () => {
	it("fails for a note gone mid-join instead of reading it as emptied", async () => {
		const app = {
			workspace: { getLeavesOfType: () => [] },
			vault: { getFileByPath: () => null },
		} as unknown as App;

		await expect(readOpen(app, "gone.md", EDITORS.text)).rejects.toThrow();
	});
});
