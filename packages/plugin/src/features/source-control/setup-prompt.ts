import type { PluginHost } from "@/app/host";
import { ESetupStep } from "@/features/setup";
import { renderEmptyState } from "./tab-states";

/** The Changes tab of a device that syncs nothing yet. */
export function renderSetupPrompt(
	parent: HTMLElement,
	plugin: PluginHost,
): void {
	const el = renderEmptyState(parent, {
		icon: "hard-drive",
		title: "Connect storage to sync",
		text: "Pick S3, WebDAV or Google Drive and set a passphrase. Files are encrypted on this device.",
		action: { text: "Set up sync", cta: true, run: () => plugin.openSetup() },
	});
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
