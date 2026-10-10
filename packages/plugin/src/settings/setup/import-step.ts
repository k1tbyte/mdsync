import { Setting } from "obsidian";

import { canSync } from "@/settings/model";
import { alertLine, focusKey } from "@/ui/common";

import { runAction } from "./run-action";
import type { StepView, Wizard } from "./wizard";

export function createImportStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	let link = "";
	let passphrase = "";
	const state = { busy: false, error: "" };

	const submit = async (): Promise<void> => {
		if (!link || !passphrase) return;
		const imported = await runAction(wizard, state, () =>
			plugin.transfer.importWith(link, passphrase),
		);
		if (imported && wizard.isShowing(view)) wizard.next();
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
			if (state.error) alertLine(el).setText(state.error);
			new Setting(el).addButton((b) =>
				b
					.setButtonText(state.busy ? "Importing…" : "Import")
					.setCta()
					.setDisabled(state.busy)
					.onClick(() => void submit()),
			);
		},
	};
	return view;
}
