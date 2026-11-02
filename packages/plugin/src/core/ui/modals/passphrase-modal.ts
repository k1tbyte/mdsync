import { type App, ButtonComponent, Modal, Setting } from "obsidian";

import { weakPassphrase } from "@/core/crypto";
import { alertLine } from "../controls/alert-line";
import { onEnter } from "../input/enter-key";
import { type ModalHead, modalFooter, renderModalHead } from "../modal-frame";

import { openPromiseModal } from "./promise-modal";

type Answer = (value: string | null) => void;

function openFrame(
	app: App,
	answer: Answer,
	head: ModalHead,
	text: string,
): { modal: Modal; finish: Answer } {
	const modal = new Modal(app);
	renderModalHead(modal, head);
	modal.contentEl.createEl("p", { text });
	return {
		modal,
		finish: (value) => {
			answer(value);
			modal.close();
		},
	};
}

function passwordField(
	modal: Modal,
	label: string,
	onChange: (value: string) => void,
	onSubmit: () => void,
): HTMLInputElement {
	let input!: HTMLInputElement;
	new Setting(modal.contentEl).setName(label).addText((t) => {
		input = t.inputEl;
		t.inputEl.type = "password";
		t.inputEl.setAttr("aria-label", label);
		t.onChange(onChange);
		onEnter(t.inputEl, onSubmit);
	});
	return input;
}

function cancelAndConfirm(
	modal: Modal,
	confirmLabel: string,
	cancel: () => void,
	submit: () => void,
): void {
	const footer = modalFooter(modal);
	new ButtonComponent(footer).setButtonText("Cancel").onClick(cancel);
	new ButtonComponent(footer)
		.setButtonText(confirmLabel)
		.setCta()
		.onClick(submit);
}

export function askPassphrase(app: App): Promise<string | null> {
	return openPromiseModal<string | null>((answer) => {
		const { modal, finish } = openFrame(
			app,
			answer,
			{ icon: "lock", title: "MDSync passphrase" },
			"Enter the encryption passphrase for this vault. It is never sent to the remote storage.",
		);
		let value = "";
		const submit = (): void => {
			if (!value) {
				error.setText("Enter the passphrase, or cancel.");
				return;
			}
			finish(value);
		};
		passwordField(modal, "Passphrase", (v) => (value = v), submit);
		const error = alertLine(modal.contentEl);
		cancelAndConfirm(modal, "Continue", () => finish(null), submit);
		return modal;
	}, null);
}

export function askNewPassphrase(app: App): Promise<string | null> {
	return openPromiseModal<string | null>((answer) => {
		const { modal, finish } = openFrame(
			app,
			answer,
			{ icon: "key-round", title: "Change passphrase" },
			"Re-wraps the vault's data key under a new passphrase. Your notes are not re-encrypted, so this is instant. Every device must switch to the new passphrase afterwards.",
		);
		let next = "";
		let confirm = "";
		const submit = (): void => {
			const problem =
				weakPassphrase(next) ??
				(next === confirm ? null : "Passphrases do not match.");
			if (problem) {
				error.setText(problem);
				error.hidden = false;
				return;
			}
			finish(next);
		};
		passwordField(
			modal,
			"New passphrase",
			(v) => (next = v),
			() => (next ? confirmField.focus() : submit()),
		);
		const confirmField = passwordField(
			modal,
			"Confirm passphrase",
			(v) => (confirm = v),
			submit,
		);
		const error = alertLine(modal.contentEl);
		error.hidden = true;
		cancelAndConfirm(modal, "Change", () => finish(null), submit);
		return modal;
	}, null);
}
