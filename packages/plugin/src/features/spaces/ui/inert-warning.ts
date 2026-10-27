import { notifyError } from "@/core/ui";
import type { SpaceRecords } from "../records";

/** Once per record and session: two devices shared one folder offline, and this one lost. */
export function createInertWarning(spaces: SpaceRecords): () => void {
	const warned = new Set<string>();
	return () => {
		for (const { id, name, root } of spaces.inert()) {
			if (warned.has(id)) continue;
			warned.add(id);
			notifyError(
				`"${name}" is not syncing: another shared folder already holds "${root}". Stop sharing it in the Sync settings.`,
			);
		}
	};
}
