import { MarkdownView, type WorkspaceLeaf } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginHost } from "@/plugin/host";
import { CursorFollow } from "@/ui/live/header/cursor-follow";
import { showFollowNudge } from "@/ui/live/header/follow-nudge";
import { trackCursor } from "@/ui/live/header/follow-scroll";

vi.mock("@/ui/live/header/follow-scroll", () => ({ trackCursor: vi.fn() }));
vi.mock("@/ui/live/header/follow-nudge", () => ({ showFollowNudge: vi.fn() }));

const ALEX = { key: "alex", name: "Alex" };

function setup() {
	const view = Object.assign(Object.create(MarkdownView.prototype) as object, {
		file: { path: "a.md" } as { path: string } | null,
		contentEl: new EventTarget(),
	});
	const leaf = {
		view,
		openFile: vi.fn(async (file: { path: string }) => {
			view.file = file;
		}),
	};
	const listeners = new Set<() => void>();
	const subscribe = (listener: () => void) => {
		listeners.add(listener);
		return () => listeners.delete(listener);
	};
	const where = { note: "a.md" as string | null, online: true };
	const rooms = new Map([
		["a.md", { id: "room-a" }],
		["b.md", { id: "room-b" }],
	]);
	const plugin = {
		app: {
			workspace: { on: vi.fn(), offref: vi.fn(), setActiveLeaf: vi.fn() },
			vault: {
				getFileByPath: (path: string) => (rooms.has(path) ? { path } : null),
			},
		},
		realtime: {
			people: {
				subscribe,
				online: () =>
					where.online ? [{ ...ALEX, note: where.note, idle: false }] : [],
			},
			live: { subscribe, roomOf: (path: string) => rooms.get(path) ?? null },
		},
	} as unknown as PluginHost;
	const follows = new CursorFollow(plugin);
	const asLeaf = leaf as unknown as WorkspaceLeaf;
	follows.start(asLeaf, "team", ALEX);
	return {
		view,
		leaf,
		follows,
		where,
		following: () => follows.of(asLeaf),
		/** Presence or a room changed; resolves once a note it opened is shown. */
		changed: async () => {
			for (const listener of [...listeners]) listener();
			await new Promise((resolve) => setTimeout(resolve, 0));
		},
	};
}

describe("following a person", () => {
	const stopTracking = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(trackCursor).mockReturnValue(stopTracking);
	});

	it("follows their cursor in the note it starts in", () => {
		const { view, following } = setup();

		expect(trackCursor).toHaveBeenCalledExactlyOnceWith(
			view,
			{ id: "room-a" },
			"alex",
		);
		expect(following()).toBe("alex");
	});

	it("opens the note they move to in this tab, then follows their cursor there", async () => {
		const { view, leaf, where, changed, following } = setup();

		where.note = "b.md";
		await changed();

		expect(leaf.openFile).toHaveBeenCalledExactlyOnceWith({ path: "b.md" });
		expect(stopTracking).toHaveBeenCalledOnce();
		expect(trackCursor).toHaveBeenLastCalledWith(
			view,
			{ id: "room-b" },
			"alex",
		);
		expect(following()).toBe("alex");
	});

	it("waits where it is for a note not on this device yet", async () => {
		const { leaf, where, changed, following } = setup();

		where.note = "elsewhere.md";
		await changed();

		expect(leaf.openFile).not.toHaveBeenCalled();
		expect(following()).toBe("alex");
	});

	it("asks on this tab's input instead of ending, once while the question shows", () => {
		const notice = { hide: vi.fn(), messageEl: { isConnected: true } };
		vi.mocked(showFollowNudge).mockReturnValue(notice as never);
		const { view, following } = setup();

		view.contentEl.dispatchEvent(new Event("keydown"));
		view.contentEl.dispatchEvent(new Event("wheel"));
		expect(showFollowNudge).toHaveBeenCalledOnce();
		expect(following()).toBe("alex");

		const stop = vi.mocked(showFollowNudge).mock.calls[0]?.[1];
		stop?.();
		expect(following()).toBeNull();
		expect(stopTracking).toHaveBeenCalledOnce();
		expect(notice.hide).toHaveBeenCalled();
	});

	it("ends once this tab shows another note opened by hand", async () => {
		const { view, changed, following } = setup();

		view.file = { path: "mine.md" };
		await changed();

		expect(following()).toBeNull();
		expect(stopTracking).toHaveBeenCalledOnce();
	});

	it("ends when they leave", async () => {
		const { where, changed, following } = setup();

		where.online = false;
		await changed();

		expect(following()).toBeNull();
	});
});
