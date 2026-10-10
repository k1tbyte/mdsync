import { Setting } from "obsidian";

import { canSync } from "@/settings/model";
import { errorMessage } from "@/shared";
import { alertLine, focusKey } from "@/ui/common";

import type { StepView, Wizard } from "./wizard";

export function createImportStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	let link = "";
	let passphrase = "";
	let error = "";
	let busy = false;

	const submit = async (): Promise<void> => {
		if (busy || !link || !passphrase) return;
		busy = true;
		error = "";
		wizard.redraw();
		try {
			await plugin.transfer.importWith(link, passphrase);
			busy = false;
			if (wizard.isShowing(view)) wizard.next();
			return;
		} catch (err) {
			error = errorMessage(err);
		}
		busy = false;
		wizard.redraw();
	};

	const view: StepView = {
		render(el) {
			el.createEl("h3", { text: "Setup link from your other device" });
			el.createEl("p", {
				text: "On the device that already syncs, open Settings → MDSync → Connection → Export setup. Scan its QR code with this device's camera, or copy its link here.",
			});
			if (canSync(plugin.settings)) {
				el.createEl("p", {
					text: "Importing replaces this device's storage and relay settings.",
				});
			}
			const linkRow = new Setting(el).setName("Setup link").addTextArea((t) => {
				t.inputEl.rows = 3;
				t.inputEl.setAttr("aria-label", "Setup link");
				focusKey(t.inputEl, "link");
				t.setPlaceholder("obsidian://mdsync?d=…")
					.setValue(link)
					.onChange((v) => {
						link = v.trim();
					});
			});
			linkRow.settingEl.addClass("mdsync-setup-stacked");
			new Setting(el)
				.setName("Passphrase")
				.setDesc("The vault's passphrase, the same as on the other device.")
				.addText((t) => {
					t.inputEl.type = "password";
					t.inputEl.setAttr("aria-label", "Passphrase");
					focusKey(t.inputEl, "passphrase");
					t.setValue(passphrase).onChange((v) => {
						passphrase = v;
					});
				});
			if (error) alertLine(el).setText(error);
			new Setting(el).addButton((b) =>
				b
					.setButtonText(busy ? "Importing…" : "Import")
					.setCta()
					.setDisabled(busy)
					.onClick(() => void submit()),
			);
		},
	};
	return view;
}
