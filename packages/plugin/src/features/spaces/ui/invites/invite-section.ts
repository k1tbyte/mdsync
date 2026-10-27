import { ButtonComponent, DropdownComponent, TextComponent } from "obsidian";

import { errorMessage } from "@/core/shared";
import { alertLine, copyable, modalHint, onEnter, serial } from "@/core/ui";
import type { CreatedInvite } from "./invite-action";

/** Name, access and the button on one line; the link and its password appear under it, once. */
export function renderInviteForm(
	parent: HTMLElement,
	invite: (person: string, readOnly: boolean) => Promise<CreatedInvite>,
	onCreated: () => void,
): void {
	const row = parent.createDiv({ cls: "mdsync-invite-row" });
	const name = new TextComponent(row).setPlaceholder("Their name");
	name.inputEl.setAttr("aria-label", "Their name");
	const access = new DropdownComponent(row).addOptions({
		edit: "Can edit",
		read: "Read-only",
	});
	access.selectEl.setAttr("aria-label", "Access");
	const create = new ButtonComponent(row)
		.setButtonText("Create invite")
		.setCta();
	modalHint(
		parent,
		"Inviting the same name again replaces their link, even for someone who already joined. The relay receives your storage credentials to sign this folder's requests.",
	);
	const status = alertLine(parent);
	const created = parent.createDiv();
	const submit = serial(async () => {
		const person = name.getValue().trim();
		status.setText(person ? "" : "Enter who it is for.");
		if (!person) return;
		create.setDisabled(true);
		try {
			showInvite(created, await invite(person, access.getValue() === "read"));
			onCreated();
		} catch (err) {
			status.setText(errorMessage(err));
		} finally {
			create.setDisabled(false);
		}
	});
	create.onClick(submit);
	onEnter(name.inputEl, submit);
}

function showInvite(el: HTMLElement, invite: CreatedInvite): void {
	el.empty();
	modalHint(
		el,
		"Send the link and the password separately, for example the link by email and the password by message. You will not see this link again.",
	);
	copyable(el, "Link", invite.link);
	copyable(el, "Password", invite.password);
	el.scrollIntoView({ block: "nearest" });
}
