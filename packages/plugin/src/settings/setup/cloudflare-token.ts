import { Setting } from "obsidian";

import { type CloudflareAccount, tokenTemplateUrl } from "@/cloudflare";
import { accountsOf, connectCloudflare } from "@/settings/cloudflare-login";
import { alertLine, focusKey, onEnter } from "@/ui/common";

import { actionRow } from "./form";
import { type ActionState, runAction } from "./run-action";
import type { Wizard } from "./wizard";

/** Fetched only when the person opens "Show me how"; disclosed in the README. */
const TOKEN_DEMO_URL =
	"https://raw.githubusercontent.com/k1tbyte/mdsync/main/docs/demos/cloudflare-token.webp";

export interface TokenForm extends ActionState {
	token: string;
	accounts: CloudflareAccount[];
	accountId: string;
	demoOpen: boolean;
}

export function tokenForm(): TokenForm {
	return {
		token: "",
		accounts: [],
		accountId: "",
		demoOpen: false,
		error: "",
		busy: false,
	};
}

function renderDemo(parent: HTMLElement, form: TokenForm): void {
	const demo = parent.createEl("details", { cls: "mdsync-howto-demo" });
	demo.open = form.demoOpen;
	demo.createEl("summary", { text: "Show me how" });
	const load = (): void => {
		if (demo.querySelector("img, .mdsync-howto-demo-failed")) return;
		const img = demo.createEl("img", {
			attr: {
				src: TOKEN_DEMO_URL,
				alt: "Creating the token in Cloudflare and copying Your API Token, not the S3 keys",
			},
		});
		img.addEventListener("error", () => {
			img.replaceWith(
				createDiv({
					cls: "mdsync-howto-demo-failed",
					text: "The clip could not be loaded.",
				}),
			);
		});
	};
	if (form.demoOpen) load();
	demo.addEventListener("toggle", () => {
		form.demoOpen = demo.open;
		if (demo.open) load();
	});
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
			const { token } = form;
			const listed = form.accounts.length === 0;
			if (listed) {
				const accounts = await accountsOf(token);
				// Edited meanwhile: these accounts belong to the old token.
				if (form.token !== token) return;
				form.accounts = accounts;
				form.accountId = accounts[0]?.id ?? "";
			}
			// Several accounts: the person picks one below and connects again.
			if (listed && form.accounts.length > 1) return;
			await connectCloudflare(wizard.plugin, token, form.accountId);
			saved = true;
		});
		if (saved) connected();
	};

	const steps = el.createEl("ol", { cls: "mdsync-howto" });
	const create = steps.createEl("li");
	new Setting(create)
		.setName("Create a token")
		.setDesc(
			"Opens Cloudflare with the permissions MDSync needs already selected. Sign up or log in, select your account, then select Continue to summary and Create token.",
		)
		.addButton((b) =>
			b
				.setButtonText("Open Cloudflare")
				.onClick(() => window.open(tokenTemplateUrl())),
		);
	renderDemo(create, form);
	new Setting(steps.createEl("li"))
		.setName("Paste the token")
		.setDesc(
			"Kept on this device only, to update the relay later. Never synced or exported.",
		)
		.addText((t) => {
			t.inputEl.type = "password";
			t.inputEl.setAttr("aria-label", "Cloudflare token");
			focusKey(t.inputEl, "cloudflare-token");
			t.setValue(form.token).onChange((v) => {
				form.token = v.trim();
				form.accounts = [];
				form.accountId = "";
			});
			onEnter(t.inputEl, () => void connect());
		});
	if (form.accounts.length > 1) {
		new Setting(steps.createEl("li"))
			.setName("Choose the account")
			.setDesc(
				createFragment((f) => {
					f.appendText(
						"This token opens several accounts. Select one, then select ",
					);
					f.createEl("strong", { text: "Connect" });
					f.appendText(" again.");
				}),
			)
			.addDropdown((d) => {
				for (const account of form.accounts)
					d.addOption(account.id, account.name);
				d.setValue(form.accountId).onChange((v) => {
					form.accountId = v;
				});
			});
	}
	if (form.error) alertLine(el).setText(form.error);
	actionRow(el).addButton((b) =>
		b
			.setButtonText(form.busy ? "Connecting…" : "Connect")
			.setCta()
			.setDisabled(form.busy)
			.onClick(() => void connect()),
	);
}
