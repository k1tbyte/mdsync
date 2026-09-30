import type { FakeModal } from "@tests/helpers/fake-obsidian-dom";
import {
	ALICE,
	BEA,
	button,
	buttons,
	list,
	makeShare,
	open,
	ownerAccess,
	person,
	settle,
	stubDom,
} from "@tests/helpers/share-modal-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant } from "@/storage";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);
vi.mock("@/ui/common/notices", () => ({
	notifyError: vi.fn(),
	runWithNotice: vi.fn(),
}));

beforeEach(stubDom);

describe("ShareModal stop and leave", () => {
	it("keeps the window open when stopping the share is declined", async () => {
		const { share } = makeShare({ close: vi.fn(async () => false) });
		const modal = await open(share);

		button(modal, "Stop sharing").fire("click");
		await settle();

		expect(share.close).toHaveBeenCalledTimes(1);
		expect(share.onClosed).not.toHaveBeenCalled();
	});

	it("closes the window once the share is closed", async () => {
		const { share } = makeShare({ closeLabel: "Leave" });
		const modal = await open(share);

		button(modal, "Leave").fire("click");
		await settle();

		expect(share.close).toHaveBeenCalledTimes(1);
		expect(share.onClosed).toHaveBeenCalledTimes(1);
	});
});

describe("ShareModal pause", () => {
	it("offers no pause where the share cannot sync here", async () => {
		const modal = await open(makeShare({ paused: null }).share);

		expect(buttons(modal.modalEl, "Pause on this device")).toEqual([]);
		expect(buttons(modal.modalEl, "Resume on this device")).toEqual([]);
	});

	it("says which way it will flip", async () => {
		const running = await open(makeShare({ paused: false }).share);
		const paused = await open(makeShare({ paused: true }).share);

		expect(buttons(running.modalEl, "Pause on this device")).toHaveLength(1);
		expect(buttons(paused.modalEl, "Resume on this device")).toHaveLength(1);
	});

	it("shows the flip at once and saves it", async () => {
		const { share } = makeShare({ paused: false });
		const modal = await open(share);
		const toggle = button(modal, "Pause on this device");

		toggle.fire("click");

		expect(toggle.text).toBe("Resume on this device");
		expect(share.setPaused).toHaveBeenCalledWith(true);
	});

	it("flips back when the save fails", async () => {
		const { share } = makeShare({
			paused: false,
			setPaused: vi.fn(async () => Promise.reject(new Error("disk"))),
		});
		const modal = await open(share);
		const toggle = button(modal, "Pause on this device");

		toggle.fire("click");
		await settle();

		expect(toggle.text).toBe("Pause on this device");
	});
});

describe("ShareModal closing", () => {
	it("stops listening to presence and tells its owner it went away", async () => {
		const harness = makeShare({ access: ownerAccess([ALICE]) });
		const modal = await open(harness.share);

		modal.close();

		expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
		expect(harness.listeners.size).toBe(0);
		expect(harness.share.onClosed).toHaveBeenCalledTimes(1);
		expect(modal.contentEl.children).toEqual([]);
	});

	it("draws nothing for a presence event that comes after it closed", async () => {
		let here = [person("a", "Alice")];
		const harness = makeShare({
			access: ownerAccess([ALICE]),
			here: () => here,
		});
		const modal = await open(harness.share);
		const people = list(modal);
		const shown = people.textContent;

		modal.close();
		here = [person("a", "Alice", "Team/todo.md")];
		for (const listener of harness.listeners) listener();
		await settle();

		expect(shown).toContain("Can edit - Online");
		expect(people.textContent).toBe(shown);
	});

	it("draws nothing for a list that arrives after it closed", async () => {
		let answer: (people: Participant[]) => void = () => {};
		const access = {
			...ownerAccess(),
			people: vi.fn(
				() => new Promise<Participant[]>((resolve) => (answer = resolve)),
			),
		};
		const modal: FakeModal = await open(makeShare({ access }).share);
		const people = list(modal);
		const shown = people.textContent;

		modal.close();
		answer([ALICE, BEA]);
		await settle();

		expect(shown).toBe("Loading…");
		expect(people.textContent).toBe(shown);
	});
});
