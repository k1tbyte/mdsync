import { FileView, type Plugin } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { type LinkRecord, SharedLinks } from "@/links";
import type { PluginHost } from "@/plugin/host";
import { openManageLinks } from "@/ui/links/link-menu";
import { registerNoteLinkActions } from "@/ui/links/note-link-action";

vi.mock("@/ui/links/link-menu", () => ({ openManageLinks: vi.fn() }));

const RECORD: LinkRecord = {
	id: "one",
	url: "https://relay.example/one",
	path: "note.md",
	showTitle: true,
	detached: false,
	createdAt: 1,
	publishedAt: 1,
	expires: null,
	maxViews: null,
	salt: null,
	images: false,
};

class Action {
	parentElement: object | null = {};
	classes = new Set<string>();
	attrs = new Map<string, string>();
	constructor(readonly click: () => void) {}
	addClass(name: string) {
		this.classes.add(name);
	}
	toggleClass(name: string, enabled: boolean) {
		if (enabled) this.classes.add(name);
		else this.classes.delete(name);
	}
	setAttr(name: string, value: string) {
		this.attrs.set(name, value);
	}
	remove() {
		this.parentElement = null;
	}
}

function host() {
	const file = { path: "note.md", extension: "md", stat: { mtime: 1 } };
	const actions: Action[] = [];
	const addAction = vi.fn((_icon: string, title: string, click: () => void) => {
		const action = new Action(click);
		action.setAttr("aria-label", title);
		actions.push(action);
		return action;
	});
	const view = Object.assign(Object.create(FileView.prototype), {
		file,
		addAction,
	});
	const leaves = [{ view }];
	const events = new Map<string, (file?: { path: string }) => void>();
	const on = (name: string, callback: (file?: { path: string }) => void) => {
		events.set(name, callback);
		return {};
	};
	const cleanup: (() => void)[] = [];
	const settings = { links: [{ ...RECORD }] };
	const sharedLinks = new SharedLinks(
		() => settings,
		async () => {},
	);
	const plugin = {
		sharedLinks,
		app: {
			workspace: {
				iterateAllLeaves: vi.fn((visit: (leaf: object) => void) =>
					leaves.forEach(visit),
				),
				on,
				onLayoutReady: (ready: () => void) => ready(),
			},
			vault: { on, getFileByPath: () => file },
		},
		register: (dispose: () => void) => cleanup.push(dispose),
		registerEvent: vi.fn(),
	} as unknown as Plugin & PluginHost;
	registerNoteLinkActions(plugin);
	return {
		plugin,
		sharedLinks,
		file,
		view,
		leaves,
		actions,
		addAction,
		events,
		cleanup,
	};
}

describe("a note's share link action", () => {
	it("updates its stale mark and tooltip without adding another action", async () => {
		const { plugin, sharedLinks, file, actions, addAction, events } = host();
		const action = actions[0];
		expect(action?.classes.has("mdsync-published-action")).toBe(true);
		expect(action?.attrs.get("aria-label")).toContain("Click to manage.");
		file.stat.mtime = 2;
		events.get("modify")?.(file);
		expect(action?.classes.has("is-stale")).toBe(true);
		expect(action?.attrs.get("aria-label")).toContain("click to update.");
		await sharedLinks.published(RECORD.id, 2);
		expect(action?.classes.has("is-stale")).toBe(false);
		expect(addAction).toHaveBeenCalledOnce();
		action?.click();
		expect(openManageLinks).toHaveBeenCalledWith(plugin, file.path);
		await sharedLinks.remove(RECORD.id);
		expect(action?.parentElement).toBeNull();
	});

	it("does not refresh for an unshared note's modify", () => {
		const { plugin, events } = host();
		const visit = vi.mocked(plugin.app.workspace.iterateAllLeaves);
		visit.mockClear();
		events.get("modify")?.({ path: "private.md" });
		expect(visit).not.toHaveBeenCalled();
	});

	it("replaces the action for another file and removes it for unshared notes", async () => {
		const { sharedLinks, view, actions, events } = host();
		await sharedLinks.add({ ...RECORD, id: "two", path: "other.md" });
		view.file = { path: "other.md", extension: "md" };
		events.get("file-open")?.();
		expect(actions[0]?.parentElement).toBeNull();
		expect(actions[1]?.parentElement).not.toBeNull();
		view.file = { path: "private.md", extension: "md" };
		events.get("file-open")?.();
		expect(actions[1]?.parentElement).toBeNull();
	});

	it("refreshes renamed notes and removes actions on closed leaves and unload", async () => {
		const { sharedLinks, file, actions, leaves, events, cleanup } = host();
		file.path = "renamed.md";
		await sharedLinks.move("note.md", file.path);
		events.get("rename")?.();
		expect(actions[0]?.parentElement).toBeNull();
		expect(actions[1]?.parentElement).not.toBeNull();
		leaves.length = 0;
		events.get("layout-change")?.();
		expect(actions[1]?.parentElement).toBeNull();
		for (const dispose of cleanup) dispose();
		events.get("file-open")?.();
		expect(actions).toHaveLength(2);
	});

	it("removes every action on unload", () => {
		const { actions, cleanup } = host();
		for (const dispose of cleanup) dispose();
		expect(actions[0]?.parentElement).toBeNull();
	});
});
