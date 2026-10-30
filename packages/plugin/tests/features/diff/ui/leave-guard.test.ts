import { beforeEach, describe, expect, it, vi } from "vitest";
import { openConfirmModal } from "@/core/ui/modals/confirm-modal";
import { confirmLeave } from "@/features/diff/ui/leave-guard";

vi.mock("@/core/ui/modals/confirm-modal", () => ({
	openConfirmModal: vi.fn(async () => false),
}));

const app = {} as never;
const asked = () => vi.mocked(openConfirmModal).mock.calls[0]?.[0];

describe("confirmLeave", () => {
	beforeEach(() => vi.mocked(openConfirmModal).mockClear());

	it("leaves at once with nothing unsaved", async () => {
		expect(await confirmLeave(app, { mergeEdits: false, picked: 0 })).toBe(
			true,
		);
		expect(openConfirmModal).not.toHaveBeenCalled();
	});

	it("asks before dropping changes picked and not applied", async () => {
		expect(await confirmLeave(app, { mergeEdits: false, picked: 2 })).toBe(
			false,
		);
		expect(asked()).toMatchObject({
			title: "Discard your choices?",
			body: ["2 picked changes are not applied yet. Leaving drops them."],
		});
	});

	it("asks about the merge first", async () => {
		await confirmLeave(app, { mergeEdits: true, picked: 1 });
		expect(asked()).toMatchObject({ title: "Discard this merge?" });
	});
});
