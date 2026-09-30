import type { FakeEl, FakeModal } from "@tests/helpers/fake-obsidian-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Invite } from "@/spaces/invite";
import { AcceptInviteModal } from "@/ui/modals/invite-modal";

vi.mock("obsidian", async (importOriginal) =>
	(await import("@tests/helpers/fake-obsidian-dom")).fakeObsidian(
		await importOriginal(),
	),
);

const INVITE: Invite = {
	id: "i1",
	name: "Team notes",
	key: "k",
	relayUrl: "https://relay.example",
	token: "t",
	participantId: "p",
	personName: "Me",
	readOnly: false,
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
	options: {
		unseal?: (password: string) => Promise<Invite>;
		mountedAt?: string | null;
		accept?: (invite: Invite, root: string) => Promise<string | null>;
	} = {},
) {
	const unseal = vi.fn(options.unseal ?? (async () => INVITE));
	const mountedAt = vi.fn(() => options.mountedAt ?? null);
	const accept = vi.fn(options.accept ?? (async () => null));
	const modal = new AcceptInviteModal(
		{} as never,
		unseal,
		mountedAt,
		accept,
	) as AcceptInviteModal & FakeModal;
	modal.open();
	return { modal, unseal, mountedAt, accept };
}

const input = (modal: FakeModal, label: string): FakeEl => {
	const found = modal.contentEl.find(
		(el) => el.tag === "input" && el.attrs.get("aria-label") === label,
	)[0];
	if (!found) throw new Error(`no "${label}" field`);
	return found;
};
const button = (modal: FakeModal, text: string): FakeEl => {
	const found = modal.contentEl.find(
		(el) => el.tag === "button" && el.text === text,
	)[0];
	if (!found) throw new Error(`no "${text}" button`);
	return found;
};
const buttonTexts = (modal: FakeModal) =>
	modal.contentEl.find((el) => el.tag === "button").map((el) => el.text);
const alerts = (modal: FakeModal) =>
	modal.contentEl.find((el) => el.attrs.get("role") === "alert");
const type = (field: FakeEl, value: string) => {
	field.value = value;
	field.fire("input");
};
const enter = (field: FakeEl, init: Record<string, unknown> = {}) =>
	field.fire("keydown", {
		key: "Enter",
		isComposing: false,
		keyCode: 13,
		preventDefault: () => {},
		...init,
	});

async function unlock(modal: FakeModal, password = "pw") {
	type(input(modal, "Password"), password);
	button(modal, "Open invite").fire("click");
	await settle();
}

beforeEach(() => vi.clearAllMocks());

describe("AcceptInviteModal password step", () => {
	it("asks for the password, labelled, and waits for it", () => {
		const { modal, unseal } = setup();

		expect(input(modal, "Password").type).toBe("password");
		expect(buttonTexts(modal)).toEqual(["Open invite"]);
		expect(unseal).not.toHaveBeenCalled();
	});

	it("says a wrong password in an alert of the step that is showing", async () => {
		const { modal } = setup({
			unseal: async () => Promise.reject(new Error("x")),
		});

		await unlock(modal, "nope");

		expect(alerts(modal).map((el) => el.text)).toEqual([
			"Wrong password, or the link is damaged.",
		]);
		expect(buttonTexts(modal)).toEqual(["Open invite"]);
	});

	it("tries the password with its spaces trimmed", async () => {
		const { modal, unseal } = setup();

		await unlock(modal, "  pw  ");

		expect(unseal).toHaveBeenCalledWith("pw");
	});

	it("opens the invite on Enter in the password field", async () => {
		const { modal, unseal } = setup();
		const field = input(modal, "Password");
		type(field, "pw");

		enter(field);
		await settle();

		expect(unseal).toHaveBeenCalledWith("pw");
		expect(buttonTexts(modal)).toEqual(["Add shared folder"]);
	});

	it("ignores an Enter that confirms an IME composition", async () => {
		const { modal, unseal } = setup();
		const field = input(modal, "Password");
		type(field, "pw");

		enter(field, { isComposing: true });
		await settle();

		expect(unseal).not.toHaveBeenCalled();
	});
});

describe("AcceptInviteModal folder step", () => {
	it("offers a new folder and the button to add it", async () => {
		const { modal } = setup();

		await unlock(modal);

		expect(modal.contentEl.textContent).toContain(
			'"Team notes" will sync into this folder. Pick a new or empty one.',
		);
		expect(input(modal, "Folder").value).toBe("Shared/Team notes");
		expect(buttonTexts(modal)).toEqual(["Add shared folder"]);
		expect(alerts(modal).map((el) => el.text)).toEqual([""]);
	});

	it("adds the folder that was typed, trimmed, and closes", async () => {
		const { modal, accept } = setup();
		await unlock(modal);
		type(input(modal, "Folder"), "  Work/Team  ");

		button(modal, "Add shared folder").fire("click");
		await settle();

		expect(accept).toHaveBeenCalledWith(INVITE, "Work/Team");
		expect(modal.contentEl.children).toEqual([]);
	});

	it("adds the folder on Enter in the folder field", async () => {
		const { modal, accept } = setup();
		await unlock(modal);

		enter(input(modal, "Folder"));
		await settle();

		expect(accept).toHaveBeenCalledWith(INVITE, "Shared/Team notes");
	});

	it("adds the folder once for two quick Enters and a click", async () => {
		let finish: () => void = () => {};
		const { modal, accept } = setup({
			accept: () =>
				new Promise<string | null>((resolve) => {
					finish = () => resolve(null);
				}),
		});
		await unlock(modal);
		const field = input(modal, "Folder");

		enter(field);
		enter(field);
		button(modal, "Add shared folder").fire("click");
		finish();
		await settle();

		expect(accept).toHaveBeenCalledTimes(1);
	});

	it("shows what is wrong with the folder under the folder step and lets it retry", async () => {
		const { modal, accept } = setup({
			accept: async () => "This folder is not empty.",
		});
		await unlock(modal);

		button(modal, "Add shared folder").fire("click");
		await settle();

		expect(alerts(modal).map((el) => el.text)).toEqual([
			"This folder is not empty.",
		]);
		expect(button(modal, "Add shared folder").disabled).toBe(false);
		button(modal, "Add shared folder").fire("click");
		await settle();
		expect(accept).toHaveBeenCalledTimes(2);
	});

	it("shows why adding failed when the mount itself throws, and lets it retry", async () => {
		const { modal } = setup({
			accept: async () => Promise.reject(new Error("disk full")),
		});
		await unlock(modal);

		enter(input(modal, "Folder"));
		await settle();

		expect(alerts(modal).map((el) => el.text)).toEqual(["disk full"]);
		expect(button(modal, "Add shared folder").disabled).toBe(false);
	});

	it("ignores an Enter that confirms an IME composition", async () => {
		const { modal, accept } = setup();
		await unlock(modal);

		enter(input(modal, "Folder"), { keyCode: 229 });
		await settle();

		expect(accept).not.toHaveBeenCalled();
	});
});

describe("AcceptInviteModal for a share already here", () => {
	it("says where it is and replaces its link, with no folder to pick", async () => {
		const { modal, accept } = setup({ mountedAt: "Shared/Old" });

		await unlock(modal);

		expect(modal.contentEl.textContent).toContain(
			'"Team notes" is already in "Shared/Old": this link replaces the one it syncs with.',
		);
		expect(modal.contentEl.find((el) => el.tag === "input")).toEqual([]);
		expect(buttonTexts(modal)).toEqual(["Use this link"]);

		button(modal, "Use this link").fire("click");
		await settle();
		expect(accept).toHaveBeenCalledWith(INVITE, "Shared/Old");
	});
});
