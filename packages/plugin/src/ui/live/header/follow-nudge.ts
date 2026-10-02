import { ButtonComponent, Notice } from "obsidian";

const NUDGE_MS = 4_000;

/** Asks, without ending it, whether input in a following tab meant to stop. */
export function showFollowNudge(name: string, stop: () => void): Notice {
	const body = createFragment();
	const row = body.createDiv({ cls: "obsync-follow-nudge" });
	row.createSpan({ text: `Following ${name}` });
	new ButtonComponent(row).setButtonText("Stop following").onClick(stop);
	return new Notice(body, NUDGE_MS);
}
