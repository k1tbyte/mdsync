import type { PluginHost } from "@/plugin/host";
import { EConflictStrategy, type SyncOperationResult } from "@/sync/controller";
import { EDiffDirection, type FileDiffModel } from "@/sync/projection";
import { notifyError, runWithNotice } from "@/ui/common/notices";
import { confirmRestore } from "@/ui/source-control/restore-modal";
import { EChoiceKind, type HunkChoices } from "./choices";
import type { HistoryChange } from "./history-state";

export interface DiffOperationState {
	path: string | null;
	historyHash: string | null;
	historyChange: HistoryChange | null;
	model: FileDiffModel | null;
}

export interface DiffOperationCallbacks {
	state(): DiffOperationState;
	refresh(): Promise<void>;
	advance(resolvedPath: string): Promise<void>;
}

export class DiffOperations {
	private hunkOpInFlight = false;

	constructor(
		private readonly plugin: PluginHost,
		private readonly callbacks: DiffOperationCallbacks,
	) {}

	async restoreVersion(): Promise<void> {
		const { path, historyHash, historyChange, model } = this.callbacks.state();
		if (!path || !historyHash) return;
		const version = {
			hash: historyHash,
			label:
				(historyChange?.after ?? historyChange?.before)?.label ??
				model?.leftLabel ??
				"Version",
			size: historyChange
				? (historyChange.after?.size ?? historyChange.before?.size)
				: model?.leftSize,
		};
		const confirmed = await confirmRestore({
			plugin: this.plugin,
			path,
			target: path,
			version,
		});
		if (!confirmed) return;
		await this.runOnFile(
			() =>
				this.plugin.controller.history.restoreFileVersion(path, historyHash),
			"Restored version. Review and push when ready.",
			"Restore failed",
		);
	}

	async applyChoices(choices: HunkChoices): Promise<void> {
		const { path, historyHash, historyChange, model } = this.callbacks.state();
		if (!path || !model || this.hunkOpInFlight || choices.size === 0) return;
		// Historical change mode has no working copy to apply to.
		if (historyChange) return;
		this.hunkOpInFlight = true;
		const applied = choices.size;
		const expected = { left: model.leftHash, right: model.rightHash };
		const controller = this.plugin.controller;
		try {
			switch (model.direction) {
				case EDiffDirection.Local:
					await this.runOnFile(
						() =>
							controller.applyLocalHunks({
								path,
								push: choices.selection(EChoiceKind.Push),
								revert: choices.selection(EChoiceKind.Revert),
								expected,
							}),
						`Applied ${applied} change(s).`,
						"Apply failed",
					);
					break;
				case EDiffDirection.Remote:
				case EDiffDirection.Conflict:
					await this.runOnFile(
						() =>
							controller.pullHunks(
								path,
								choices.selection(EChoiceKind.Pull),
								expected,
							),
						`Pulled ${applied} change(s).`,
						"Pull failed",
					);
					break;
				case EDiffDirection.History:
					if (!historyHash) return;
					await this.runOnFile(
						() =>
							controller.history.restoreHistoryHunks(
								path,
								historyHash,
								choices.selection(EChoiceKind.Restore),
								model.rightHash,
							),
						`Restored ${applied} change(s). Review and push when ready.`,
						"Restore failed",
					);
					break;
			}
		} finally {
			this.hunkOpInFlight = false;
		}
	}

	async keepLocal(): Promise<void> {
		await this.resolve(
			(path) =>
				this.plugin.controller.resolveConflicts(
					[path],
					EConflictStrategy.KeepLocal,
				),
			"Kept the local version.",
			"Resolve keep local failed",
		);
	}

	async acceptRemote(): Promise<void> {
		await this.resolve(
			(path) =>
				this.plugin.controller.resolveConflicts(
					[path],
					EConflictStrategy.AcceptRemote,
				),
			"Accepted the remote version.",
			"Resolve accept remote failed",
		);
	}

	async keepBoth(): Promise<void> {
		await this.resolve(
			(path) => this.plugin.controller.resolveConflictKeepBoth(path),
			"Kept the local version; the remote one is saved beside it.",
			"Keep both failed",
		);
	}

	private async resolve(
		action: (path: string) => Promise<SyncOperationResult>,
		okMessage: string,
		failureLabel: string,
	): Promise<void> {
		const { path } = this.callbacks.state();
		if (!path) return;
		await this.runOnFile(
			() => action(path),
			okMessage,
			failureLabel,
			() => this.callbacks.advance(path),
		);
	}

	private async runOnFile(
		action: () => Promise<void> | Promise<SyncOperationResult>,
		okMessage: string,
		failureLabel: string,
		then: () => Promise<void> = () => this.callbacks.refresh(),
	): Promise<void> {
		try {
			if (!(await runWithNotice(action, okMessage, failureLabel))) return;
			await then();
		} catch (error) {
			notifyError(failureLabel, error);
		}
	}
}
