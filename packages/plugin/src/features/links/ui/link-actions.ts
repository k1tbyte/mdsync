import type { PluginHost } from "@/app/host";
import { notifyError, notifyInfo, openPromptModal } from "@/core/ui";
import { linkError } from "../errors";
import { type RenderedNote, updateLink } from "../publish";
import type { LinkRecord } from "../record";

/** Updates each link in turn, asking a protected one for its passphrase; one notice says how it went. */
export async function updateSharedLinks(
	plugin: PluginHost,
	records: readonly LinkRecord[],
): Promise<void> {
	const rendered: RenderedNote = new Map();
	const updated: LinkRecord[] = [];
	for (const record of records) {
		try {
			const passphrase = record.salt ? await askPassphrase(plugin) : null;
			if (record.salt && passphrase === null) continue;
			await updateLink(plugin, record, passphrase, rendered);
			updated.push(record);
		} catch (err) {
			notifyError("Could not change the link", linkError(err));
		}
	}
	if (updated.length === 0) return;
	const shows =
		updated.length === 1
			? "The link now shows"
			: `${updated.length} links now show`;
	const spent = updated.some(({ maxViews }) => maxViews !== null)
		? " Views already used stay used."
		: "";
	notifyInfo(`${shows} the note as it is.${spent}`);
}

function askPassphrase(plugin: PluginHost): Promise<string | null> {
	return openPromptModal({
		app: plugin.app,
		title: "Passphrase",
		icon: "lock",
		description:
			"Type the link's passphrase to publish the note again under it.",
		initialValue: "",
		confirmLabel: "Update",
		label: "Passphrase",
	});
}
