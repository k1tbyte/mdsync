import { afterEach, describe, expect, it, vi } from "vitest";

import { registerEditorSigns } from "@/editor/signs";
import { SignsProvider } from "@/editor/signs/provider";
import type { SyncStatusSnapshot } from "@/sync/controller";

afterEach(() => {
	vi.restoreAllMocks();
});

function setup() {
	const invalidate = vi
		.spyOn(SignsProvider.prototype, "invalidateAll")
		.mockImplementation(() => undefined);
	let listener: (snapshot: SyncStatusSnapshot) => void = () => undefined;
	const controller = {
		subscribe: (next: typeof listener) => {
			listener = next;
			return () => undefined;
		},
	};
	const plugin = {
		controller,
		settings: { showEditorChangeSigns: true },
		registerEditorExtension: vi.fn(),
		app: {
			vault: { on: vi.fn(() => ({})), offref: vi.fn() },
			workspace: {
				on: vi.fn(() => ({})),
				offref: vi.fn(),
				updateOptions: vi.fn(),
			},
		},
	} as unknown as Parameters<typeof registerEditorSigns>[0];
	const handle = registerEditorSigns(plugin);
	return {
		invalidate,
		handle,
		emit: (busy: boolean, resultRevision: number) =>
			listener({ busy, resultRevision } as unknown as SyncStatusSnapshot),
	};
}

describe("signs baselines follow the controller", () => {
	it("invalidates on first sight, not on a saved-file patch", () => {
		const { invalidate, emit, handle } = setup();
		emit(false, 1);
		expect(invalidate).toHaveBeenCalledTimes(1);

		// A patch: a new result identity under the same revision.
		emit(false, 1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("does not invalidate on progress frames during an operation", () => {
		const { invalidate, emit, handle } = setup();
		emit(false, 1);
		emit(true, 1);
		emit(true, 1);
		expect(invalidate).toHaveBeenCalledTimes(1);
		handle.dispose();
	});

	it("invalidates on an installed result while another operation waits", () => {
		const { invalidate, emit, handle } = setup();
		emit(false, 1);
		emit(true, 1);
		emit(true, 2);
		expect(invalidate).toHaveBeenCalledTimes(2);
		handle.dispose();
	});

	it("invalidates once when the operation settles", () => {
		const { invalidate, emit, handle } = setup();
		emit(false, 1);
		emit(true, 1);
		emit(false, 1);
		expect(invalidate).toHaveBeenCalledTimes(2);
		emit(false, 1);
		expect(invalidate).toHaveBeenCalledTimes(2);
		handle.dispose();
	});

	it("invalidates when an idle invalidation clears the result", () => {
		const { invalidate, emit, handle } = setup();
		emit(false, 1);
		emit(false, 2);
		emit(false, 2);
		expect(invalidate).toHaveBeenCalledTimes(2);
		handle.dispose();
	});
});
