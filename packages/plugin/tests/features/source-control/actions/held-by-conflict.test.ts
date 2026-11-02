import { beforeEach, describe, expect, it, vi } from "vitest";
import { SourceControlActions } from "@/features/source-control/actions/actions";
import type { SourceControlHost } from "@/features/source-control/host";

const notices: string[] = [];
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: class {
		constructor(message: string) {
			notices.push(message);
		}
	},
}));

/** `cached` conflicts show until `refresh` swaps in `fresh`. */
function setup(cached: string[], fresh: string[]) {
	let conflicts = cached;
	const controller = {
		getSnapshot: () => ({
			result: { diff: { conflicts: conflicts.map((path) => ({ path })) } },
		}),
		spaceFor: () => ({ id: "vault" }),
		refresh: vi.fn(async () => {
			conflicts = fresh;
		}),
		pushPaths: vi.fn(async () => ({ ok: true })),
		pullPaths: vi.fn(async () => ({ ok: true })),
	};
	const actions = new SourceControlActions({
		plugin: { controller } as unknown as SourceControlHost,
		showHistory: () => {},
		openDiff: async () => {},
	});
	return { actions, controller };
}

beforeEach(() => {
	notices.length = 0;
});

describe("a push or pull a conflict holds", () => {
	it("is refused with the conflict named when a fresh compare still shows it", async () => {
		const { actions, controller } = setup(["a.md"], ["a.md"]);

		expect(await actions.pushPaths(["b.md"])).toBe(false);

		expect(controller.refresh).toHaveBeenCalledOnce();
		expect(controller.pushPaths).not.toHaveBeenCalled();
		expect(notices).toEqual([
			'MDSync: Resolve the conflict in "a.md" first: nothing pushes or pulls until then.',
		]);
	});

	it("goes ahead once the conflict was resolved elsewhere", async () => {
		const { actions, controller } = setup(["a.md"], []);

		expect(await actions.pullPaths(["b.md"])).toBe(true);

		expect(controller.pullPaths).toHaveBeenCalledWith(["b.md"]);
	});

	it("compares only when a cached conflict could hold it", async () => {
		const { actions, controller } = setup([], []);

		expect(await actions.pushPaths(["b.md"])).toBe(true);

		expect(controller.refresh).not.toHaveBeenCalled();
	});
});
