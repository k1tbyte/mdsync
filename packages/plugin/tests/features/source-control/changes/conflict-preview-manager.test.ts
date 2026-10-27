// @vitest-environment jsdom

import { installElementMethods } from "@tests/helpers/element-methods";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ConflictPreviewManager } from "@/features/source-control/changes/conflict-preview-manager";
import {
	EDiffDirection,
	type FileDiffModel,
} from "@/features/sync/hunks/projection";

beforeAll(installElementMethods);

function model(overrides: Partial<FileDiffModel> = {}): FileDiffModel {
	const lines = Array.from({ length: 14 }, (_, i) => `+line ${i}`);
	return {
		path: "a.md",
		direction: EDiffDirection.Conflict,
		changeType: "conflict",
		leftText: "left",
		rightText: "right",
		baseText: "base",
		hunks: { hunks: [{ lines }], leftLines: [], rightLines: [] },
		leftLabel: "Local",
		rightLabel: "Remote",
		isBinary: false,
		leftHash: "l",
		rightHash: "r",
		forceTextAvailable: false,
		leftPresent: true,
		rightPresent: true,
		leftSize: 4,
		rightSize: 5,
		...overrides,
	} as unknown as FileDiffModel;
}

function mount(): HTMLElement {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	return parent;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ConflictPreviewManager", () => {
	it("renders the first lines and the remaining count from a cached summary", async () => {
		const loadPreview = vi.fn(async () => model());
		const previews = new ConflictPreviewManager({ loadPreview });
		const first = mount();
		previews.render(first, "a.md");
		await flush();
		expect(first.querySelectorAll(".mdsync-unified-line")).toHaveLength(10);
		expect(first.textContent).toContain("4 more line(s)");

		const second = mount();
		previews.render(second, "a.md");
		expect(second.querySelectorAll(".mdsync-unified-line")).toHaveLength(10);
		expect(loadPreview).toHaveBeenCalledTimes(1);
	});

	it("keeps no model after loading: toggling a preview off releases it", async () => {
		const loadPreview = vi.fn(async () => model());
		const previews = new ConflictPreviewManager({ loadPreview });
		previews.toggle("a.md");
		previews.render(mount(), "a.md");
		await flush();
		previews.toggle("a.md");
		previews.render(mount(), "a.md");
		await flush();
		expect(loadPreview).toHaveBeenCalledTimes(2);
	});

	it("drops the cache of a path that stopped conflicting", async () => {
		const loadPreview = vi.fn(async () => model());
		const previews = new ConflictPreviewManager({ loadPreview });
		previews.toggle("a.md");
		previews.render(mount(), "a.md");
		await flush();
		previews.prune([]);
		previews.render(mount(), "a.md");
		await flush();
		expect(loadPreview).toHaveBeenCalledTimes(2);
	});

	it("shows binary and missing states and retries a failure", async () => {
		const loadPreview = vi
			.fn<(path: string) => Promise<FileDiffModel | null>>()
			.mockResolvedValueOnce(model({ isBinary: true }))
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue(model({ hunks: { hunks: [] } as never }));
		const previews = new ConflictPreviewManager({ loadPreview });

		const binary = mount();
		previews.render(binary, "bin");
		await flush();
		expect(binary.textContent).toContain("Binary file");

		const failed = mount();
		previews.render(failed, "x.md");
		await flush();
		expect(failed.textContent).toBe("No diff available.");

		const retried = mount();
		previews.render(retried, "x.md");
		await flush();
		expect(retried.textContent).toContain("No textual differences.");
		expect(loadPreview).toHaveBeenCalledTimes(3);
	});
});
