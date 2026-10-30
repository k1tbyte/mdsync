import type { Menu } from "obsidian";
import { notifyError, notifyInfo, openPromptModal } from "@/core/ui";
import type { SourceControlHost } from "../host";

interface SnapshotPin {
	snapshotId: string;
	pinned: boolean;
	label: string;
	/** A file of the snapshot's space, from its History; the vault's without one. */
	path?: string;
}

export function addSnapshotPinItems(
	menu: Menu,
	plugin: SourceControlHost,
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
				snapshot.path,
			);
			onChanged();
			notifyInfo(pinned ? "Version pinned." : "Version unpinned.");
		} catch (error) {
			notifyError("Could not update pin", error);
		}
	};
	if (!snapshot.pinned) {
		menu.addItem((item) =>
			item
				.setTitle("Pin this version")
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
					icon: "pin",
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
