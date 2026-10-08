import { ALEX, host, LINK } from "@tests/helpers/explorer-host";
import type { Plugin, TAbstractFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SharedLinks } from "@/links";
import type { PluginHost } from "@/plugin/host";
import type { SyncController } from "@/sync/controller";
import { type Space, VAULT_SPACE } from "@/sync/space";
import { renderDecoration } from "@/ui/explorer/file-explorer-decorations";
import { registerFileExplorerIndicators } from "@/ui/explorer/file-explorer-indicators";

vi.mock("@/ui/explorer/file-explorer-decorations", async (original) => ({
	...(await original<object>()),
	renderDecoration: vi.fn(),
	clearDecoration: vi.fn(),
}));

class FakeElement {
	constructor(readonly path = "") {}
}

const SPACES: Space[] = [VAULT_SPACE, { id: "own", root: "Team" }];
const IGNORED = "notes/ignored.md";
const LATER = "notes/later.md";

function listeners() {
	const all = new Set<() => void>();
	return {
		subscribe: (listener: () => void) => {
			all.add(listener);
			return () => all.delete(listener);
		},
		fire: () => {
			for (const listener of all) listener();
		},
	};
}

function tree() {
	const ignored = new Set([IGNORED]);
	const ignoredPaths = vi.fn(() => ignored);
	const ignoreEvents = listeners();
	const peopleEvents = listeners();
	const fileItems = Object.fromEntries(
		[IGNORED, LATER, LINK.path, ALEX.note as string].map((path) => [
			path,
			{ selfEl: new FakeElement(path) },
		]),
	);
	const view = { containerEl: new FakeElement(), fileItems };
	const base = host(SPACES, [ALEX]);
	base.settings.ignoreSymlinks = false;
	const cleanup: (() => void)[] = [];
	const vaultEvents = new Map<string, (file: TAbstractFile) => void>();
	const getFileByPath = vi.fn(base.app.vault.getFileByPath);
	const registerDomEvent = vi.fn();
	const plugin = Object.assign(base, {
		ignoreState: { ignoredPaths, subscribe: ignoreEvents.subscribe },
		realtime: {
			people: { ...base.realtime.people, subscribe: peopleEvents.subscribe },
		},
		app: {
			...base.app,
			vault: {
				...base.app.vault,
				getFileByPath,
				adapter: {},
				on: (name: string, listener: (file: TAbstractFile) => void) => {
					vaultEvents.set(name, listener);
					return {};
				},
			},
			workspace: {
				getLeavesOfType: () => [{ view }],
				on: () => ({}),
				onLayoutReady: () => {},
			},
		},
		register: (callback: () => void) => cleanup.push(callback),
		registerEvent: () => {},
		registerDomEvent,
	}) as unknown as Plugin & PluginHost;
	const statuses = new Map();
	const controller = {
		fileDiffs: { getChangedPathStatuses: () => statuses },
		getSnapshot: () => ({ result: null }),
		subscribe: () => () => {},
	} as unknown as SyncController;
	const handle = registerFileExplorerIndicators(plugin, controller);
	handle.refresh(true);
	return {
		plugin,
		ignored,
		ignoredPaths,
		ignoreEvents,
		peopleEvents,
		getFileByPath,
		registerDomEvent,
		modify: (path: string) =>
			vaultEvents.get("modify")?.({ path } as TAbstractFile),
		dispose: () => {
			for (const callback of cleanup) callback();
		},
	};
}

function paintedPaths(): string[] {
	return vi
		.mocked(renderDecoration)
		.mock.calls.map(([target]) => (target as unknown as FakeElement).path);
}

function frame(): void {
	vi.advanceTimersByTime(20);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("HTMLElement", FakeElement);
	vi.stubGlobal("document", {});
	vi.stubGlobal(
		"MutationObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.mocked(renderDecoration).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("the tree's indicators", () => {
	it("captures badge clicks and key activation before the tree handles them", () => {
		const { registerDomEvent } = tree();

		for (const type of ["click", "keydown"]) {
			expect(registerDomEvent).toHaveBeenCalledWith(
				document,
				type,
				expect.any(Function),
				{ capture: true },
			);
		}
	});

	it("repaints after link changes without rebuilding the base", async () => {
		const { plugin, ignoredPaths } = tree();
		frame();
		vi.mocked(renderDecoration).mockClear();

		await plugin.sharedLinks.add(LINK);
		frame();

		expect(paintedPaths()).toEqual([LINK.path]);
		expect(ignoredPaths).toHaveBeenCalledTimes(1);
	});

	it("unsubscribes from link changes on teardown", () => {
		const unsubscribe = vi.fn();
		const subscribe = vi
			.spyOn(SharedLinks.prototype, "subscribe")
			.mockReturnValue(unsubscribe);
		const { dispose } = tree();
		subscribe.mockRestore();

		dispose();

		expect(unsubscribe).toHaveBeenCalledOnce();
	});

	it("repaints stale notes only for modifications of linked paths", async () => {
		const { plugin, modify, getFileByPath } = tree();
		await plugin.sharedLinks.add(LINK);
		frame();
		vi.mocked(renderDecoration).mockClear();
		getFileByPath.mockClear();

		modify(IGNORED);
		frame();
		expect(getFileByPath).not.toHaveBeenCalled();

		getFileByPath.mockReturnValue({
			path: LINK.path,
			stat: { mtime: LINK.publishedAt + 1 },
		} as ReturnType<typeof plugin.app.vault.getFileByPath>);
		modify(LINK.path);
		frame();

		expect(paintedPaths()).toEqual([LINK.path]);
		expect(vi.mocked(renderDecoration).mock.calls[0]?.[1]).toMatchObject({
			published: { stale: true },
		});
	});

	it("paint ignored files on the first frame", () => {
		tree();

		frame();

		expect(paintedPaths()).toContain(IGNORED);
	});

	it("restyle after the ignore state says it changed in place", () => {
		const { ignored, ignoreEvents } = tree();
		frame();
		vi.mocked(renderDecoration).mockClear();

		ignored.add(LATER);
		ignoreEvents.fire();
		frame();

		expect(paintedPaths()).toEqual([LATER]);
	});

	it("leave the base alone on a people event", () => {
		const { ignoredPaths, peopleEvents } = tree();
		frame();
		vi.mocked(renderDecoration).mockClear();

		peopleEvents.fire();
		peopleEvents.fire();
		frame();

		expect(ignoredPaths).toHaveBeenCalledTimes(1);
		expect(paintedPaths()).toEqual([]);
	});
});
