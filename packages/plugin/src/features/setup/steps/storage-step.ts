import { isRefusedToken } from "@/core/cloudflare";
import { renderDefinitions } from "@/core/settings";
import { alertLine, callout } from "@/core/ui";
import {
	activeStorage,
	backendSection,
	cloudflareErrorMessage,
	cloudflareOf,
	describeStorageTarget,
	forgetCloudflare,
	isStorageConfigured,
	R2NotEnabledError,
	r2DashboardUrl,
	testConnection,
	useR2,
} from "@/features/storage";
import { choiceCard } from "../choice-card";
import { actionRow } from "../form";
import { runAction } from "../run-action";
import type { StepView, Wizard } from "../wizard";
import { renderTokenForm, tokenForm } from "./cloudflare-token";

type Mode = "choose" | "r2" | "other";

export function createStorageStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	const token = tokenForm();
	const state = { busy: false, error: "" };
	let mode: Mode = "choose";
	let r2Off: string | null = null;

	/** Every way in ends here: a storage that answers, or the reason it does not. */
	const finish = async (setUp: () => Promise<void>): Promise<void> => {
		r2Off = null;
		const answered = await runAction(
			wizard,
			state,
			async () => {
				await setUp();
				const tested = await testConnection(plugin);
				if (!tested.ok) throw new Error(tested.message);
			},
			(err) => {
				if (!(err instanceof R2NotEnabledError)) {
					return cloudflareErrorMessage(err);
				}
				r2Off = err.accountId;
				return "";
			},
		);
		if (answered && mode !== "choose" && wizard.isShowing(view)) wizard.next();
	};
	const createR2 = () =>
		void finish(() =>
			useR2(plugin).catch(async (err: unknown) => {
				// Rolled or deleted: the token form comes back for the new one, which lands in the same prefix.
				if (isRefusedToken(err)) await forgetCloudflare(plugin);
				throw err;
			}),
		);

	const renderChoice = (el: HTMLElement): void => {
		const configured = isStorageConfigured(plugin.settings);
		if (configured) {
			callout(
				el,
				"success",
				`Using ${describeStorageTarget(activeStorage(plugin.settings))}. Select Next to keep it.`,
			);
		}
		const choices = el.createDiv({ cls: "mdsync-choices" });
		choiceCard(choices, {
			icon: "cloud",
			title: "Cloudflare R2",
			badge: "Recommended",
			desc: `Free up to 10 GB. MDSync makes the bucket and its keys from one Cloudflare token. R2 asks for a payment method once, even on the free plan.${configured ? " Replaces the storage above." : ""}`,
			primary: true,
			onClick: () => {
				mode = "r2";
				wizard.redraw();
			},
		});
		choiceCard(choices, {
			icon: "server",
			title: "Other storage",
			desc: "Any S3-compatible service, WebDAV, or Google Drive (needs an auth server of your own).",
			onClick: () => {
				mode = "other";
				wizard.redraw();
			},
		});
	};

	const renderR2 = (el: HTMLElement): void => {
		if (!cloudflareOf(plugin.settings)) {
			if (state.error) alertLine(el).setText(state.error);
			renderTokenForm(el, wizard, token, createR2);
			return;
		}
		callout(
			el,
			"info",
			"Keep this token in Cloudflare: the storage keys come from it, so deleting it stops sync.",
		);
		if (r2Off) {
			alertLine(el).setText(
				"R2 is not turned on for this Cloudflare account yet. Open R2, add a payment method (the free plan costs nothing), then try again.",
			);
		}
		if (state.error) alertLine(el).setText(state.error);
		const row = actionRow(el);
		if (r2Off) {
			const account = r2Off;
			row.addButton((b) =>
				b
					.setButtonText("Open R2")
					.onClick(() => window.open(r2DashboardUrl(account))),
			);
		}
		row.addButton((b) =>
			b
				.setButtonText(
					state.busy ? "Creating…" : r2Off ? "Try again" : "Create storage",
				)
				.setCta()
				.setDisabled(state.busy)
				.onClick(createR2),
		);
	};

	const renderOther = (el: HTMLElement): void => {
		renderDefinitions(el, [
			backendSection({ plugin, rerender: () => wizard.redraw() }),
		]);
		if (state.error) alertLine(el).setText(state.error);
		actionRow(el).addButton((b) =>
			b
				.setButtonText(state.busy ? "Checking…" : "Continue")
				.setCta()
				.setDisabled(state.busy)
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
			// A running connect or setup would apply to the choice left behind.
			if (state.busy || token.busy) return true;
			mode = "choose";
			state.error = "";
			r2Off = null;
			return true;
		},
		blocksNext: () => mode !== "choose",
	};
	return view;
}
