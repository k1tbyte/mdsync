import { ALEX, host, LINK, SAM } from "@tests/helpers/explorer-host";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Person } from "@/presence/people";
import type { SyncController } from "@/sync/controller";
import { type Space, VAULT_SPACE } from "@/sync/space";
import { EChangeType } from "@/sync/types";
import type { FileExplorerRows } from "@/ui/explorer/file-explorer-api";
import {
	clearDecoration,
	renderDecoration,
} from "@/ui/explorer/file-explorer-decorations";
import { RowDecorator } from "@/ui/explorer/row-decorator";

vi.mock("@/ui/explorer/file-explorer-decorations", async (original) => ({
	...(await original<object>()),
	renderDecoration: vi.fn(),
	clearDecoration: vi.fn(),
}));

const SPACES: Space[] = [VAULT_SPACE, { id: "own", root: "Team" }];
const CHANGED = "notes/changed.md";
const IGNORED = "notes/ignored.md";

function setup(people: Person[] = [ALEX], unseen: string[] = []) {
	const plugin = host(SPACES, people, unseen);
	const ignored = new Set([IGNORED]);
	const ignoredPaths = vi.fn(() => ignored);
	plugin.ignoreState.ignoredPaths = ignoredPaths;
	let partition = SPACES;
	plugin.spaces.partition = () => partition;
	let statuses: ReadonlyMap<string, EChangeType> = new Map([
		[CHANGED, EChangeType.LocalAdd],
	]);
	const controller = {
		fileDiffs: { getChangedPathStatuses: () => statuses },
		getSnapshot: () => ({ result: null }),
	} as unknown as SyncController;

	const folded = new Set<string>();
	const elements = new Map<string, HTMLElement>();
	const lookups = vi.fn();
	const explorer: FileExplorerRows = {
		containerEl: {} as HTMLElement,
		row: (path) => {
			lookups(path);
			const element =
				elements.get(path) ?? ({ path } as unknown as HTMLElement);
			elements.set(path, element);
			return element;
		},
		paths: () => [...elements.keys()],
		collapsed: (path) => folded.has(path),
	};
	const decorator = new RowDecorator(plugin, controller);
	let links: ReadonlyMap<string, string> = new Map();
	return {
		plugin,
		decorator,
		people,
		folded,
		elements,
		ignoredPaths,
		lookups,
		setStatuses: (next: ReadonlyMap<string, EChangeType>) => {
			statuses = next;
		},
		setLinks: (next: ReadonlyMap<string, string>) => {
			links = next;
		},
		setPartition: (next: Space[]) => {
			partition = next;
		},
		apply: (rowsChanged = false, indicators = true) =>
			decorator.apply(explorer, links, indicators, rowsChanged),
	};
}

type Rig = ReturnType<typeof setup>;

function paintedPaths(): string[] {
	return vi
		.mocked(renderDecoration)
		.mock.calls.map(([target]) => (target as unknown as { path: string }).path);
}

function clearedPaths(): string[] {
	return vi
		.mocked(clearDecoration)
		.mock.calls.map(([target]) => (target as unknown as { path: string }).path);
}

function settle(): void {
	vi.mocked(renderDecoration).mockClear();
	vi.mocked(clearDecoration).mockClear();
}

beforeEach(settle);

describe("the tree's decoration layers", () => {
	it.each([false, true])(
		"keeps published badges with indicators %s",
		async (on) => {
			const { apply, plugin } = setup([]);
			await plugin.sharedLinks.add(LINK);

			apply(true, on);

			expect(paintedPaths()).toContain(LINK.path);
			expect(
				vi
					.mocked(renderDecoration)
					.mock.calls.find(
						([target]) =>
							(target as unknown as { path: string }).path === LINK.path,
					)?.[1],
			).toMatchObject({ published: { count: 1, stale: false } });
		},
	);

	it("keeps the share badges alone when indicators are off", () => {
		const { apply, plugin } = setup([ALEX], ["Team/a.md"]);

		apply(true, false);

		expect(paintedPaths()).toEqual(["Team"]);
		const [, decoration] = vi.mocked(renderDecoration).mock.calls[0] ?? [];
		expect(decoration).toMatchObject({ share: { root: "Team" } });
		expect(plugin.unseen.all().has("Team/a.md")).toBe(true);
	});

	it("decorates changes, ignored paths, people and unseen files when on", () => {
		const { apply } = setup([ALEX], ["Team/a.md"]);

		apply(true);

		expect(paintedPaths().sort()).toEqual(
			[CHANGED, IGNORED, "Team", "Team/a.md", ALEX.note as string].sort(),
		);
	});

	it("touches only the presence rows on a people event", () => {
		const { apply, people, lookups, ignoredPaths } = setup([ALEX]);
		apply(true);
		settle();
		lookups.mockClear();

		people.splice(0, people.length, { ...ALEX, note: "Team/other.md" });
		apply();
		expect(paintedPaths()).toEqual(["Team/other.md"]);
		settle();

		people.splice(0, people.length, SAM);
		apply();
		expect(paintedPaths().sort()).toEqual(["Team", "Team/b.md"]);

		expect(ignoredPaths).toHaveBeenCalledTimes(1);
		expect(new Set(lookups.mock.calls.flat())).toEqual(
			new Set(["Team", ALEX.note, "Team/other.md", "Team/b.md"]),
		);
	});

	it("draws nothing again when nothing changed", () => {
		const { apply } = setup([ALEX], ["Team/a.md"]);
		apply(true);
		settle();

		apply();
		apply(true);

		expect(renderDecoration).not.toHaveBeenCalled();
		expect(clearDecoration).not.toHaveBeenCalled();
	});

	it("hands people to the outermost collapsed folder without a row change", () => {
		const { apply, folded } = setup([ALEX]);
		apply(true);
		settle();

		folded.add("Team/docs");
		apply();

		expect(paintedPaths()).toEqual(["Team/docs"]);
	});
});

describe("the base layer", () => {
	const inputs: [string, (rig: Rig) => void][] = [
		[
			"the diff",
			(rig) => rig.setStatuses(new Map([[CHANGED, EChangeType.LocalDelete]])),
		],
		["the links", (rig) => rig.setLinks(new Map([["Team/link", "Team/link"]]))],
		["the ignore rules", (rig) => rig.decorator.ignoredChanged()],
		["the partition", (rig) => rig.setPartition([...SPACES])],
	];

	it.each(inputs)("is rebuilt when only %s change", (_, change) => {
		const rig = setup();
		rig.apply(true);
		expect(rig.ignoredPaths).toHaveBeenCalledTimes(1);
		rig.apply();
		expect(rig.ignoredPaths).toHaveBeenCalledTimes(1);

		change(rig);
		rig.apply();
		expect(rig.ignoredPaths).toHaveBeenCalledTimes(2);
		rig.apply();
		expect(rig.ignoredPaths).toHaveBeenCalledTimes(2);
	});

	it("repaints its rows when it changed though the rows did not", () => {
		const { apply, setStatuses } = setup();
		apply(true);
		settle();

		setStatuses(new Map([[CHANGED, EChangeType.LocalDelete]]));
		apply();

		expect(paintedPaths()).toEqual([CHANGED]);
		expect(clearedPaths()).toEqual([CHANGED]);
		const [, decoration] = vi.mocked(renderDecoration).mock.calls[0] ?? [];
		expect(decoration).toMatchObject({ change: "mdsync-changed-deleted" });

		settle();
		setStatuses(new Map());
		apply();

		expect(paintedPaths()).toEqual([]);
		expect(clearedPaths()).toEqual([CHANGED]);
	});

	it("looks at every decorated row again when the rows changed", () => {
		const { apply, elements } = setup();
		apply(true);
		settle();

		elements.set(CHANGED, { path: CHANGED } as unknown as HTMLElement);
		apply();
		expect(renderDecoration).not.toHaveBeenCalled();

		apply(true);
		expect(paintedPaths()).toEqual([CHANGED]);
		expect(clearDecoration).toHaveBeenCalledTimes(1);
	});
});

describe("repainting a row", () => {
	it("follows a person going idle or renamed on the same row", () => {
		const { apply, people } = setup([ALEX]);
		apply(true);
		settle();

		people.splice(0, people.length, { ...ALEX, idle: true });
		apply();
		expect(paintedPaths().sort()).toEqual(["Team", ALEX.note]);
		settle();

		people.splice(0, people.length, { ...ALEX, idle: true, name: "Alexander" });
		apply();
		expect(paintedPaths()).toEqual([ALEX.note]);
	});

	it("skips an equal decoration made anew", () => {
		const { apply, people } = setup([ALEX]);
		apply(true);
		settle();

		people.splice(0, people.length, { ...ALEX });
		apply();

		expect(renderDecoration).not.toHaveBeenCalled();
	});
});

describe("clearing", () => {
	it("takes every mark off and repaints all on the next pass", () => {
		const { apply, decorator } = setup([ALEX], ["Team/a.md"]);
		apply(true);
		const painted = paintedPaths().sort();
		settle();

		decorator.clear();
		expect(clearedPaths().sort()).toEqual(painted);
		settle();

		apply();
		expect(paintedPaths().sort()).toEqual(painted);
	});
});
