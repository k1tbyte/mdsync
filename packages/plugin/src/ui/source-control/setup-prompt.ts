import { ButtonComponent, setIcon } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { ESetupStep } from "@/settings/setup/steps";

/** The Changes tab of a device that syncs nothing yet. */
export function renderSetupPrompt(
	parent: HTMLElement,
	plugin: PluginHost,
): void {
	const el = parent.createDiv({ cls: "mdsync-empty-state" });
	setIcon(el.createSpan({ cls: "mdsync-empty-state-icon" }), "hard-drive");
	el.createDiv({
		cls: "mdsync-empty-state-title",
		text: "Connect storage to sync",
	});
	el.createDiv({
		cls: "mdsync-empty-state-desc",
		text: "Pick S3, WebDAV or Google Drive and set a passphrase. Files are encrypted on this device.",
	});
	new ButtonComponent(el)
		.setCta()
		.setButtonText("Set up sync")
		.onClick(() => plugin.openSetup());
	const join = el.createEl("a", {
		cls: "mdsync-empty-state-link",
		text: "Already syncing on another device?",
		href: "#",
	});
	join.addEventListener("click", (event) => {
		event.preventDefault();
		plugin.openSetup(ESetupStep.Import);
	});
}
