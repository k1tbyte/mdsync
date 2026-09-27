import { TFolder } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { createMoveFollower, registerShareRenames } from "@/plugin/share-moves";
import type { SpaceRecord } from "@/spaces/record";
import { SpaceRecords } from "@/spaces/records";

type MoveVault = Parameters<typeof createMoveFollower>[0];

const TEAM: SpaceRecord = {
	id: "a",
	name: "Team",
	root: "Projects/Team",
	rev: 2,
	author: "laptop",
	key: "",
	access: {
		kind: "participant",
		relayUrl: "u",
		token: "t",
		participantId: "p1",
		personName: "Friend",
	},
};

/** Folder paths to their children; only the count matters here. */
function setup(folders: Record<string, string[]>) {
	const settings = {
		spaces: [TEAM],
		pausedSpaces: [] as string[],
		localRoots: { a: "Team" } as Record<string, string>,
		spacesVault: null,
	};
	const spaces = new SpaceRecords(settings, async () => {});
	const vault = {
		getAbstractFileByPath: (path: string) =>
			folders[path]
				? Object.assign(new TFolder(), { path, children: folders[path] })
				: null,
		createFolder: vi.fn(async (path: string) => {
			folders[path] = [];
		}),
		delete: vi.fn(async (folder: TFolder) => {
			delete folders[folder.path];
		}),
		rename: vi.fn(async (folder: TFolder, to: string) => {
			folders[to] = folders[folder.path] ?? [];
			delete folders[folder.path];
		}),
	};
	const notify = vi.fn();
	const follow = createMoveFollower(
		vault as unknown as MoveVault,
		spaces,
		notify,
	);
	return { settings, spaces, vault, notify, follow };
}

/** The vault "rename" handler, fired as Obsidian would for a folder. */
function onRename(spaces: SpaceRecords) {
	let handler: (file: TFolder, oldPath: string) => Promise<void> =
		async () => {};
	const scheduleScopeRefresh = vi.fn();
	const cancel = vi.fn();
	const plugin = {
		app: {
			vault: {
				on: (_: string, callback: (file: TFolder, oldPath: string) => void) => {
					handler = async (file, oldPath) => {
						callback(file, oldPath);
						await new Promise((resolve) => setTimeout(resolve, 0));
					};
				},
			},
		},
		registerEvent: () => {},
		spaces,
		controller: { currentDevice: () => ({ id: "phone" }), cancel },
		scheduleScopeRefresh,
	};
	registerShareRenames(
		plugin as unknown as Parameters<typeof registerShareRenames>[0],
	);
	return {
		scheduleScopeRefresh,
		cancel,
		fire: (path: string, oldPath: string) =>
			handler(Object.assign(new TFolder(), { path, children: [] }), oldPath),
	};
}

describe("following a shared folder moved on another device", () => {
	it("moves it, parents first, and the share mounts at its new root", async () => {
		const { spaces, vault, follow } = setup({ Team: ["a.md"] });

		await follow();

		expect(vault.createFolder).toHaveBeenCalledWith("Projects");
		expect(vault.rename).toHaveBeenCalledWith(
			expect.objectContaining({ path: "Team" }),
			"Projects/Team",
		);
		expect(spaces.moves()).toEqual([]);
		expect(spaces.partition()).toMatchObject([{}, { root: "Projects/Team" }]);
	});

	it("takes the place of an empty folder", async () => {
		const { spaces, vault, follow } = setup({
			Team: ["a.md"],
			Projects: ["Projects/Team"],
			"Projects/Team": [],
		});

		await follow();

		expect(vault.delete).toHaveBeenCalledOnce();
		expect(vault.rename).toHaveBeenCalledOnce();
		expect(spaces.moves()).toEqual([]);
	});

	it("settles a folder that is not here, without moving anything", async () => {
		const { spaces, vault, follow } = setup({});

		await follow();

		expect(vault.rename).not.toHaveBeenCalled();
		expect(spaces.moves()).toEqual([]);
	});

	it("is not taken for a move made here by its own rename event", async () => {
		const { spaces, vault, follow } = setup({ Team: ["a.md"] });
		const renamed = onRename(spaces);
		vault.rename.mockImplementationOnce(async (folder: TFolder, to: string) => {
			await renamed.fire(to, folder.path);
		});

		await follow();

		expect(renamed.scheduleScopeRefresh).not.toHaveBeenCalled();
		expect(spaces.moves()).toEqual([]);
	});

	it("settles and rescans when the person moves it there by hand", async () => {
		const { spaces } = setup({});
		const renamed = onRename(spaces);

		await renamed.fire("Projects/Team", "Team");

		expect(spaces.moves()).toEqual([]);
		expect(spaces.list()).toEqual([TEAM]);
		expect(renamed.scheduleScopeRefresh).toHaveBeenCalledOnce();
		expect(renamed.cancel).toHaveBeenCalledOnce();
	});

	it("keeps syncing where it is while the path is taken, and says so once", async () => {
		const { spaces, vault, notify, follow } = setup({
			Team: ["a.md"],
			"Projects/Team": ["mine.md"],
		});

		await follow();
		await follow();

		expect(vault.rename).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledOnce();
		expect(spaces.partition()).toMatchObject([{}, { root: "Team" }]);
	});
});
