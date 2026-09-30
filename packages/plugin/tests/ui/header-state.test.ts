import { FileView, type WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import type { Person } from "@/presence/people";
import type { Space } from "@/sync/space";
import { headerOf, showsHeader } from "@/ui/live/header-state";
import type { LiveStatus } from "@/ui/live/live-status";

const status: { current: LiveStatus | null } = { current: null };
vi.mock("@/ui/live/live-status", async (original) => ({
	...(await original<object>()),
	liveStatusOf: () => status.current,
}));

const ALEX: Person = {
	key: "p1",
	name: "Alex",
	note: "Team/a.md",
	idle: false,
};

function noteView(file: { path: string } | null, navigation = true) {
	return Object.assign(Object.create(FileView.prototype), { file, navigation });
}

const leafOf = (view: unknown) => ({ view }) as unknown as WorkspaceLeaf;

function host(spaces: Space[], here: Person[] = []) {
	return {
		spaces: { partition: () => spaces },
		realtime: { people: { inNote: () => here } },
	} as unknown as PluginHost;
}

describe("a note's header", () => {
	it("reads the live status, who is here, the lock and the space of the file", () => {
		status.current = { state: "live", label: "Live" };
		const team: Space = { id: "ro", root: "Team", readOnly: true };
		const plugin = host([team], [ALEX]);

		const header = headerOf(plugin, leafOf(noteView({ path: "Team/a.md" })));

		expect(header?.state).toEqual({
			status: status.current,
			here: [ALEX],
			locked: true,
		});
		expect(header?.space).toBe(team);
	});

	it("is not read for a pane that is no note tab, such as a sidebar showing the same file", () => {
		const plugin = host([]);

		expect(
			headerOf(plugin, leafOf(noteView({ path: "a.md" }, false))),
		).toBeNull();
		expect(headerOf(plugin, leafOf(noteView(null)))).toBeNull();
		expect(headerOf(plugin, leafOf({}))).toBeNull();
	});

	it("shows only when there is something to say", () => {
		const cold: LiveStatus = { state: "cold", label: "x" };

		expect(showsHeader({ status: null, here: [], locked: false })).toBe(false);
		expect(showsHeader({ status: null, here: [ALEX], locked: false })).toBe(
			true,
		);
		expect(showsHeader({ status: null, here: [], locked: true })).toBe(true);
		expect(showsHeader({ status: cold, here: [], locked: false })).toBe(true);
	});
});
