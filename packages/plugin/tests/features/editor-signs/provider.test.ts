// @vitest-environment jsdom
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import { SignsProvider } from "@/features/editor-signs/provider";
import { compareTextField } from "@/features/editor-signs/state";
import type { SyncController } from "@/features/sync/controller";

function setup() {
	let text: string | null = "base\n";
	const load = vi.fn(async () => (text ? { text, hash: "h" } : null));
	const controller = { fileDiffs: { loadBaselineForPath: load } };
	const provider = new SignsProvider(
		controller as unknown as SyncController,
		{} as never,
	);
	const view = new EditorView({
		state: EditorState.create({ extensions: [compareTextField] }),
	});
	const dispatch = vi.spyOn(view, "dispatch");
	return {
		provider,
		view,
		dispatch,
		setBaseline: (next: string | null) => {
			text = next;
		},
	};
}

describe("signs provider", () => {
	it("delivers the first baseline, then skips refreshes that leave it unchanged", async () => {
		const { provider, view, dispatch, setBaseline } = setup();
		provider.registerView(view, "a.md");
		await vi.waitFor(() =>
			expect(view.state.field(compareTextField)?.toString()).toBe("base\n"),
		);
		expect(dispatch).toHaveBeenCalledTimes(1);

		provider.invalidateAll();
		await vi.waitFor(() => expect(provider.hasCached("a.md")).toBe(true));
		expect(dispatch).toHaveBeenCalledTimes(1);

		setBaseline("changed\n");
		provider.invalidateAll();
		await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
		expect(view.state.field(compareTextField)?.toString()).toBe("changed\n");
	});

	it("skips a missing baseline the view already lacks", async () => {
		const { provider, view, dispatch, setBaseline } = setup();
		setBaseline(null);
		provider.registerView(view, "a.md");
		provider.invalidateAll();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(dispatch).not.toHaveBeenCalled();
	});
});
