import type { SpaceRecords } from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";

/** Whose a share is, where, and whether this device syncs it. */
export function shareSummary(
	spaces: Pick<SpaceRecords, "partition">,
	record: SpaceRecord,
): string {
	const space = spaces.partition().find(({ id }) => id === record.id);
	if (!space) {
		return `Not syncing: another shared folder already holds "${record.root}".`;
	}
	const paused = space.paused ? ", paused on this device" : "";
	return `${whose(record)}, in "${record.root}"${paused}.`;
}

function whose({ access }: SpaceRecord): string {
	if (access.kind === "owner") return "Yours";
	return access.readOnly ? "Shared with you, read-only" : "Shared with you";
}
