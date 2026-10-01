import type { PauseKind, SpaceRecords } from "@/spaces";
import type { SpaceRecord } from "@/spaces/record";

const PAUSED: Record<PauseKind, string> = {
	here: ", paused on this device",
	everywhere: ", paused on all your devices",
	off: ", shared folders are off on this device",
};

/** Whose a share is, where, and whether this device syncs it. */
export function shareSummary(
	spaces: Pick<SpaceRecords, "partition" | "pauseOf">,
	record: SpaceRecord,
): string {
	if (!spaces.partition().some(({ id }) => id === record.id)) {
		return `Not syncing: another shared folder already holds "${record.root}".`;
	}
	const paused = spaces.pauseOf(record.id);
	return `${whose(record)}, in "${record.root}"${paused ? PAUSED[paused] : ""}.`;
}

function whose({ access }: SpaceRecord): string {
	if (access.kind === "owner") return "Yours";
	return access.readOnly ? "Shared with you, read-only" : "Shared with you";
}
