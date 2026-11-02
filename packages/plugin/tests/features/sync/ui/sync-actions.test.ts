import { describe, expect, it } from "vitest";

import type { SyncController } from "@/features/sync/controller";
import { heldByConflicts } from "@/features/sync/ui/sync-actions";

type Held = Pick<SyncController, "getSnapshot" | "spaceFor">;

/** A vault with one shared folder at "Shared"; `conflicts` are the compare's. */
function controller(conflicts: string[]): Held {
	return {
		getSnapshot: () =>
			({
				result: {
					diff: { conflicts: conflicts.map((path) => ({ path })) },
				},
			}) as unknown as ReturnType<SyncController["getSnapshot"]>,
		spaceFor: (path: string) =>
			path.startsWith("Shared/")
				? { id: "share", root: "Shared" }
				: { id: "vault", root: "" },
	};
}

describe("heldByConflicts", () => {
	it("lets everything go without a conflict", () => {
		expect(heldByConflicts(controller([]), ["a.md"])).toBeNull();
	});

	it("holds any path of the space a conflict is in, naming it", () => {
		expect(heldByConflicts(controller(["Inbox.md"]), ["Phone.md"])).toBe(
			'Resolve the conflict in "Inbox.md" first: nothing pushes or pulls until then.',
		);
	});

	it("counts several conflicts", () => {
		expect(heldByConflicts(controller(["a.md", "b.md"]), ["c.md"])).toBe(
			"Resolve the 2 conflicts first: nothing pushes or pulls until then.",
		);
	});

	it("leaves another space alone", () => {
		expect(
			heldByConflicts(controller(["Inbox.md"]), ["Shared/plan.md"]),
		).toBeNull();
		expect(
			heldByConflicts(controller(["Shared/plan.md"]), ["Phone.md"]),
		).toBeNull();
	});

	it("names only the conflicts of the spaces asked for", () => {
		expect(
			heldByConflicts(controller(["Inbox.md", "Shared/plan.md"]), [
				"Shared/notes.md",
			]),
		).toBe(
			'Resolve the conflict in "Shared/plan.md" first: nothing pushes or pulls until then.',
		);
	});
});
