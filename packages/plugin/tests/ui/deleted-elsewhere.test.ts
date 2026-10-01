import { describe, expect, it, vi } from "vitest";

import { VAULT_SPACE } from "@/sync/space";
import { createDeletedElsewhere } from "@/ui/live/deleted-elsewhere";
import { openChoiceModal } from "@/ui/modals";

vi.mock("@/ui/modals", () => ({ openChoiceModal: vi.fn() }));
vi.mock("@/ui/common", () => ({
	notifyError: vi.fn(),
	runWithNotice: vi.fn(async (run: () => Promise<unknown>) => run()),
}));

const PATH = "Team/Plan.md";

function host(readOnly = false) {
	const file = { path: PATH, basename: "Plan" };
	const plugin = {
		app: {
			vault: { getFileByPath: (path: string) => (path === PATH ? file : null) },
			fileManager: { trashFile: vi.fn(async () => {}) },
		},
		spaces: {
			partition: () => [VAULT_SPACE, { id: "s1", root: "Team", readOnly }],
		},
		controller: { pushPaths: vi.fn(async () => ({ ok: true })) },
	};
	const deleted = createDeletedElsewhere(
		plugin as unknown as Parameters<typeof createDeletedElsewhere>[0],
	);
	return { plugin, file, deleted };
}

function answer(choice: "delete" | "keep" | null): void {
	vi.mocked(openChoiceModal).mockResolvedValueOnce(choice);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a note deleted on another device while open here", () => {
	it("goes to the trash here when the person says so", async () => {
		const { plugin, file, deleted } = host();
		answer("delete");
		deleted(PATH);
		await settle();
		expect(plugin.app.fileManager.trashFile).toHaveBeenCalledWith(file);
		expect(plugin.controller.pushPaths).not.toHaveBeenCalled();
	});

	it("is pushed back when kept, unless the share is read-only", async () => {
		const writable = host();
		answer("keep");
		writable.deleted(PATH);
		await settle();
		expect(writable.plugin.controller.pushPaths).toHaveBeenCalledWith([PATH]);

		const readOnly = host(true);
		answer("keep");
		readOnly.deleted(PATH);
		await settle();
		expect(readOnly.plugin.controller.pushPaths).not.toHaveBeenCalled();
	});

	it("stays as it is when dismissed, and is asked about once at a time", async () => {
		const { plugin, deleted } = host();
		vi.mocked(openChoiceModal).mockClear();
		answer(null);
		deleted(PATH);
		deleted(PATH);
		await settle();
		expect(openChoiceModal).toHaveBeenCalledOnce();
		expect(plugin.app.fileManager.trashFile).not.toHaveBeenCalled();
		expect(plugin.controller.pushPaths).not.toHaveBeenCalled();
	});
});
