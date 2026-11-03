import { type App, ButtonComponent, Modal, Setting } from "obsidian";
import { renderPath } from "../controls/file-path";
import { onEnter } from "../input/enter-key";
import {
	modalCard,
	modalFooter,
	modalHint,
	modalWarning,
	renderModalHead,
} from "../modal-frame";
import { openPromiseModal } from "./promise-modal";

type ButtonClass = "mod-cta" | "mod-warning";

/** Past this many, the rest are counted. */
const FILES_SHOWN = 8;

interface QuestionOptions {
	app: App;
	title: string;
	/** Above the text, for what a destructive choice deletes. */
	warning?: string;
	body: ReadonlyArray<string>;
	/** Listed under the text in a card. */
	files?: ReadonlyArray<string>;
	/** A warning sign when a choice is destructive, else an info mark. */
	icon?: string;
	/** The destructive choice waits until this word is typed; Enter then takes it. */
	typed?: string;
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
		const { app, title, warning, body, files, icon, typed, choices } = options;
		const modal = new Modal(app);
		const danger = choices.some(({ cls }) => cls === "mod-warning");
		renderModalHead(modal, {
			icon: icon ?? (danger ? "alert-triangle" : "info"),
			title,
			tone: danger ? "danger" : "accent",
		});
		if (warning) modalWarning(modal.contentEl, warning);
		for (const paragraph of body) {
			modal.contentEl.createEl("p", { text: paragraph });
		}
		if (files && files.length > 0) renderFiles(modal.contentEl, files);
		const choose = (key: K): void => {
			answer(key);
			modal.close();
		};
		const footer = modalFooter(modal);
		const destructive: [K, ButtonComponent][] = [];
		for (const { key, label, cls } of choices) {
			const button = new ButtonComponent(footer)
				.setButtonText(label)
				.onClick(() => choose(key));
			if (cls === "mod-warning")
				destructive.push([key, button.setDestructive()]);
			else if (cls === "mod-cta") button.setCta();
		}
		const [first] = destructive;
		if (typed && first) {
			const buttons = destructive.map(([, button]) => button);
			askTyped(modal.contentEl, typed, buttons, () => choose(first[0]));
		}
		return modal;
	}, null);
}

/** `buttons` stay disabled until the input reads `word`. */
function askTyped(
	parent: HTMLElement,
	word: string,
	buttons: readonly ButtonComponent[],
	take: () => void,
): void {
	let typed = false;
	for (const button of buttons) button.setDisabled(true);
	parent.createEl("p", { text: `Type ${word} to continue.` });
	new Setting(parent).setName("Confirmation").addText((text) => {
		text.inputEl.setAttr("aria-label", "Confirmation");
		text.setPlaceholder(word).onChange((value) => {
			typed = value.trim() === word;
			for (const button of buttons) button.setDisabled(!typed);
		});
		onEnter(text.inputEl, () => {
			if (typed) take();
		});
	});
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
