import { ButtonComponent, Notice } from "obsidian";

import { errorMessage } from "@/core/shared";

const NOTICE_DURATION_MS = 8000;
const TIP_MS = 4000;

export function notifyError(messagePrompt: string, err?: unknown): void {
	const details = err === undefined ? "" : ` - ${errorMessage(err)}`;
	if (err !== undefined) console.error(`[mdsync] ${messagePrompt}`, err);
	new Notice(`MDSync error: ${messagePrompt}${details}`, NOTICE_DURATION_MS);
}

export function notifyInfo(message: string): void {
	new Notice(`MDSync: ${message}`);
}

/** A notice with one button, for what a background task cannot open a modal for. */
export function notifyAction(
	message: string,
	label: string,
	action: () => void,
): void {
	const notice = new Notice(`MDSync: ${message}`, NOTICE_DURATION_MS);
	new ButtonComponent(
		notice.messageEl.createDiv({ cls: "mdsync-notice-action" }),
	)
		.setButtonText(label)
		.setCta()
		.onClick(() => {
			notice.hide();
			action();
		});
}

/** A phone has no hover: a tap shows the element's tooltip as a notice, the newest replacing the last. */
export function tapTooltip(): (el: Element) => void {
	let tip: Notice | null = null;
	return (el) => {
		tip?.hide();
		tip = new Notice(el.getAttribute("aria-label") ?? "", TIP_MS);
	};
}

export function reportError(err: unknown): void {
	notifyError(errorMessage(err));
	console.error("[mdsync]", err);
}

export function attempt(task: Promise<unknown>, failureLabel: string): void {
	task.catch((err) => notifyError(failureLabel, err));
}

export async function runWithNotice(
	action: () =>
		| Promise<void>
		| Promise<boolean | { ok: boolean; error?: string }>,
	successMessage: string,
	failureLabel = "Operation failed",
): Promise<boolean> {
	try {
		const result = await action();
		if (result === false) return false;
		if (result && typeof result === "object" && !result.ok) {
			if (result.error) notifyError(failureLabel, new Error(result.error));
			return false;
		}
		notifyInfo(successMessage);
		return true;
	} catch (err) {
		notifyError(failureLabel, err);
		return false;
	}
}
