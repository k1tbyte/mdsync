import { setIcon } from "obsidian";

import type { SpaceRecord } from "@/spaces/record";

export interface RelayState {
	live: boolean;
	text: string;
}

/** Title, whose it is and where; returns the setter of its relay state, null where no relay carries it. */
export function renderShareHead(
	titleEl: HTMLElement,
	record: SpaceRecord,
): (relay: RelayState | null) => void {
	titleEl.empty();
	titleEl.addClass("mdsync-share-head");
	setIcon(titleEl.createSpan({ cls: "mdsync-share-tile" }), "users");
	const text = titleEl.createDiv({ cls: "mdsync-share-head-text" });
	text.createDiv({ cls: "mdsync-share-name", text: record.name });
	const sub = text.createDiv({ cls: "mdsync-share-sub" });
	sub.createSpan({ text: whose(record) });
	sub.createSpan({ cls: "mdsync-share-path", text: record.root });
	const relay = sub.createSpan({ cls: "mdsync-share-relay" });
	return (state) => {
		relay.empty();
		relay.toggleClass("mdsync-hidden", state === null);
		if (state === null) return;
		relay.createSpan({ cls: `mdsync-live-dot${state.live ? " is-live" : ""}` });
		relay.createSpan({ text: state.text });
	};
}

function whose({ access }: SpaceRecord): string {
	if (access.kind === "owner") return "Shared folder you own";
	return access.readOnly ? "Shared with you, read-only" : "Shared with you";
}
