import { type LinkRecord, updateLink } from "@/links";
import type { PluginHost } from "@/plugin/host";
import { notifyInfo } from "@/ui/common";
import { openPromptModal } from "@/ui/modals";

export async function updateSharedLink(
	plugin: PluginHost,
	record: LinkRecord,
): Promise<void> {
	let passphrase: string | null = null;
	if (record.salt) {
		passphrase = await openPromptModal({
			app: plugin.app,
			title: "Passphrase",
			description:
				"Type the link's passphrase. A different one replaces it, and anyone who has the old one can no longer open the link.",
			initialValue: "",
			confirmLabel: "Update",
			label: "Passphrase",
		});
		if (passphrase === null) return;
	}
	await updateLink(plugin, record, passphrase);
	notifyInfo(
		record.maxViews === null
			? "The link now shows the note as it is."
			: "The link now shows the note as it is. Views already used stay used.",
	);
}
