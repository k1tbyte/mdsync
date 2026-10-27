import { ButtonComponent, Modal, Setting } from "obsidian";
import { openPluginSettings } from "@/core/hub";
import {
	alertLine,
	modalFooter,
	onEnter,
	openPromiseModal,
	renderModalHead,
} from "@/core/ui";
import { cloudflareErrorMessage } from "../cloudflare/cloudflare-login";
import { r2StorageOf, rekeyR2 } from "../cloudflare/r2-select";
import type { StorageHost } from "../host";
import { describeStorageTarget } from "../registry";
import { activeStorage } from "../settings";

const FIELD = "Token value or secret access key";
const UPDATE = "Update keys";

/** True once new keys open the storage; R2 takes them here, any other storage in the settings. */
export function openStorageRefusedModal(plugin: StorageHost): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(plugin.app);
		const { contentEl } = modal;
		renderModalHead(modal, {
			icon: "key-round",
			title: "The storage refused this device's keys",
			sub: describeStorageTarget(activeStorage(plugin.settings)),
			tone: "danger",
		});
		const footer = modalFooter(modal);
		const settings = (): void => {
			modal.close();
			openPluginSettings(plugin.app);
		};
		if (!r2StorageOf(plugin.settings)) {
			contentEl.createEl("p", {
				text: "They were changed, revoked or mistyped. Update them under Settings → MDSync → Connection.",
			});
			new ButtonComponent(footer)
				.setButtonText("Open settings")
				.setCta()
				.onClick(settings);
			return modal;
		}
		contentEl.createEl("p", {
			text: "Cloudflare R2 no longer accepts them: the API token they come from was rolled or deleted.",
		});
		contentEl.createEl("p", {
			text: "Paste its new value or the new secret access key. Sync goes on in the same bucket and folder.",
		});
		let value = "";
		let update: ButtonComponent | null = null;
		const submit = async (): Promise<void> => {
			if (!value || update?.disabled) return;
			update?.setDisabled(true).setButtonText("Checking…");
			error.setText("");
			try {
				await rekeyR2(plugin, value);
				answer(true);
				modal.close();
			} catch (err) {
				error.setText(cloudflareErrorMessage(err));
			} finally {
				update?.setDisabled(false).setButtonText(UPDATE);
			}
		};
		new Setting(contentEl).setName(FIELD).addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.setAttr("aria-label", FIELD);
			t.onChange((v) => {
				value = v.trim();
			});
			onEnter(t.inputEl, () => void submit());
		});
		const error = alertLine(contentEl);
		new ButtonComponent(footer)
			.setButtonText("Open settings")
			.onClick(settings);
		update = new ButtonComponent(footer)
			.setButtonText(UPDATE)
			.setCta()
			.onClick(() => void submit());
		return modal;
	}, false);
}
