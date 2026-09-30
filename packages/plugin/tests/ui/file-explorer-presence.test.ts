import { ALEX, host, LAPTOP, SAM } from "@tests/helpers/explorer-host";
import { describe, expect, it } from "vitest";

import { type Space, VAULT_SPACE } from "@/sync/space";
import { presenceMarks } from "@/ui/explorer/file-explorer-presence";

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
});
