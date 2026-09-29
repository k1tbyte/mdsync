import { describe, expect, it } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { Unseen } from "@/presence/unseen";
import type { SyncController } from "@/sync/controller";
import { type Space, VAULT_SPACE } from "@/sync/space";
import { EChangeType } from "@/sync/types";
import { computeDecorations } from "@/ui/explorer/file-explorer-decorations";
import {
	presenceMarks,
	shareMarks,
} from "@/ui/explorer/file-explorer-presence";

const ALEX: Person = {
	key: "p1",
	name: "Alex",
	note: "Team/docs/a.md",
	idle: false,
};
const SAM: Person = { key: "p2", name: "Sam", note: "Team/b.md", idle: true };
const LAPTOP: Person = {
	key: "d1",
	name: "Laptop",
	note: "notes/x.md",
	idle: false,
};

function host(
	spaces: Space[],
	people: Person[],
	unseen: string[] = [],
): PluginHost {
	const notes = new Map<string, Person[]>();
	for (const person of people) {
		if (person.note) notes.set(person.note, [person]);
	}
	return {
		app: { vault: { getFileByPath: (path: string) => ({ path }) } },
		controller: {
			lastEdit: () => ({ key: "p1", name: "Alex", at: Date.now() }),
		},
		ignoreState: { ignoredPaths: () => [] },
		unseen: new Unseen({ load: () => unseen, save: () => {} }),
		spaces: { partition: () => spaces },
		settings: {
			spaces: [
				{ id: "own", access: { kind: "owner" } },
				{ id: "in", access: { kind: "participant", readOnly: false } },
			],
		},
		realtime: {
			people: {
				online: (id: string) =>
					id === "own" ? people.filter((p) => p.note?.startsWith("Team/")) : [],
				notes: () => notes,
			},
		},
	} as unknown as PluginHost;
}

describe("presence in the file explorer", () => {
	const spaces: Space[] = [
		VAULT_SPACE,
		{ id: "own", root: "Team" },
		{ id: "in", root: "Shared/Club" },
		{ id: "ro", root: "Shared/News", readOnly: true },
		{ id: "off", root: "Paused", paused: true },
	];

	it("marks each share root with its kind and who is at its notes", () => {
		const marks = presenceMarks(host(spaces, [ALEX, SAM]), () => false);

		expect(marks.get("Team")?.share).toEqual({
			root: "Team",
			kind: "owned",
			here: 1,
		});
		expect(marks.get("Shared/Club")?.share?.kind).toBe("joined");
		expect(marks.get("Shared/News")?.share?.kind).toBe("read-only");
		expect(marks.get("Paused")?.share?.kind).toBe("paused");
		expect(marks.get("Team/docs/a.md")?.people).toEqual([ALEX]);
	});

	it("hands people in a collapsed folder to the outermost collapsed row", () => {
		const collapsed = new Set(["Team", "Team/docs"]);
		const marks = presenceMarks(host(spaces, [ALEX, SAM]), (folder) =>
			collapsed.has(folder),
		);

		expect(marks.get("Team")?.people?.map(({ name }) => name)).toEqual([
			"Alex",
			"Sam",
		]);
		expect(marks.has("Team/docs/a.md")).toBe(false);
	});

	it("dots what others changed, counted on a collapsed folder", () => {
		const unseen = ["Team/a.md", "Team/docs/b.md", "Team/docs/c.md"];
		const marks = presenceMarks(
			host(spaces, [], unseen),
			(folder) => folder === "Team/docs",
		);

		expect(marks.get("Team/a.md")?.unseen).toBe("Changed by Alex, just now");
		expect(marks.get("Team/docs")?.unseen).toBe(
			"2 changed by others since you opened them",
		);
	});

	it("leaves the vault's own devices out of the tree", () => {
		const marks = presenceMarks(host(spaces, [LAPTOP]), () => false);

		expect(marks.has("notes/x.md")).toBe(false);
	});

	it("keeps the share badges alone when indicators are off", () => {
		const plugin = host(spaces, [ALEX], ["Team/a.md"]);
		const controller = {
			fileDiffs: {
				getChangedPathStatuses: () =>
					new Map([[ALEX.note as string, EChangeType.LocalAdd]]),
			},
		} as unknown as SyncController;
		const args = [plugin, controller, new Map(), () => false] as const;

		const off = computeDecorations(...args, false);
		const on = computeDecorations(...args, true);

		expect([...off.keys()]).toEqual([...shareMarks(plugin).keys()]);
		expect([...off.values()].every(({ share }) => share)).toBe(true);
		expect(on.get(ALEX.note as string)?.people).toEqual([ALEX]);
		expect(on.get(ALEX.note as string)?.change).toBe("obsync-changed-added");
		expect(on.get("Team/a.md")?.unseen).toBeDefined();
		expect(off.get("Team/a.md")?.unseen).toBeUndefined();
	});
});
