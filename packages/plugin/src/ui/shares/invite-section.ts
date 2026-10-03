import { type ButtonComponent, Setting } from "obsidian";

import { errorMessage } from "@/shared";
import { alertLine, onEnter, runWithNotice, serial } from "@/ui/common";
import type { CreatedInvite } from "./invite-action";

export function renderInviteForm(
	parent: HTMLElement,
	invite: (person: string, readOnly: boolean) => Promise<CreatedInvite>,
	onCreated: () => void,
): void {
	let person = "";
	let readOnly = false;
	let create: ButtonComponent | undefined;
	const submit = serial(async () => {
		status.setText(person ? "" : "Enter who it is for.");
		if (!person) return;
		create?.setDisabled(true);
		try {
			showInvite(created, await invite(person, readOnly));
			onCreated();
		} catch (err) {
			status.setText(errorMessage(err));
		} finally {
			create?.setDisabled(false);
		}
	});
	new Setting(parent).setName("Read-only").addToggle((toggle) =>
		toggle.onChange((value) => {
			readOnly = value;
		}),
	);
	new Setting(parent)
		.setClass("mdsync-invite-name")
		.setName("Name")
		.setDesc(
			"Who the invite is for. Inviting the same name again replaces their link: the earlier one stops working, even for someone who already joined. The relay receives your storage credentials to sign this folder's requests.",
		)
		.addText((text) => {
			text.inputEl.setAttr("aria-label", "Name");
			text.onChange((value) => {
				person = value.trim();
			});
			onEnter(text.inputEl, submit);
		})
		.addButton((button) => {
			create = button.setButtonText("Create invite").setCta().onClick(submit);
		});
	const status = alertLine(parent);
	const created = parent.createDiv();
}

function showInvite(el: HTMLElement, invite: CreatedInvite): void {
	el.empty();
	el.createEl("p", {
		cls: "setting-item-description",
		text: "Send the link and the password separately, for example the link by email and the password by message. You will not see this link again.",
	});
	copyable(el, "Link", invite.link);
	copyable(el, "Password", invite.password);
	el.scrollIntoView({ block: "nearest" });
}

function copyable(el: HTMLElement, name: string, value: string): void {
	new Setting(el)
		.setName(name)
		.addText((text) => {
			text.setValue(value);
			text.inputEl.readOnly = true;
		})
		.addExtraButton((button) =>
			button
				.setIcon("copy")
				.setTooltip(`Copy ${name.toLowerCase()}`)
				.onClick(
					() =>
						void runWithNotice(
							() => navigator.clipboard.writeText(value),
							`${name} copied.`,
							`Could not copy the ${name.toLowerCase()}`,
						),
				),
		);
}
