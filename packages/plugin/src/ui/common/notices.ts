import { ButtonComponent, Notice } from "obsidian";

import { errorMessage } from "@/shared";
import type { SyncOperationResult } from "@/sync/controller";

const NOTICE_DURATION_MS = 8000;

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
	new ButtonComponent(notice.messageEl.createDiv())
		.setButtonText(label)
		.setCta()
		.onClick(() => {
			notice.hide();
			action();
		});
}

/** Shows a caught error as a notice and logs the original to the console. */
export function reportError(err: unknown): void {
	notifyError(errorMessage(err));
	console.error("[mdsync]", err);
}

export function attempt(task: Promise<unknown>, failureLabel: string): void {
	task.catch((err) => notifyError(failureLabel, err));
}

export async function runWithNotice(
	action: () => Promise<void> | Promise<boolean | SyncOperationResult>,
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
