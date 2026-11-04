import { Setting } from "obsidian";

import { weakPassphrase } from "@/core/crypto";
import { errorMessage } from "@/core/shared";
import { alertLine, callout, focusKey, onEnter } from "@/core/ui";
import {
	isRefusedCredentials,
	openStorageRefusedModal,
	r2StorageOf,
} from "@/features/storage";
import { PassphraseRotatedError } from "@/features/sync";
import { actionRow, busyButton, busyLine } from "../form";
import { passphraseMeter } from "../passphrase-meter";
import { runAction } from "../run-action";
import type { StepView, Wizard } from "../wizard";

type Phase = "checking" | "new" | "existing" | "unlocked" | "unreachable";

const WRONG = "This passphrase does not open the vault.";

export function createPassphraseStep(wizard: Wizard): StepView {
	const { passphrase } = wizard.plugin;
	let phase: Phase = "checking";
	let value = "";
	let confirm = "";
	/** Unreachable because the storage turned the keys away, not the network. */
	let refused = false;
	const state = { busy: false, error: "" };
	/** Entered by Back after it was done: it stays to be looked at. */
	const wasUnlocked = passphrase.isUnlocked();

	/** A passphrase entered or saved earlier is tried first, so a set-up device moves on. */
	const check = async (): Promise<void> => {
		phase = "checking";
		state.error = "";
		wizard.redraw();
		try {
			if (await passphrase.unlock()) {
				phase = "unlocked";
				if (!wasUnlocked && wizard.isShowing(view)) {
					wizard.moveOn();
					return;
				}
			} else phase = (await passphrase.vaultHasKey()) ? "existing" : "new";
		} catch (err) {
			if (err instanceof PassphraseRotatedError) {
				phase = "existing";
				state.error = "The passphrase saved here no longer opens the vault.";
			} else {
				phase = "unreachable";
				refused = isRefusedCredentials(err);
				state.error = errorMessage(err);
			}
		}
		wizard.redraw();
	};

	const submit = async (): Promise<void> => {
		if (!value) return;
		// Only a new one is held to today's rules: an older vault may have a shorter passphrase.
		if (phase === "new") {
			state.error =
				weakPassphrase(value) ??
				(value !== confirm ? "Passphrases do not match." : "");
			if (state.error) {
				wizard.redraw();
				return;
			}
		}
		const unlocked = await runAction(
			wizard,
			state,
			() => passphrase.unlock(value),
			(err) =>
				err instanceof PassphraseRotatedError ? WRONG : errorMessage(err),
		);
		if (unlocked && wizard.isShowing(view)) wizard.next();
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
				busyLine(el, "Checking the storage…");
				return;
			}
			if (phase === "unlocked") {
				callout(
					el,
					"success",
					"This device has the vault's passphrase. Change it under Settings → MDSync → Connection → Encryption.",
				);
				return;
			}
			if (phase === "unreachable") {
				alertLine(el).setText(`Could not reach the storage: ${state.error}`);
				const row = actionRow(el).addButton((b) =>
					b.setButtonText("Try again").onClick(() => void check()),
				);
				if (refused && r2StorageOf(wizard.plugin.settings)) {
					row.addButton((b) =>
						b
							.setButtonText("Update keys")
							.setCta()
							.onClick(async () => {
								if (await openStorageRefusedModal(wizard.plugin)) await check();
							}),
					);
				} else if (refused) {
					el.createEl("p", {
						cls: "setting-item-description",
						text: "The storage refused this device's keys. Select Back to update them.",
					});
				}
				return;
			}
			if (phase === "new") {
				el.createEl("p", {
					text: "It encrypts every note before it leaves this device. Your notes here stay as they are.",
				});
				callout(
					el,
					"warning",
					"Nobody can reset it, MDSync included: lose it and the synced copy cannot be read.",
				);
				let meter: ((v: string) => void) | undefined;
				const first = field(el, "Passphrase", value, (v) => {
					value = v;
					meter?.(v);
				});
				first.settingEl.addClass("mdsync-meter-row");
				meter = passphraseMeter(first.descEl, value);
				field(el, "Confirm passphrase", confirm, (v) => {
					confirm = v;
				});
			} else {
				el.createEl("p", {
					text: "This storage already holds a vault. Enter the passphrase you set on your other device.",
				});
				el.createEl("p", {
					cls: "setting-item-description",
					text: "It is the one chosen on the first device. Encryption is end to end, so nobody can recover it.",
				});
				field(el, "Passphrase", value, (v) => {
					value = v;
				});
			}
			busyButton(
				el,
				state,
				phase === "new" ? "Set passphrase" : "Unlock",
				"Checking…",
				submit,
			);
		},
	};
	return view;
}
