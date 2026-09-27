import { TFile, TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { registerIgnoreState } from "@/plugin/ignore-state";
import { type Space, VAULT_SPACE } from "@/sync/space";

/** Paths ending in "/" are folders. */
function setup(notes: Record<string, string>, paths: string[]) {
	let spaces: Space[] = [VAULT_SPACE];
	const files = paths.map((path) =>
		path.endsWith("/")
			? Object.assign(new TFolder(), { path: path.slice(0, -1) })
			: Object.assign(new TFile(), { path }),
	);
	const plugin = {
		settings: { ignorePatterns: "" },
		spaces: { partition: () => spaces },
		registerEvent: () => {},
		app: {
			workspace: { onLayoutReady: () => {} },
			vault: {
				on: () => ({}),
				getAllLoadedFiles: () => files,
				getAbstractFileByPath: (path: string) =>
					files.find((file) => file.path === path) ??
					(path in notes ? Object.assign(new TFile(), { path }) : null),
				read: async (file: TFile) => notes[file.path] ?? "",
			},
		},
	};
	const state = registerIgnoreState(
		plugin as unknown as Parameters<typeof registerIgnoreState>[0],
	);
	return { state, mount: (next: Space[]) => (spaces = next) };
}

describe("ignore state", () => {
	it("answers each path by the rules of the space that holds it", async () => {
		const { state, mount } = setup(
			{ "syncignore.md": "*.pdf", "Team/syncignore.md": "/drafts/" },
			["a.pdf", "Team/b.pdf", "Team/drafts/", "Team/drafts/x.md"],
		);
		mount([VAULT_SPACE, { id: "a", root: "Team" }]);
		await state.refresh();

		expect(state.isIgnoredGlobally("a.pdf")).toBe(true);
		expect(state.isIgnoredGlobally("Team/b.pdf")).toBe(false);
		expect(state.isIgnoredGlobally("Team/drafts")).toBe(true);
		expect([...state.ignoredPaths()]).toEqual([
			"a.pdf",
			"Team/drafts",
			"Team/drafts/x.md",
		]);
	});

	it("catches up once a share mounts after the last refresh", async () => {
		const { state, mount } = setup(
			{ "syncignore.md": "*.pdf", "Team/syncignore.md": "/drafts/" },
			["Team/b.pdf", "Team/drafts/x.md"],
		);
		await state.refresh();
		expect([...state.ignoredPaths()]).toEqual(["Team/b.pdf"]);

		mount([VAULT_SPACE, { id: "a", root: "Team" }]);
		const notified = vi.fn();
		state.subscribe(notified);
		expect([...state.ignoredPaths()]).toEqual([]);
		await vi.waitFor(() => expect(notified).toHaveBeenCalled());
		expect([...state.ignoredPaths()]).toEqual(["Team/drafts/x.md"]);
	});
});
