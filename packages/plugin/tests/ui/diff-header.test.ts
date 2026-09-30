import { FakeEl } from "@tests/helpers/fake-obsidian-dom";
import { describe, expect, it, vi } from "vitest";
import { EDiffDirection } from "@/sync/projection";
import { type DiffHeaderActions, renderDiffHeader } from "@/ui/diff/header";

const actions = Object.fromEntries(
	[
		"saveResolution",
		"cancelResolution",
		"restoreVersion",
		"keepLocal",
		"acceptRemote",
		"keepBothVersions",
		"startMerge",
		"goPrevFile",
		"goNextFile",
		"goBack",
	].map((name) => [name, vi.fn()]),
) as unknown as DiffHeaderActions;

function render(
	overrides: Partial<Parameters<typeof renderDiffHeader>[1]> = {},
): { header: FakeEl; fileActions: FakeEl | null } {
	const header = new FakeEl("div");
	const fileActions = renderDiffHeader(
		header as never,
		{
			path: "Projects/Beta/Roadmap.md",
			direction: EDiffDirection.Conflict,
			isBinary: false,
			isEditing: false,
			canGoPrevFile: true,
			canGoNextFile: true,
			showBack: true,
			...overrides,
		},
		actions,
	) as unknown as FakeEl | null;
	return { header, fileActions };
}

const labelsIn = (el: FakeEl): string[] =>
	el
		.find((child) => child.tag === "button")
		.map((button) => button.attrs.get("aria-label") ?? button.text);

const titleOf = (header: FakeEl): FakeEl =>
	header.find((el) => el.hasClass("obsync-diff-title"))[0] as FakeEl;

describe("renderDiffHeader", () => {
	it("names the file first and its folder after it", () => {
		const { header } = render();
		const [path] = header.find((el) => el.hasClass("obsync-diff-path"));
		const [name, folder] = (path as FakeEl).children;
		expect(name?.hasClass("obsync-file-name")).toBe(true);
		expect(name?.text).toBe("Roadmap.md");
		expect(folder?.hasClass("obsync-file-parent")).toBe(true);
		expect(folder?.text).toBe("Projects/Beta");
	});

	it("leaves out the folder for a file at the vault root", () => {
		const { header } = render({ path: "Inbox.md" });
		expect(header.find((el) => el.hasClass("obsync-file-parent"))).toEqual([]);
	});

	it("keeps file navigation on the title row of a phone", () => {
		const { header, fileActions } = render();
		expect(labelsIn(titleOf(header))).toEqual([
			"Back to source control",
			"Previous file",
			"Next file",
		]);
		expect(labelsIn(fileActions as FakeEl)).toEqual([
			"Keep local",
			"Accept remote",
			"Keep both versions",
			"Merge…",
		]);
	});

	it("keeps save and cancel on the title row of a phone", () => {
		const { header, fileActions } = render({ isEditing: true });
		expect(labelsIn(titleOf(header))).toEqual([
			"Back to source control",
			"Save and push",
			"Cancel merge",
		]);
		expect(labelsIn(fileActions as FakeEl)).toEqual([]);
	});

	it("puts everything in one header row on desktop", () => {
		const { header, fileActions } = render({ showBack: false });
		expect(fileActions).toBeNull();
		expect(header.find((el) => el.hasClass("obsync-diff-title"))).toEqual([]);
		expect(labelsIn(header)).toEqual([
			"Keep local",
			"Accept remote",
			"Keep both versions",
			"Merge…",
			"Previous file",
			"Next file",
		]);
	});

	it("offers only a restore, named for its side, for a history diff", () => {
		const { header, fileActions } = render({
			direction: EDiffDirection.History,
			restoreLabel: "Restore this version",
		});
		expect(labelsIn(fileActions as FakeEl)).toEqual(["Restore this version"]);
		expect(labelsIn(titleOf(header))).toEqual(["Back to source control"]);
	});

	it("falls back to a generic restore label", () => {
		const { fileActions } = render({ direction: EDiffDirection.History });
		expect(labelsIn(fileActions as FakeEl)).toEqual(["Restore this version"]);
	});

	it("offers no file actions or navigation while there is no diff", () => {
		const phone = render({ direction: null });
		expect(labelsIn(phone.fileActions as FakeEl)).toEqual([]);
		expect(labelsIn(titleOf(phone.header))).toEqual(["Back to source control"]);
		const desktop = render({ direction: null, showBack: false });
		expect(desktop.fileActions).toBeNull();
		expect(labelsIn(desktop.header)).toEqual([]);
	});

	it("leaves out keep both and merge for a binary conflict", () => {
		const { fileActions } = render({ isBinary: true });
		expect(labelsIn(fileActions as FakeEl)).toEqual([
			"Keep local",
			"Accept remote",
		]);
	});

	it("hides a previous or next arrow with nowhere to go", () => {
		const { header } = render({ canGoPrevFile: false });
		expect(labelsIn(titleOf(header))).toEqual([
			"Back to source control",
			"Next file",
		]);
	});

	it("runs the action a button names", () => {
		const { fileActions } = render();
		const [keepLocal] = (fileActions as FakeEl).find(
			(el) => el.text === "Keep local",
		);
		keepLocal?.fire("click");
		expect(actions.keepLocal).toHaveBeenCalledOnce();
	});
});
