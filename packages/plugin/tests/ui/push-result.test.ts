import { TestSession, useEncryptionKey } from "@tests/helpers/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginHost } from "@/plugin/host";
import { SyncController } from "@/sync/controller";
import { runWithNotice } from "@/ui/notices";
import { SourceControlActions } from "@/ui/source-control/actions";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
}));

useEncryptionKey();
let controller: SyncController;

beforeEach(() => {
	notices.length = 0;
	vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	controller?.dispose();
	vi.restoreAllMocks();
});

describe("push notices", () => {
	it("reports a failed upload without success, then succeeds on another push", async () => {
		const session = new TestSession();
		session.adapter.putText("note.md", "hello");
		controller = new SyncController(createTestControllerHost(session));
		const actions = new SourceControlActions({
			plugin: { controller } as PluginHost,
			showHistory: () => {},
			openDiff: async () => {},
		});
		const error = "Request Failed. IOException Stream closed";
		vi.spyOn(session.storage, "exists").mockRejectedValueOnce(new Error(error));

		expect(await actions.pushPaths(["note.md"])).toBe(false);
		expect(controller.getSnapshot()).toMatchObject({ error, pendingLocal: 1 });
		expect(notices).toEqual([`Obsync error: Push failed - ${error}`]);

		expect(await actions.pushPaths(["note.md"])).toBe(true);
		expect(controller.getSnapshot()).toMatchObject({
			error: null,
			pendingLocal: 0,
		});
		expect(notices[notices.length - 1]).toBe("Obsync: Pushed 1 file(s).");
	});
});

describe("runWithNotice", () => {
	it.each([false, { ok: false }])(
		"does not announce an unfinished action: %j",
		async (result) => {
			expect(await runWithNotice(async () => result, "Done")).toBe(false);
			expect(notices).toEqual([]);
		},
	);

	it.each([true, { ok: true }])(
		"announces a completed action: %j",
		async (result) => {
			expect(await runWithNotice(async () => result, "Done")).toBe(true);
			expect(notices).toEqual(["Obsync: Done"]);
		},
	);

	it("announces a completed action that returns no result", async () => {
		expect(await runWithNotice(async () => {}, "Done")).toBe(true);
		expect(notices).toEqual(["Obsync: Done"]);
	});

	it("still reports a rejected action", async () => {
		expect(
			await runWithNotice(
				async () => {
					throw new Error("offline");
				},
				"Done",
				"Push failed",
			),
		).toBe(false);
		expect(notices).toEqual(["Obsync error: Push failed - offline"]);
	});
});

import { createTestControllerHost } from "@tests/helpers/controller";
