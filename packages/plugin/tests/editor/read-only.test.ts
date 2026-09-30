import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerReadOnlyLock } from "@/editor/read-only";
import type { ExcalidrawApi, ExcalidrawView } from "@/live/drawing/excalidraw";

type AppState = Record<string, unknown>;

/** An Excalidraw view whose API tells its listeners every scene update, as a render does. */
function drawing(path: string, loaded = true) {
	let appState: AppState = { viewModeEnabled: false };
	const listeners = new Set<(elements: [], state: AppState) => void>();
	const api = {
		getAppState: () => appState,
		updateScene({ appState: next }: { appState?: AppState }) {
			appState = { ...appState, ...next };
			for (const listener of listeners) listener([], appState);
		},
		onChange(listener: (elements: [], state: AppState) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	} as unknown as ExcalidrawApi;
	const view = {
		file: { path },
		excalidrawAPI: loaded ? api : undefined,
	} as unknown as ExcalidrawView;
	return {
		view,
		load: () => {
			view.excalidrawAPI = api;
		},
		viewMode: () => appState.viewModeEnabled,
		listening: () => listeners.size,
		/** The user's own toggle. */
		setViewMode: (on: boolean) =>
			api.updateScene({ appState: { viewModeEnabled: on }, captureUpdate: "" }),
	};
}

function host(...views: ExcalidrawView[]) {
	let partition: { root: string; readOnly: boolean }[] = [];
	let renamed: (file: { path: string }, oldPath: string) => void = () => {};
	const updateOptions = vi.fn();
	const changed = new Set<() => void>();
	const cleanups: (() => void)[] = [];
	const plugin = {
		app: {
			vault: {
				on: (_: string, handler: typeof renamed) => {
					renamed = handler;
					return {};
				},
			},
			workspace: {
				updateOptions,
				getLeavesOfType: () => views.map((view) => ({ view })),
				on: () => ({}),
			},
		},
		registerEditorExtension() {},
		registerEvent() {},
		register: (cleanup: () => void) => cleanups.push(cleanup),
		spaces: { partition: () => partition },
		controller: {
			subscribe(listener: () => void) {
				changed.add(listener);
				return () => changed.delete(listener);
			},
		},
	};
	registerReadOnlyLock(
		plugin as unknown as Parameters<typeof registerReadOnlyLock>[0],
	);
	return {
		updateOptions,
		rename: (path: string, oldPath: string) => renamed({ path }, oldPath),
		share(root: string, readOnly: boolean) {
			partition = [{ root, readOnly }];
			for (const listener of changed) listener();
		},
		unload: () => {
			for (const cleanup of cleanups) cleanup();
		},
	};
}

beforeEach(() => {
	(window as { ExcalidrawLib?: unknown }).ExcalidrawLib = {
		CaptureUpdateAction: { NEVER: "NEVER" },
	};
});

afterEach(() => {
	delete (window as { ExcalidrawLib?: unknown }).ExcalidrawLib;
	vi.useRealTimers();
});

describe("the read-only lock on drawings", () => {
	it("keeps a drawing of a read-only share in view mode, and leaves others be", () => {
		const locked = drawing("s/a.excalidraw.md");
		const free = drawing("b.excalidraw.md");
		const plugin = host(locked.view, free.view);

		plugin.share("s", true);
		locked.setViewMode(false);

		expect(locked.viewMode()).toBe(true);
		expect(free.viewMode()).toBe(false);
	});

	it("listens only to drawings it holds", () => {
		const locked = drawing("s/a.excalidraw.md");
		const free = drawing("b.excalidraw.md");
		const plugin = host(locked.view, free.view);
		expect(locked.listening()).toBe(0);

		plugin.share("s", true);

		expect(locked.listening()).toBe(1);
		expect(free.listening()).toBe(0);
	});

	it("lets out only the drawings it locked", () => {
		const locked = drawing("s/a.excalidraw.md");
		const chosen = drawing("s/b.excalidraw.md");
		chosen.setViewMode(true);
		const plugin = host(locked.view, chosen.view);

		plugin.share("s", true);
		plugin.share("s", false);

		expect(locked.viewMode()).toBe(false);
		expect(chosen.viewMode()).toBe(true);
	});

	it("locks a drawing once it loaded, and unlocks it with the plugin", () => {
		vi.useFakeTimers();
		const loading = drawing("s/a.excalidraw.md", false);
		const plugin = host(loading.view);
		plugin.share("s", true);

		loading.load();
		vi.runOnlyPendingTimers();
		expect(loading.viewMode()).toBe(true);

		plugin.unload();
		expect(loading.viewMode()).toBe(false);
	});
});

describe("the read-only lock on renames", () => {
	it("is rebuilt only for a rename into or out of a read-only share", () => {
		const plugin = host();
		plugin.share("s", true);
		plugin.updateOptions.mockClear();

		plugin.rename("b.md", "a.md");
		expect(plugin.updateOptions).not.toHaveBeenCalled();

		plugin.rename("s/a.md", "a.md");
		plugin.rename("b.md", "s/b.md");
		expect(plugin.updateOptions).toHaveBeenCalledTimes(2);
	});
});
