import { notifyError, notifyInfo } from "@/core/ui";
import { confirmRestore } from "@/features/diff";
import type { SourceControlHost } from "./host";

type RestoreConfirm = Omit<Parameters<typeof confirmRestore>[0], "plugin">;

/** Asks, then writes one stored version of a file into the vault; nothing is pushed. */
export async function confirmAndRestoreFile(
	plugin: SourceControlHost,
	confirm: RestoreConfirm,
	success: string,
	afterRestore?: () => void,
): Promise<void> {
	if (!(await confirmRestore({ ...confirm, plugin }))) return;
	try {
		await plugin.controller.history.restoreFileVersion(
			confirm.target,
			confirm.version.hash,
			confirm.path,
		);
		notifyInfo(success);
		afterRestore?.();
	} catch (error) {
		notifyError("Restore failed", error);
	}
}
