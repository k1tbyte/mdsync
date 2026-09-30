import type { Menu } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { notifyError, notifyInfo } from "@/ui/common";
import { openPromptModal } from "@/ui/modals";

interface SnapshotPin {
	snapshotId: string;
	pinned: boolean;
	label: string;
}

export function addSnapshotPinItems(
	menu: Menu,
	plugin: PluginHost,
	snapshot: SnapshotPin,
	onChanged: () => void,
	canPin = true,
): void {
	const update = async (pinned: boolean, label?: string): Promise<void> => {
		try {
			await plugin.controller.history.setSnapshotPinned(
				snapshot.snapshotId,
				pinned,
				label,
			);
			onChanged();
			notifyInfo(pinned ? "Snapshot pinned." : "Snapshot unpinned.");
		} catch (error) {
			notifyError("Could not update pin", error);
		}
	};
	if (!snapshot.pinned) {
		menu.addItem((item) =>
			item
				.setTitle("Pin this snapshot")
				.setIcon("pin")
				.setDisabled(!canPin)
				.onClick(() => void update(true)),
		);
		return;
	}
	menu.addItem((item) =>
		item
			.setTitle("Rename pin…")
			.setIcon("pencil")
			.onClick(async () => {
				const name = await openPromptModal({
					app: plugin.app,
					title: "Name this pin",
					description: "Shown instead of the timestamp in history.",
					label: "Pin name",
					initialValue: snapshot.label,
					confirmLabel: "Save",
					allowEmpty: true,
				});
				if (name !== null) await update(true, name);
			}),
	);
	menu.addItem((item) =>
		item
			.setTitle("Unpin")
			.setIcon("pin-off")
			.onClick(() => void update(false)),
	);
}
