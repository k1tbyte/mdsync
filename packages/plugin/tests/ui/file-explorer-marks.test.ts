import { ALEX, host, LAPTOP, LINK, SAM } from "@tests/helpers/explorer-host";
import { describe, expect, it, vi } from "vitest";

import { type Space, VAULT_SPACE } from "@/sync/space";
import { presenceMarks, shareMarks } from "@/ui/explorer/file-explorer-marks";

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

	it("dots what others changed, counted on a collapsed folder, without reading who changed it", () => {
		const unseen = ["Team/a.md", "Team/docs/b.md", "Team/docs/c.md"];
		const plugin = host(spaces, [], unseen);
		const lastEdit = vi.spyOn(plugin.controller, "lastEdit");
		const marks = presenceMarks(plugin, (folder) => folder === "Team/docs");

		expect(marks.get("Team/a.md")?.unseen).toEqual({
			count: 1,
			file: "Team/a.md",
		});
		expect(marks.get("Team/docs")?.unseen).toEqual({ count: 2 });
		expect(lastEdit).not.toHaveBeenCalled();
	});

	it.each([false, true])("marks published notes with indicators %s", (on) => {
		const plugin = host(spaces, [], [], [LINK, { ...LINK, id: "second" }]);
		const marks = on ? presenceMarks(plugin, () => false) : shareMarks(plugin);

		expect(marks.get(LINK.path)?.published).toEqual({
			path: LINK.path,
			count: 2,
			stale: false,
			text: "Shared by 2 links. Click to manage.",
		});
	});

	it("marks a note modified after publication as stale", () => {
		const plugin = host(spaces, [], [], [LINK]);
		vi.spyOn(plugin.app.vault, "getFileByPath").mockReturnValue({
			path: LINK.path,
			stat: { mtime: LINK.publishedAt + 1 },
		} as ReturnType<typeof plugin.app.vault.getFileByPath>);

		const mark = shareMarks(plugin).get(LINK.path)?.published;

		expect(mark?.stale).toBe(true);
		expect(mark?.text).toContain("Changed since it was shared");
	});

	it("omits notes whose only link expired", () => {
		const plugin = host(spaces, [], [], [{ ...LINK, expires: 1 }]);

		expect(shareMarks(plugin).has(LINK.path)).toBe(false);
	});

	it("leaves the vault's own devices out of the tree", () => {
		const marks = presenceMarks(host(spaces, [LAPTOP]), () => false);

		expect(marks.has("notes/x.md")).toBe(false);
	});
});
