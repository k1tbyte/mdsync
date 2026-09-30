import type { FakeEl, FakeModal } from "@tests/helpers/fake-obsidian-dom";
import {
	ALICE,
	BEA,
	button,
	buttons,
	makeShare,
	notes,
	open,
	ownerAccess,
	person,
	settle,
	stubDom,
} from "@tests/helpers/share-modal-harness";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const field = (modal: FakeModal, label: string) => {
	const found = modal.contentEl.find(
		(el) => el.tag === "input" && el.attrs.get("aria-label") === label,
	)[0];
	if (!found) throw new Error(`no "${label}" field`);
	return found;
};

function typeName(modal: FakeModal, name: string): FakeEl {
	const input = field(modal, "Name");
	input.value = name;
	input.fire("input");
	return input;
}

const enter = (input: FakeEl, init: Record<string, unknown> = {}) =>
	input.fire("keydown", {
		key: "Enter",
		isComposing: false,
		keyCode: 13,
		preventDefault: () => {},
		...init,
	});

describe("ShareModal revoke", () => {
	it("opens the note a person is in and gets out of the way", async () => {
		const { share } = makeShare({
			access: ownerAccess([ALICE]),
			here: () => [person("a", "Alice", "Team/todo.md")],
		});
		const modal = await open(share);

		button(modal, "").fire("click");

		expect(share.openNote).toHaveBeenCalledWith("Team/todo.md");
		expect(share.onClosed).toHaveBeenCalledTimes(1);
	});

	it("revokes the person in the row and reloads who has access", async () => {
		const access = ownerAccess();
		const modal = await open(makeShare({ access }).share);

		buttons(modal.contentEl, "Revoke")[1]?.fire("click");
		await settle();

		expect(access.revoke).toHaveBeenCalledWith(BEA);
		expect(access.people).toHaveBeenCalledTimes(2);
	});

	it("leaves the list alone when the owner backs out of a revoke", async () => {
		const access = { ...ownerAccess(), revoke: vi.fn(async () => false) };
		const modal = await open(makeShare({ access }).share);

		buttons(modal.contentEl, "Revoke")[0]?.fire("click");
		await settle();

		expect(access.people).toHaveBeenCalledTimes(1);
	});

	it("takes one revoke at a time and shows why one failed", async () => {
		let fail: (error: Error) => void = () => {};
		const access = {
			...ownerAccess(),
			revoke: vi.fn(() => new Promise<boolean>((_, reject) => (fail = reject))),
		};
		const modal = await open(makeShare({ access }).share);
		const [first, second] = buttons(modal.contentEl, "Revoke");

		first?.fire("click");
		second?.fire("click");
		fail(new Error("relay refused"));
		await settle();

		expect(access.revoke).toHaveBeenCalledTimes(1);
		expect(notes(modal)).toContain("relay refused");
	});
});

describe("ShareModal invite", () => {
	it("invites by name, read-only when asked, and reloads the list", async () => {
		const access = ownerAccess([ALICE]);
		const modal = await open(makeShare({ access }).share);
		const [readOnly] = modal.contentEl.find((el) =>
			el.hasClass("checkbox-container"),
		);

		typeName(modal, "Dana");
		readOnly?.fire("click");
		button(modal, "Create invite").fire("click");
		await settle();

		expect(access.invite).toHaveBeenCalledWith("Dana", true);
		expect(access.people).toHaveBeenCalledTimes(2);
		expect(
			modal.contentEl
				.find((el) => el.tag === "input" && el.readOnly)
				.map((el) => el.value),
		).toEqual(["obsidian://link", "pw-123"]);
	});

	it("asks who an invite is for before sending anything", async () => {
		const access = ownerAccess();
		const modal = await open(makeShare({ access }).share);

		button(modal, "Create invite").fire("click");
		await settle();

		expect(access.invite).not.toHaveBeenCalled();
		expect(modal.contentEl.textContent).toContain("Enter who it is for.");
	});

	it("shows why an invite failed, in an alert, and allows another try", async () => {
		const access = {
			...ownerAccess(),
			invite: vi.fn(async () => Promise.reject(new Error("no relay"))),
		};
		const modal = await open(makeShare({ access }).share);

		typeName(modal, "Dana");
		button(modal, "Create invite").fire("click");
		await settle();

		const [alert] = modal.contentEl.find(
			(el) => el.attrs.get("role") === "alert",
		);
		expect(alert?.text).toBe("no relay");
		expect(button(modal, "Create invite").disabled).toBe(false);
	});

	it("labels the name field for a screen reader", async () => {
		const modal = await open(makeShare({ access: ownerAccess() }).share);

		expect(field(modal, "Name").tag).toBe("input");
	});
});

describe("ShareModal invite with Enter", () => {
	it("creates the invite when Enter is pressed in the name field", async () => {
		const access = ownerAccess([ALICE]);
		const modal = await open(makeShare({ access }).share);

		enter(typeName(modal, "Dana"));
		await settle();

		expect(access.invite).toHaveBeenCalledWith("Dana", false);
	});

	it("asks who it is for when Enter is pressed on an empty name", async () => {
		const access = ownerAccess();
		const modal = await open(makeShare({ access }).share);

		enter(field(modal, "Name"));
		await settle();

		expect(access.invite).not.toHaveBeenCalled();
		expect(modal.contentEl.textContent).toContain("Enter who it is for.");
	});

	it("ignores the Enter that confirms an IME composition", async () => {
		const access = ownerAccess();
		const modal = await open(makeShare({ access }).share);
		const input = typeName(modal, "Dana");

		enter(input, { isComposing: true });
		enter(input, { keyCode: 229 });
		await settle();

		expect(access.invite).not.toHaveBeenCalled();
	});

	it("sends one invite for two quick Enters", async () => {
		let finish: () => void = () => {};
		const access = {
			...ownerAccess([ALICE]),
			invite: vi.fn(
				() =>
					new Promise<{ link: string; password: string }>((resolve) => {
						finish = () => resolve({ link: "l", password: "p" });
					}),
			),
		};
		const modal = await open(makeShare({ access }).share);
		const input = typeName(modal, "Dana");

		enter(input);
		enter(input);
		finish();
		await settle();

		expect(access.invite).toHaveBeenCalledTimes(1);
	});

	it("does not start a second invite by Enter while a click's is pending", async () => {
		let finish: () => void = () => {};
		const access = {
			...ownerAccess([ALICE]),
			invite: vi.fn(
				() =>
					new Promise<{ link: string; password: string }>((resolve) => {
						finish = () => resolve({ link: "l", password: "p" });
					}),
			),
		};
		const modal = await open(makeShare({ access }).share);
		const input = typeName(modal, "Dana");

		button(modal, "Create invite").fire("click");
		enter(input);
		finish();
		await settle();

		expect(access.invite).toHaveBeenCalledTimes(1);
	});
});
