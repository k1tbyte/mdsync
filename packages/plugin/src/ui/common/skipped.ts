import { formatBytes } from "@/shared";
import type { SyncController } from "@/sync/controller";
import type { SkippedFile } from "@/sync/types";

/** One instance: callers cache by identity. */
const NONE: readonly SkippedFile[] = [];

export function skippedFiles(
	controller: Pick<SyncController, "getSnapshot">,
): readonly SkippedFile[] {
	return controller.getSnapshot().result?.snapshot.skipped ?? NONE;
}

export function skippedText(file: SkippedFile, maxFileBytes: number): string {
	if (file.reason === "too-large") {
		return `Not synced: ${formatBytes(file.size)}, over the ${formatBytes(maxFileBytes)} limit. Raise Max file size in MDSync settings to sync it.`;
	}
	if (file.reason === "case-clash") {
		return `Not synced: its name differs from "${file.other}" only in case, which this system cannot keep apart.`;
	}
	if (file.reason === "reserved-name") {
		return 'Not synced: its name holds a character this system does not allow, such as : ? * " < > | or a control character. Rename it on the device that has it.';
	}
	return `Not synced: it could not be read${file.detail ? ` (${file.detail})` : ""}.`;
}
