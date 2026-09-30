import { ALEX, host } from "@tests/helpers/explorer-host";
import type { Plugin } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
		[IGNORED, LATER, ALEX.note as string].map((path) => [
			path,
			{ selfEl: new FakeElement(path) },
		]),
	);
	const view = { containerEl: new FakeElement(), fileItems };
	const base = host(SPACES, [ALEX]);
	const plugin = Object.assign(base, {
		ignoreState: { ignoredPaths, subscribe: ignoreEvents.subscribe },
		realtime: {
			people: { ...base.realtime.people, subscribe: peopleEvents.subscribe },
		},
		settings: { ...base.settings, ignoreSymlinks: false },
		app: {
			...base.app,
			vault: { ...base.app.vault, adapter: {}, on: () => ({}) },
			workspace: {
				getLeavesOfType: () => [{ view }],
				on: () => ({}),
				onLayoutReady: () => {},
			},
		},
		register: () => {},
		registerEvent: () => {},
		registerDomEvent: () => {},
	}) as unknown as Plugin & PluginHost;
	const statuses = new Map();
	const controller = {
		fileDiffs: { getChangedPathStatuses: () => statuses },
		subscribe: () => () => {},
	} as unknown as SyncController;
	const handle = registerFileExplorerIndicators(plugin, controller);
	handle.refresh(true);
	return { ignored, ignoredPaths, ignoreEvents, peopleEvents };
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
