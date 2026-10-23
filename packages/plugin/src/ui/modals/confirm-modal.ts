import { type App, ButtonComponent, Modal } from "obsidian";

import {
	modalCard,
	modalFooter,
	modalHint,
	renderModalHead,
	renderPath,
} from "@/ui/common";
import { openPromiseModal } from "./promise-modal";

type ButtonClass = "mod-cta" | "mod-warning";

/** Past this many, the rest are counted. */
const FILES_SHOWN = 8;

interface QuestionOptions {
	app: App;
	title: string;
	body: ReadonlyArray<string>;
	/** Listed under the text in a card. */
	files?: ReadonlyArray<string>;
	/** A warning sign when a choice is destructive, else an info mark. */
	icon?: string;
}

export interface ConfirmModalOptions extends QuestionOptions {
	confirmLabel: string;
	confirmClass?: ButtonClass;
	cancelLabel?: string;
}

export interface ChoiceModalOptions<K extends string> extends QuestionOptions {
	choices: ReadonlyArray<{ key: K; label: string; cls?: ButtonClass }>;
}

export async function openConfirmModal(
	options: ConfirmModalOptions,
): Promise<boolean> {
	const { confirmLabel, confirmClass = "mod-cta", cancelLabel } = options;
	const answer = await openChoiceModal({
		...options,
		choices: [
			{ key: "cancel", label: cancelLabel ?? "Cancel" },
			{ key: "confirm", label: confirmLabel, cls: confirmClass },
		],
	});
	return answer === "confirm";
}

/** Null when dismissed. */
export function openChoiceModal<K extends string>(
	options: ChoiceModalOptions<K>,
): Promise<K | null> {
	return openPromiseModal<K | null>((answer) => {
		const { app, title, body, files, icon, choices } = options;
		const modal = new Modal(app);
		const danger = choices.some(({ cls }) => cls === "mod-warning");
		renderModalHead(modal, {
			icon: icon ?? (danger ? "alert-triangle" : "info"),
			title,
			tone: danger ? "danger" : "accent",
		});
		for (const paragraph of body) {
			modal.contentEl.createEl("p", { text: paragraph });
		}
		if (files && files.length > 0) renderFiles(modal.contentEl, files);
		const footer = modalFooter(modal);
		for (const { key, label, cls } of choices) {
			const button = new ButtonComponent(footer)
				.setButtonText(label)
				.onClick(() => {
					answer(key);
					modal.close();
				});
			if (cls === "mod-warning") button.setDestructive();
			else if (cls === "mod-cta") button.setCta();
		}
		return modal;
	}, null);
}

function renderFiles(parent: HTMLElement, files: ReadonlyArray<string>): void {
	const card = modalCard(parent);
	for (const path of files.slice(0, FILES_SHOWN)) {
		renderPath(card.createDiv({ cls: "mdsync-modal-row is-compact" }), path);
	}
	if (files.length > FILES_SHOWN) {
		modalHint(parent, `… and ${files.length - FILES_SHOWN} more`);
	}
}
