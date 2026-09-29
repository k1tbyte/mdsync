import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import { TimelineActions } from "@/ui/source-control/timeline-actions";
import type { TimelineFileRow } from "@/ui/source-control/timeline-rows";

const { confirmRestore, notifyError, notifyInfo } = vi.hoisted(() => ({
	confirmRestore: vi.fn(),
	notifyError: vi.fn(),
	notifyInfo: vi.fn(),
}));

vi.mock("@/ui/source-control/restore-modal", () => ({ confirmRestore }));
vi.mock("@/ui/common/notices", () => ({ notifyError, notifyInfo }));

const before = { hash: "before", label: "Before push", size: 100 };
const after = { hash: "after", label: "After push", size: 120 };

function setup() {
	const restoreFileVersion = vi.fn().mockResolvedValue(undefined);
	const plugin = {
		controller: { history: { restoreFileVersion } },
	} as unknown as PluginHost;
	return {
		actions: new TimelineActions(plugin, vi.fn(), vi.fn()),
		restoreFileVersion,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	confirmRestore.mockResolvedValue(true);
});

describe("Timeline file restoration", () => {
	it.each([
		{ action: "add", version: after, before: null, after, size: after.size },
		{ action: "modify", version: after, before, after, size: after.size },
		{
			action: "delete",
			version: before,
			before,
			after: null,
			size: before.size,
		},
	] as const)(
		"confirms and restores the selected $action version",
		async (change) => {
			const { actions, restoreFileVersion } = setup();
			const file: TimelineFileRow = { path: "notes/file.md", ...change };
			await actions.restoreFile(file);
			expect(confirmRestore).toHaveBeenCalledWith(
				expect.objectContaining({
					path: file.path,
					target: file.path,
					version: file.version,
				}),
			);
			expect(restoreFileVersion).toHaveBeenCalledExactlyOnceWith(
				file.path,
				file.version.hash,
			);
		},
	);

	it("does not write when confirmation is cancelled", async () => {
		const { actions, restoreFileVersion } = setup();
		confirmRestore.mockResolvedValue(false);
		await actions.restoreFile({
			path: "notes/file.md",
			action: "modify",
			version: after,
			before,
			after,
			size: after.size,
		});
		expect(restoreFileVersion).not.toHaveBeenCalled();
		expect(notifyInfo).not.toHaveBeenCalled();
	});

	it("reports a missing remote version without reporting a successful restore", async () => {
		const { actions, restoreFileVersion } = setup();
		const error = new Error("Version content is no longer available");
		restoreFileVersion.mockRejectedValue(error);
		await actions.restoreFile({
			path: "gone.md",
			action: "delete",
			version: before,
			before,
			after: null,
			size: before.size,
		});
		expect(notifyError).toHaveBeenCalledWith("Restore failed", error);
		expect(notifyInfo).not.toHaveBeenCalled();
	});
});
