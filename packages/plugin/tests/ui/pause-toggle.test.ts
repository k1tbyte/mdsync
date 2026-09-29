import { describe, expect, it, vi } from "vitest";

import { notifyError } from "@/ui/common/notices";
import { pauseToggle } from "@/ui/shares/pause-toggle";

vi.mock("@/ui/common/notices", () => ({ notifyError: vi.fn() }));

describe("pauseToggle", () => {
	it("shows the flip before the save answers", async () => {
		const shown: boolean[] = [];
		let answer: () => void = () => {};
		const save = vi.fn(
			() => new Promise<void>((resolve) => (answer = resolve)),
		);
		const toggle = pauseToggle(false, save, (now) => shown.push(now));

		const done = toggle();

		expect(shown).toEqual([true]);
		expect(save).toHaveBeenCalledWith(true);
		answer();
		await done;
		expect(shown).toEqual([true]);
	});

	it("flips back and tells why when the save fails", async () => {
		const shown: boolean[] = [];
		const failure = new Error("disk full");
		const toggle = pauseToggle(
			false,
			() => Promise.reject(failure),
			(now) => shown.push(now),
		);

		await toggle();

		expect(shown).toEqual([true, false]);
		expect(notifyError).toHaveBeenCalledWith("Could not change pause", failure);
	});

	it("follows each click without waiting on the one before", async () => {
		const saved: boolean[] = [];
		const toggle = pauseToggle(
			false,
			async (now) => void saved.push(now),
			() => {},
		);

		await Promise.all([toggle(), toggle(), toggle()]);

		expect(saved).toEqual([true, false, true]);
	});
});
