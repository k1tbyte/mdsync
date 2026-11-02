import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceControlHost } from "@/features/source-control/host";
import { confirmAndRestoreFile } from "@/features/source-control/restore-file";

const { confirmRestore, notifyError, notifyInfo } = vi.hoisted(() => ({
	confirmRestore: vi.fn(),
	notifyError: vi.fn(),
	notifyInfo: vi.fn(),
}));

vi.mock("@/features/diff/ui/restore-modal", () => ({ confirmRestore }));
vi.mock("@/core/ui/notices", () => ({ notifyError, notifyInfo }));

const restoreFileVersion = vi.fn();
const plugin = {
	controller: { history: { restoreFileVersion } },
} as unknown as SourceControlHost;
const confirm = {
	path: "notes/a.md",
	target: "notes/b.md",
	version: { hash: "H1", label: "2 days ago", size: 10 },
};

beforeEach(() => {
	vi.clearAllMocks();
	confirmRestore.mockResolvedValue(true);
	restoreFileVersion.mockResolvedValue(undefined);
});

describe("confirmAndRestoreFile", () => {
	it("asks about the target, restores the version read under its own path there, says so and runs the callback", async () => {
		const after = vi.fn();
		await confirmAndRestoreFile(plugin, confirm, "Restored.", after);

		expect(confirmRestore).toHaveBeenCalledWith({ ...confirm, plugin });
		expect(restoreFileVersion).toHaveBeenCalledExactlyOnceWith(
			"notes/b.md",
			"H1",
			"notes/a.md",
		);
		expect(notifyInfo).toHaveBeenCalledExactlyOnceWith("Restored.");
		expect(after).toHaveBeenCalledOnce();
	});

	it("stops on cancel without a notice", async () => {
		confirmRestore.mockResolvedValue(false);
		const after = vi.fn();
		await confirmAndRestoreFile(plugin, confirm, "Restored.", after);

		expect(restoreFileVersion).not.toHaveBeenCalled();
		expect(notifyInfo).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
	});

	it("reports a failed restore, with no success notice or callback", async () => {
		const error = new Error("gone");
		restoreFileVersion.mockRejectedValue(error);
		const after = vi.fn();
		await confirmAndRestoreFile(plugin, confirm, "Restored.", after);

		expect(notifyError).toHaveBeenCalledExactlyOnceWith(
			"Restore failed",
			error,
		);
		expect(notifyInfo).not.toHaveBeenCalled();
		expect(after).not.toHaveBeenCalled();
	});
});
