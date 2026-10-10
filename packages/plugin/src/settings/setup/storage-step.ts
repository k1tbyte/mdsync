import { Setting } from "obsidian";

import { R2NotEnabledError, r2DashboardUrl } from "@/cloudflare";
import { cloudflareOf } from "@/settings/cloudflare-login";
import { testConnection } from "@/settings/connection-test";
import { activeStorage, isStorageConfigured } from "@/settings/model";
import { renderBackendSection } from "@/settings/sections";
import { errorMessage } from "@/shared";
import { describeStorageTarget } from "@/storage";
import { alertLine } from "@/ui/common";
import { renderTokenForm, tokenForm } from "./cloudflare-token";
import { useR2 } from "./r2";
import type { StepView, Wizard } from "./wizard";

type Mode = "choose" | "r2" | "other";

export function createStorageStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	const token = tokenForm();
	let mode: Mode = "choose";
	let busy = false;
	let error = "";
	let r2Off: string | null = null;

	/** Every way in ends here: a storage that answers, or the reason it does not. */
	const finish = async (setUp: () => Promise<void>): Promise<void> => {
		busy = true;
		error = "";
		r2Off = null;
		wizard.redraw();
		try {
			await setUp();
			const tested = await testConnection(plugin);
			if (!tested.ok) throw new Error(tested.message);
			busy = false;
			if (wizard.isShowing(view)) wizard.next();
			return;
		} catch (err) {
			if (err instanceof R2NotEnabledError) r2Off = err.accountId;
			else error = errorMessage(err);
		}
		busy = false;
		wizard.redraw();
	};
	const createR2 = () => void finish(() => useR2(plugin));

	const renderChoice = (el: HTMLElement): void => {
		if (isStorageConfigured(plugin.settings)) {
			el.createEl("p", {
				text: `Using ${describeStorageTarget(activeStorage(plugin.settings))}. Select Next to keep it.`,
			});
		}
		new Setting(el)
			.setName("Cloudflare R2")
			.setDesc(
				"Recommended. Free up to 10 GB. MDSync makes the bucket and its keys from one Cloudflare token. R2 asks for a payment method once, even on the free plan.",
			)
			.addButton((b) =>
				b
					.setButtonText("Set up R2")
					.setCta()
					.onClick(() => {
						mode = "r2";
						wizard.redraw();
					}),
			);
		new Setting(el)
			.setName("Other storage")
			.setDesc(
				"Any S3-compatible service, WebDAV, or Google Drive (needs an auth server of your own).",
			)
			.addButton((b) =>
				b.setButtonText("Choose").onClick(() => {
					mode = "other";
					wizard.redraw();
				}),
			);
	};

	const renderR2 = (el: HTMLElement): void => {
		if (!cloudflareOf(plugin.settings)) {
			renderTokenForm(el, wizard, token, createR2);
			return;
		}
		el.createEl("p", {
			text: "Keep this token in Cloudflare: the storage keys come from it, so deleting it stops sync.",
		});
		if (r2Off) {
			alertLine(el).setText(
				"R2 is not turned on for this Cloudflare account yet. Open R2, add a payment method (the free plan costs nothing), then try again.",
			);
			const account = r2Off;
			new Setting(el).addButton((b) =>
				b
					.setButtonText("Open R2")
					.onClick(() => window.open(r2DashboardUrl(account))),
			);
		}
		if (error) alertLine(el).setText(error);
		new Setting(el).addButton((b) =>
			b
				.setButtonText(
					busy ? "Creating…" : r2Off ? "Try again" : "Create storage",
				)
				.setCta()
				.setDisabled(busy)
				.onClick(createR2),
		);
	};

	const renderOther = (el: HTMLElement): void => {
		renderBackendSection(el, plugin, () => wizard.redraw());
		if (error) alertLine(el).setText(error);
		new Setting(el).addButton((b) =>
			b
				.setButtonText(busy ? "Checking…" : "Continue")
				.setCta()
				.setDisabled(busy)
				.onClick(() => void finish(async () => undefined)),
		);
	};

	const view: StepView = {
		render(el) {
			el.createEl("h3", { text: "Where your vault is kept" });
			if (mode === "choose") renderChoice(el);
			else if (mode === "r2") renderR2(el);
			else renderOther(el);
		},
		back() {
			if (mode === "choose") return false;
			mode = "choose";
			error = "";
			r2Off = null;
			return true;
		},
	};
	return view;
}
