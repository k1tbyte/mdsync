import { Menu } from "obsidian";
import { notifyError, notifyInfo, openConfirmModal } from "@/core/ui";
import type { SourceControlHost } from "../host";
import { confirmAndRestoreFile } from "../restore-file";
import type { SessionRow } from "./session-rows";
import { addSnapshotPinItems } from "./snapshot-menu";
import {
	describeRestorePlan,
	samplePaths,
	type TimelineFileRow,
	type TimelineRow,
} from "./timeline-rows";

export class TimelineActions {
	constructor(
		private readonly plugin: SourceControlHost,
		private readonly refresh: () => void,
		private readonly openFile: (
			owner: string,
			file: TimelineFileRow,
			mode: "current" | "change",
		) => void,
	) {}

	/** A session acts through its newest version: pinning it, or the vault as the session left it. */
	showSessionMenu(event: MouseEvent, session: SessionRow): void {
		const newest = session.versions[0];
		if (newest)
			this.showVersionMenu(
				event,
				newest,
				session.versions.length > 1
					? "Restore vault to end of session…"
					: undefined,
			);
	}

	showVersionMenu(
		event: MouseEvent,
		row: TimelineRow,
		restoreTitle = "Restore vault to this version…",
	): void {
		const menu = new Menu();
		addSnapshotPinItems(menu, this.plugin, row, this.refresh, row.restorable);
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(restoreTitle)
				.setIcon("rotate-ccw")
				.setDisabled(!row.restorable)
				.onClick(() => void this.restoreVault(row)),
		);
		menu.showAtMouseEvent(event);
	}

	showFileMenu(event: MouseEvent, owner: string, file: TimelineFileRow): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Compare with current")
				.setIcon("git-compare")
				.onClick(() => this.openFile(owner, file, "current")),
		);
		menu.addItem((item) =>
			item
				.setTitle("Show changes")
				.setIcon("history")
				.onClick(() => this.openFile(owner, file, "change")),
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
		await confirmAndRestoreFile(
			this.plugin,
			{ path: file.path, target: file.path, version: file.version },
			"Restored. Review and push the change when ready.",
		);
	}

	private async restoreVault(row: TimelineRow): Promise<void> {
		try {
			const history = this.plugin.controller.history;
			let plan = await history.previewVaultRestore(row.snapshotId);
			let moved = false;
			for (;;) {
				if (plan.write.length === 0 && plan.remove.length === 0) {
					notifyInfo("The vault already matches that snapshot.");
					return;
				}
				const confirmed = await openConfirmModal({
					app: this.plugin.app,
					title: `Restore the vault to ${row.label || row.tooltip}?`,
					body: [
						...(moved
							? ["The vault changed while you decided. Here is the new plan."]
							: []),
						...describeRestorePlan(plan),
						...samplePaths(plan.remove.map((path) => `deleted: ${path}`)),
						"This changes files on this device only. Nothing reaches the remote until you push.",
					],
					confirmLabel: "Restore vault",
					confirmClass: "mod-warning",
					cancelLabel: "Leave the vault alone",
				});
				if (!confirmed) return;
				const outcome = await history.restoreVault(row.snapshotId, plan);
				if (outcome.applied) break;
				plan = outcome.plan;
				moved = true;
			}
			notifyInfo(
				`Restored ${plan.write.length} and trashed ${plan.remove.length} file(s). Review and push when ready.`,
			);
		} catch (error) {
			notifyError("Restore failed", error);
		}
	}
}
