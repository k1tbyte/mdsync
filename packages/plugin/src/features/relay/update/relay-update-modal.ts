import { ButtonComponent, Modal } from "obsidian";
import type { PluginHost } from "@/app/host";
import {
	alertLine,
	modalFooter,
	modalHint,
	notifyError,
	notifyInfo,
	openPromiseModal,
	renderModalHead,
} from "@/core/ui";
import {
	type CloudflareLogin,
	cloudflareErrorMessage,
} from "@/features/storage";
import { activateRelay, deployOwnRelay } from "../deploy/deploy-flow";
import type { RelayTarget } from "../deploy/relay-account";

/** True once the relay is updated; any other close is "not now". */
export function openRelayUpdateModal(
	plugin: PluginHost,
	login: CloudflareLogin,
	target: RelayTarget,
): Promise<boolean> {
	return openPromiseModal<boolean>((answer) => {
		const modal = new Modal(plugin.app);
		const { contentEl } = modal;
		renderModalHead(modal, { icon: "server", title: "Update the relay" });
		contentEl.createEl("p", {
			text: "This version of MDSync carries a newer relay with fixes. It takes about a minute; the relay's secret, shared folders and links stay.",
		});
		modalHint(
			contentEl,
			"Later: Settings → MDSync → Connection → Update relay.",
		);
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
		const footer = modalFooter(modal);
		new ButtonComponent(footer)
			.setButtonText("Not now")
			.onClick(() => modal.close());
		update = new ButtonComponent(footer)
			.setButtonText("Update")
			.setCta()
			.onClick(() => void submit());
		return modal;
	}, false);
}
