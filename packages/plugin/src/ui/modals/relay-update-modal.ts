import { type ButtonComponent, Modal, Setting } from "obsidian";

import type { RelayTarget } from "@/cloudflare";
import type { PluginHost } from "@/plugin/host";
import {
	type CloudflareLogin,
	cloudflareErrorMessage,
} from "@/settings/cloudflare-login";
import { activateRelay, deployOwnRelay } from "@/settings/setup/relay";
import { alertLine, notifyError, notifyInfo } from "@/ui/common";

import { openPromiseModal } from "./promise-modal";

/** True once the relay is updated; any other close is "not now". */
export function openRelayUpdateModal(
	plugin: PluginHost,
	login: CloudflareLogin,
	target: RelayTarget,
): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(plugin.app);
		const { contentEl } = modal;
		modal.titleEl.setText("Update the relay");
		contentEl.createEl("p", {
			text: "This version of MDSync carries a newer relay with fixes. It takes about a minute; the relay's secret, shared folders and links stay.",
		});
		contentEl.createEl("p", {
			text: "Later: Settings → MDSync → Connection → Update relay.",
		});
		const error = alertLine(contentEl);
		let update: ButtonComponent | null = null;
		const submit = async (): Promise<void> => {
			update?.setDisabled(true).setButtonText("Updating…");
			error.setText("");
			try {
				await deployOwnRelay(plugin, login, target, () => {});
				if (!(await activateRelay(plugin))) {
					throw new Error(
						"The relay is updated but does not answer yet. Try again in a minute.",
					);
				}
				answer(true);
				modal.close();
				notifyInfo("Relay updated.");
			} catch (err) {
				// The deploy outlives a closed modal: its failure must still be heard.
				if (!modal.containerEl.isConnected) {
					notifyError("Could not update the relay", err);
				}
				error.setText(cloudflareErrorMessage(err));
				update?.setDisabled(false).setButtonText("Try again");
			}
		};
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Not now").onClick(() => modal.close()))
			.addButton((b) => {
				update = b
					.setButtonText("Update")
					.setCta()
					.onClick(() => void submit());
			});
		return modal;
	}, false);
}
