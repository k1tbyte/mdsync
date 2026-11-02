import type { Modal } from "obsidian";
import { renderModalHead } from "@/core/ui";
import type { SpaceRecord } from "../../record";

export interface RelayState {
	live: boolean;
	text: string;
}

/** Whose it is and where; returns the setter of its relay state, null where no relay carries it. */
export function renderShareHead(
	modal: Modal,
	record: SpaceRecord,
): (relay: RelayState | null) => void {
	const line = renderModalHead(modal, {
		icon: "users",
		title: record.name,
		sub: whose(record),
	});
	line.createSpan({ cls: "mdsync-share-path", text: record.root });
	const relay = line.createSpan({ cls: "mdsync-share-relay" });
	return (state) => {
		relay.empty();
		relay.toggleClass("mdsync-hidden", state === null);
		if (state === null) return;
		relay.createSpan({
			cls: `mdsync-live-dot${state.live ? " is-live" : ""}`,
		});
		relay.createSpan({ text: state.text });
	};
}

function whose({ access }: SpaceRecord): string {
	if (access.kind === "owner") return "Shared folder you own";
	return access.readOnly ? "Shared with you, read-only" : "Shared with you";
}
