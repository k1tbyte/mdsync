import { FakeMenu, fragment, titleOf } from "@tests/helpers/fake-menu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RelayStatus } from "@/hub/status";
import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import { openWhereMenu } from "@/ui/live/where-menu";

vi.mock("obsidian", async (original) => ({
	...(await original<object>()),
	Menu: (await import("@tests/helpers/fake-menu")).FakeMenu,
}));

const ALEX: Person = {
	key: "p1",
	name: "Alex",
	note: "Team/a.md",
	idle: false,
};
const SAM: Person = { key: "p2", name: "Sam", note: "Team/b.md", idle: true };

function setup(options: {
	statuses: Record<string, RelayStatus>;
	people?: Person[];
	unseen?: string[];
	unreadable?: boolean;
}) {
	const { statuses, people = [], unseen = [], unreadable = false } = options;
	const open = vi.fn();
	const plugin = {
		app: {
			vault: {
				getFileByPath: (path: string) => (path === "gone.md" ? null : { path }),
			},
			workspace: {
				getLeaf: () => ({ openFile: open }),
				getMostRecentLeaf: () => ({ view: { containerEl: view("recent") } }),
				containerEl: view("workspace"),
			},
		},
		settings: { spaces: [{ id: "s1", name: "Team" }] },
		unseen: { all: () => new Set(unseen) },
		controller: {
			lastEdit: () => ({ key: "d2", name: "Laptop", at: Date.now() }),
			currentDevice: () => ({ id: "d1" }),
		},
		spaces: {
			partition: () =>
				Object.keys(statuses).map((id) => ({
					id,
					root: id === "vault" ? "" : "Team",
				})),
		},
		realtime: {
			statusOf: (id: string) => statuses[id] ?? "off",
			people: {
				online: (id: string) => (id === "s1" ? people : []),
				unreadable: () => unreadable,
			},
		},
	} as unknown as PluginHost;
	return { plugin, open };
}

const view = (doc: string) => ({
	getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 300 }),
	doc,
});

const shown = (): FakeMenu => FakeMenu.shown.at(-1) as FakeMenu;

beforeEach(() => {
	FakeMenu.shown = [];
	vi.stubGlobal("createFragment", fragment);
});

afterEach(() => vi.unstubAllGlobals());

describe("the live status menu", () => {
	it("lists every space's relay state, then who is in shared notes", () => {
		const { plugin, open } = setup({
			statuses: { vault: "connected", s1: "offline" },
			people: [ALEX, SAM],
		});

		openWhereMenu(plugin);

		const menu = shown();
		expect(menu.items.map(titleOf)).toEqual([
			["Vault", "Relay connected"],
			["Team", "Relay unreachable: changes sync on the schedule"],
			["A", "Alex", "Team/a.md"],
		]);
		expect(menu.items.slice(0, 2).map(({ label }) => label)).toEqual([
			true,
			true,
		]);
		expect(menu.items[0]?.icon).toBe("radio");
		expect(menu.items[1]?.icon).toBe("wifi-off");
		menu.items[2]?.click?.();
		expect(open).toHaveBeenCalledWith({ path: "Team/a.md" });
	});

	it("gives a state its own icon, and says when a space cannot be read", () => {
		const { plugin } = setup({
			statuses: { vault: "connecting", s1: "connected" },
			unreadable: true,
		});

		openWhereMenu(plugin);

		expect(shown().items.map(({ icon }) => icon)).toEqual([
			"loader",
			"wifi-off",
			undefined,
		]);
		expect(titleOf(shown().items[1] as never)[1]).toBe(
			"Can't read others: different passphrase or key",
		);
	});

	it("says so when nobody is in a shared note or no relay carries a space", () => {
		const { plugin } = setup({ statuses: { vault: "off" } });

		openWhereMenu(plugin);

		expect(shown().items.map(titleOf)).toEqual([
			["Real-time sync is off"],
			["Nobody is in a shared note"],
		]);
	});

	it("counts the notes others changed since they were opened, and says who changed the latest", () => {
		const { plugin } = setup({
			statuses: { vault: "connected" },
			unseen: ["a.md", "b.md", "gone.md"],
		});

		openWhereMenu(plugin);

		const [count, latest] = shown().items.slice(-2);
		expect(shown().separators).toBe(2);
		expect([count?.label, count && titleOf(count)]).toEqual([
			true,
			["2 changed by others"],
		]);
		expect([latest?.label, latest?.icon]).toEqual([true, "pencil"]);
		expect(titleOf(latest as never)[0]).toMatch(/^Changed on Laptop/);
	});

	it("leaves the unseen row out when nothing is unseen", () => {
		const { plugin } = setup({
			statuses: { vault: "connected" },
			unseen: ["gone.md"],
		});

		openWhereMenu(plugin);

		expect(shown().separators).toBe(1);
	});

	it("opens in the window of the tab in use, from the palette", () => {
		const { plugin } = setup({ statuses: { vault: "off" } });

		openWhereMenu(plugin);

		expect(shown().at).toEqual({ position: { x: 100, y: 100 }, doc: "recent" });
	});
});
