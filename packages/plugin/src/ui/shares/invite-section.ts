import { Setting } from "obsidian";

import { errorMessage } from "@/shared/errors";
import { runWithNotice } from "@/ui/common/notices";
import type { CreatedInvite } from "./invite-action";

/** Who the invite is for, read-only or not, then the link and password it made. */
export function renderInviteForm(
	parent: HTMLElement,
	invite: (person: string, readOnly: boolean) => Promise<CreatedInvite>,
	onCreated: () => void,
): void {
	let person = "";
	let readOnly = false;
	new Setting(parent)
		.setName("Name")
		.setDesc(
			"Who the invite is for. Inviting the same name again replaces their earlier link.",
		)
		.addText((text) =>
			text.onChange((value) => {
				person = value.trim();
			}),
		);
	new Setting(parent).setName("Read-only").addToggle((toggle) =>
		toggle.onChange((value) => {
			readOnly = value;
		}),
	);
	const status = parent.createEl("p", { cls: "mod-warning" });
	const button = new Setting(parent);
	const created = parent.createDiv();
	button.addButton((create) =>
		create
			.setButtonText("Create invite")
			.setCta()
			.onClick(async () => {
				status.setText(person ? "" : "Enter who it is for.");
				if (!person) return;
				create.setDisabled(true);
				try {
					showInvite(created, await invite(person, readOnly));
					onCreated();
				} catch (err) {
					status.setText(errorMessage(err));
				} finally {
					create.setDisabled(false);
				}
			}),
	);
}

function showInvite(el: HTMLElement, invite: CreatedInvite): void {
	el.empty();
	el.createEl("p", {
		cls: "setting-item-description",
		text: "Send the link and the password separately, for example the link by email and the password by message.",
	});
	copyable(el, "Link", invite.link);
	copyable(el, "Password", invite.password);
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
