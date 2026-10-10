import { Setting } from "obsidian";

import { type CloudflareAccount, tokenTemplateUrl } from "@/cloudflare";
import { accountsOf, connectCloudflare } from "@/settings/cloudflare-login";
import { alertLine, onEnter } from "@/ui/common";

import { type ActionState, runAction } from "./run-action";
import type { Wizard } from "./wizard";

export interface TokenForm extends ActionState {
	token: string;
	accounts: CloudflareAccount[];
	accountId: string;
}

export function tokenForm(): TokenForm {
	return { token: "", accounts: [], accountId: "", error: "", busy: false };
}

/** `connected` runs once the token is verified and saved on this device. */
export function renderTokenForm(
	el: HTMLElement,
	wizard: Wizard,
	form: TokenForm,
	connected: () => void,
): void {
	const connect = async (): Promise<void> => {
		if (!form.token) return;
		let saved = false;
		await runAction(wizard, form, async () => {
			const listed = form.accounts.length === 0;
			if (listed) {
				form.accounts = await accountsOf(form.token);
				form.accountId = form.accounts[0]?.id ?? "";
			}
			// Several accounts: the person picks one below and connects again.
			if (listed && form.accounts.length > 1) return;
			await connectCloudflare(wizard.plugin, form.token, form.accountId);
			saved = true;
		});
		if (saved) connected();
	};

	new Setting(el)
		.setName("1. Create a token")
		.setDesc(
			"Opens Cloudflare with the permissions MDSync needs already selected. Sign up or log in, select your account, then select Continue to summary and Create token.",
		)
		.addButton((b) =>
			b
				.setButtonText("Open Cloudflare")
				.onClick(() => window.open(tokenTemplateUrl())),
		);
	new Setting(el)
		.setName("2. Paste the token")
		.setDesc(
			"Kept on this device only, to update the relay later. Never synced or exported.",
		)
		.addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.setAttr("aria-label", "Cloudflare token");
			t.setValue(form.token).onChange((v) => {
				form.token = v.trim();
				form.accounts = [];
				form.accountId = "";
			});
			onEnter(t.inputEl, () => void connect());
		});
	if (form.accounts.length > 1) {
		new Setting(el).setName("Account").addDropdown((d) => {
			for (const account of form.accounts)
				d.addOption(account.id, account.name);
			d.setValue(form.accountId).onChange((v) => {
				form.accountId = v;
			});
		});
	}
	if (form.error) alertLine(el).setText(form.error);
	new Setting(el).addButton((b) =>
		b
			.setButtonText(form.busy ? "Connecting…" : "Connect")
			.setCta()
			.setDisabled(form.busy)
			.onClick(() => void connect()),
	);
}
