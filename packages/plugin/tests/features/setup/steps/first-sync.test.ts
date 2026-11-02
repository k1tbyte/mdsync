import { describe, expect, it, vi } from "vitest";
import { createFirstSync, syncHeld } from "@/features/setup/steps/first-sync";
import type { Wizard } from "@/features/setup/wizard";
import type { DiffResult } from "@/features/sync";

const compared = { diff: { conflicts: [] } };

function setup(snapshot: Record<string, unknown>) {
	const controller = {
		subscribe: () => () => {},
		refresh: vi.fn(async () => {}),
		getSnapshot: () => ({
			error: null,
			spaceErrors: [],
			result: compared,
			pendingLocal: 0,
			pendingRemote: 0,
			conflicts: 0,
			...snapshot,
		}),
	};
	const wizard = {
		plugin: { controller },
		redraw: () => {},
	} as unknown as Wizard;
	return createFirstSync(wizard);
}

async function compare(snapshot: Record<string, unknown>) {
	const sync = setup(snapshot);
	sync.start();
	await new Promise((resolve) => setTimeout(resolve, 0));
	return sync;
}

describe("first sync", () => {
	it("is done once a comparison finds nothing left to move", async () => {
		expect((await compare({})).done()).toBe(true);
	});

	it("is not done when the comparison never ran, as after a cancelled passphrase prompt", async () => {
		const sync = await compare({ result: null });
		expect(sync.done()).toBe(false);
		expect(sync.leads()).toBe(true);
	});

	it("is not done while a file is left to move or an error stands", async () => {
		expect((await compare({ pendingRemote: 2 })).done()).toBe(false);
		expect((await compare({ error: "offline" })).done()).toBe(false);
	});
});

describe("syncHeld", () => {
	const spaceOf = (path: string) => (path.startsWith("shared/") ? "s" : "v");
	const conflict = (path: string, baselineHash: string | null = null) => ({
		path,
		localHash: "l",
		remoteHash: "r",
		baselineHash,
	});
	const change = (path: string) => ({ path }) as DiffResult["localChanges"][0];
	const diff = (parts: Partial<DiffResult>) =>
		({
			localChanges: [],
			remoteChanges: [],
			conflicts: [],
			...parts,
		}) as DiffResult;

	it("holds when every pending file sits in a space with a conflict that cannot merge", () => {
		expect(
			syncHeld(
				diff({
					conflicts: [conflict("shared/a.md")],
					remoteChanges: [change("shared/b.md")],
				}),
				spaceOf,
			),
		).toBe(true);
	});

	it("does not hold another space's files", () => {
		expect(
			syncHeld(
				diff({
					conflicts: [conflict("shared/a.md")],
					remoteChanges: [change("note.md")],
				}),
				spaceOf,
			),
		).toBe(false);
	});

	it("does not hold while a conflict with a common version may merge, or without conflicts", () => {
		expect(
			syncHeld(diff({ conflicts: [conflict("a.md", "b")] }), spaceOf),
		).toBe(false);
		expect(syncHeld(diff({ localChanges: [change("a.md")] }), spaceOf)).toBe(
			false,
		);
	});
});
