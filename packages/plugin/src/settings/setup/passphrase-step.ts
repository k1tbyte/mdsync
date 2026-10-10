import { Setting } from "obsidian";

import { weakPassphrase } from "@/crypto";
import { errorMessage } from "@/shared";
import { PassphraseRotatedError } from "@/sync/keyfile";
import { alertLine, focusKey, onEnter } from "@/ui/common";

import type { StepView, Wizard } from "./wizard";

type Phase = "checking" | "new" | "existing" | "unlocked" | "unreachable";

const WRONG = "This passphrase does not open the vault.";

export function createPassphraseStep(wizard: Wizard): StepView {
	const { passphrase } = wizard.plugin;
	let phase: Phase = "checking";
	let value = "";
	let confirm = "";
	let error = "";
	let busy = false;

	/** A passphrase entered or saved earlier is tried first, so a set-up device just moves on. */
	const check = async (): Promise<void> => {
		phase = "checking";
		error = "";
		wizard.redraw();
		try {
			if (await passphrase.unlock()) phase = "unlocked";
			else phase = (await passphrase.vaultHasKey()) ? "existing" : "new";
		} catch (err) {
			if (err instanceof PassphraseRotatedError) {
				phase = "existing";
				error = "The passphrase saved here no longer opens the vault.";
			} else {
				phase = "unreachable";
				error = errorMessage(err);
			}
		}
		wizard.redraw();
	};

	const submit = async (): Promise<void> => {
		if (busy || !value) return;
		// Only a new one is held to today's rules: an older vault may have a shorter passphrase.
		if (phase === "new") {
			error =
				weakPassphrase(value) ??
				(value !== confirm ? "Passphrases do not match." : "");
			if (error) {
				wizard.redraw();
				return;
			}
		}
		busy = true;
		error = "";
		wizard.redraw();
		try {
			await passphrase.unlock(value);
			busy = false;
			if (wizard.isShowing(view)) wizard.next();
			return;
		} catch (err) {
			error = err instanceof PassphraseRotatedError ? WRONG : errorMessage(err);
		}
		busy = false;
		wizard.redraw();
	};

	const field = (
		el: HTMLElement,
		name: string,
		current: string,
		set: (v: string) => void,
	) =>
		new Setting(el).setName(name).addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.setAttr("aria-label", name);
			focusKey(t.inputEl, name);
			t.setValue(current).onChange(set);
			onEnter(t.inputEl, () => void submit());
		});

	void check();
	const view: StepView = {
		render(el) {
			el.createEl("h3", { text: "Encryption passphrase" });
			if (phase === "checking") {
				el.createEl("p", { text: "Checking the storage…" });
				return;
			}
			if (phase === "unlocked") {
				el.createEl("p", {
					text: "This device has the vault's passphrase. Change it under Settings → MDSync → Encryption.",
				});
				return;
			}
			if (phase === "unreachable") {
				alertLine(el).setText(`Could not reach the storage: ${error}`);
				new Setting(el).addButton((b) =>
					b.setButtonText("Try again").onClick(() => void check()),
				);
				return;
			}
			if (phase === "new") {
				el.createEl("p", {
					text: "It encrypts every note before it leaves this device. Nobody can reset it, MDSync included: lose it and the synced copy cannot be read. Your notes here stay as they are.",
				});
				field(el, "Passphrase", value, (v) => {
					value = v;
				});
				field(el, "Confirm passphrase", confirm, (v) => {
					confirm = v;
				});
			} else {
				el.createEl("p", {
					text: "This storage already holds a vault. Enter the passphrase you set on your other device.",
				});
				field(el, "Passphrase", value, (v) => {
					value = v;
				});
			}
			if (error) alertLine(el).setText(error);
			new Setting(el).addButton((b) =>
				b
					.setButtonText(
						busy ? "Checking…" : phase === "new" ? "Set passphrase" : "Unlock",
					)
					.setCta()
					.setDisabled(busy)
					.onClick(() => void submit()),
			);
		},
	};
	return view;
}
