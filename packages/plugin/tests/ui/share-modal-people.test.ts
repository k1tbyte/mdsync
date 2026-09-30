import {
	ALICE,
	buttons,
	makeShare,
	notes,
	open,
	ownerAccess,
	person,
	rows,
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

describe("ShareModal people", () => {
	it("lists everyone with access, those here first, with their role and place", async () => {
		const modal = await open(
			makeShare({
				access: ownerAccess(),
				here: () => [person("c", "Cy", "Team/plan.md")],
			}).share,
		);

		expect(rows(modal)).toEqual([
			{
				name: "Cy",
				detail: "Can edit - In plan.md",
				actions: ["Open Team/plan.md", "Revoke"],
			},
			{ name: "Alice", detail: "Can edit", actions: ["Revoke"] },
			{ name: "Bea", detail: "Read-only", actions: ["Revoke"] },
		]);
	});

	it("shows the summary, and a warning only when there is one", async () => {
		const plain = await open(makeShare().share);
		const warned = await open(
			makeShare({ warning: "Invite them again." }).share,
		);
		const warnings = (modal: typeof plain) =>
			modal.contentEl.find((el) => el.hasClass("obsync-share-warning"));

		expect(plain.contentEl.textContent).toContain('Yours, in "Team".');
		expect(warnings(plain)).toEqual([]);
		expect(warnings(warned).map((el) => el.text)).toEqual([
			"Invite them again.",
		]);
	});

	it("shows a participant who is here, with nothing to revoke or invite", async () => {
		const modal = await open(
			makeShare({ here: () => [person("o", "Owner")], closeLabel: "Leave" })
				.share,
		);

		expect(rows(modal)).toEqual([
			{ name: "Owner", detail: "Online", actions: [] },
		]);
		expect(buttons(modal.modalEl, "Create invite")).toEqual([]);
		expect(buttons(modal.modalEl, "Leave")).toHaveLength(1);
	});

	it("says it is loading, then that nobody has access yet", async () => {
		let answer: (people: Participant[]) => void = () => {};
		const access = {
			...ownerAccess(),
			people: vi.fn(
				() => new Promise<Participant[]>((resolve) => (answer = resolve)),
			),
		};
		const modal = await open(makeShare({ access }).share);

		expect(notes(modal)).toEqual(["Loading…"]);
		answer([]);
		await settle();
		expect(notes(modal)).toEqual(["Nobody else can open this folder yet."]);
	});

	it("says nobody is here to a participant", async () => {
		expect(notes(await open(makeShare().share))).toEqual([
			"Nobody else is here now.",
		]);
	});

	it("puts the relay line instead of an empty state, above the people", async () => {
		const line = "Paused on this device: nothing syncs.";
		const alone = await open(makeShare({ note: () => line }).share);
		const listed = await open(
			makeShare({ access: ownerAccess(), note: () => line }).share,
		);

		expect(notes(alone)).toEqual([line]);
		expect(notes(listed)).toEqual([line]);
		expect(rows(listed).map(({ name }) => name)).toEqual([
			"Alice",
			"Bea",
			"Cy",
		]);
	});

	it("says why the list could not load", async () => {
		const access = {
			...ownerAccess(),
			people: vi.fn(async () => Promise.reject(new Error("relay down"))),
		};

		expect(notes(await open(makeShare({ access }).share))).toEqual([
			"relay down",
		]);
	});

	it("follows presence as it changes", async () => {
		let here = [person("a", "Alice")];
		const { share, listeners } = makeShare({
			access: ownerAccess([ALICE]),
			here: () => here,
		});
		const modal = await open(share);
		expect(rows(modal)[0]?.detail).toBe("Can edit - Online");

		here = [person("a", "Alice", "Team/todo.md")];
		for (const listener of listeners) listener();

		expect(rows(modal)[0]?.detail).toBe("Can edit - In todo.md");
	});
});
