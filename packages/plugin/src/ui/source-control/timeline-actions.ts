import { Menu } from "obsidian";
import type { PluginHost } from "@/plugin/host";
import { notifyError, notifyInfo } from "@/ui/common/notices";
import { openConfirmModal } from "@/ui/modals";
import { confirmRestore } from "./restore-modal";
import { addSnapshotPinItems } from "./snapshot-menu";
import {
	describeRestorePlan,
	samplePaths,
	type TimelineFileRow,
	type TimelineRow,
} from "./timeline-rows";

export class TimelineActions {
	constructor(
		private readonly plugin: PluginHost,
		private readonly refresh: () => void,
		private readonly openFile: (
			row: TimelineRow,
			file: TimelineFileRow,
			mode: "current" | "change",
		) => void,
	) {}

	showSnapshotMenu(event: MouseEvent, row: TimelineRow): void {
		const menu = new Menu();
		addSnapshotPinItems(menu, this.plugin, row, this.refresh, row.restorable);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Restore vault to this snapshot…")
				.setIcon("rotate-ccw")
				.setDisabled(!row.restorable)
				.onClick(() => void this.restoreVault(row)),
		);
		menu.showAtMouseEvent(event);
	}

	showFileMenu(
		event: MouseEvent,
		row: TimelineRow,
		file: TimelineFileRow,
	): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Compare with current")
				.setIcon("git-compare")
				.onClick(() => this.openFile(row, file, "current")),
		);
		menu.addItem((item) =>
			item
				.setTitle("Show changes in this push")
				.setIcon("history")
				.onClick(() => this.openFile(row, file, "change")),
		);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(
					file.action === "delete"
						? "Restore deleted file…"
						: "Restore this version…",
				)
				.setIcon("rotate-ccw")
				.onClick(() => void this.restoreFile(file)),
		);
		menu.showAtMouseEvent(event);
	}

	async restoreFile(file: TimelineFileRow): Promise<void> {
		const confirmed = await confirmRestore({
			plugin: this.plugin,
			path: file.path,
			target: file.path,
			version: file.version,
		});
		if (!confirmed) return;
		try {
			await this.plugin.controller.history.restoreFileVersion(
				file.path,
				file.version.hash,
			);
			notifyInfo("Restored. Review and push the change when ready.");
		} catch (error) {
			notifyError("Restore failed", error);
		}
	}

	private async restoreVault(row: TimelineRow): Promise<void> {
		try {
			const history = this.plugin.controller.history;
			const plan = await history.previewVaultRestore(row.snapshotId);
			if (plan.write.length === 0 && plan.remove.length === 0) {
				notifyInfo("The vault already matches that snapshot.");
				return;
			}
			const confirmed = await openConfirmModal({
				app: this.plugin.app,
				title: `Restore the vault to ${row.title}?`,
				body: [
					...describeRestorePlan(plan),
					...samplePaths(plan.remove.map((path) => `deleted: ${path}`)),
					"This changes files on this device only. Nothing reaches the remote until you push.",
				],
				confirmLabel: "Restore vault",
				confirmClass: "mod-warning",
				cancelLabel: "Leave the vault alone",
			});
			if (!confirmed) return;
			const applied = await history.restoreVault(row.snapshotId);
			notifyInfo(
				`Restored ${applied.write.length} and removed ${applied.remove.length} file(s). Review and push when ready.`,
			);
		} catch (error) {
			notifyError("Restore failed", error);
		}
	}
}
