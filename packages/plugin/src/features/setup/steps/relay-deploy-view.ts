import { Setting, setIcon } from "obsidian";
import { alertLine, callout, focusKey } from "@/core/ui";
import { ERelayDeployStep } from "@/features/relay";
import { actionRow, busyLine } from "../form";
import type { Wizard } from "../wizard";
import { renderTokenForm, tokenForm } from "./cloudflare-token";
import { DEPLOY_STEPS, relayDeployFlow } from "./relay-deploy-flow";

const STEP_LABELS: Record<ERelayDeployStep, string> = {
	[ERelayDeployStep.Subdomain]: "Workers address",
	[ERelayDeployStep.Storage]: "Relay storage",
	[ERelayDeployStep.Files]: "Share page files",
	[ERelayDeployStep.Worker]: "Relay code",
	[ERelayDeployStep.Route]: "Public address",
};

export interface RelayDeployView {
	start(): void;
	render(el: HTMLElement): void;
	/** A deploy is running or its relay has not answered yet. */
	busy(): boolean;
}

/** `online` runs once the relay answers with this build. */
export function relayDeployView(
	wizard: Wizard,
	online: () => void,
): RelayDeployView {
	const { plugin } = wizard;
	const token = tokenForm();
	const flow = relayDeployFlow(wizard, online);
	const { state } = flow;

	const renderExisting = (el: HTMLElement): void => {
		if (!state.existing) {
			callout(
				el,
				"warning",
				`This device's relay, ${plugin.settings.relayUrl}, is not on this Cloudflare account.`,
			);
			new Setting(el)
				.setName("Update it")
				.setDesc("Connect the Cloudflare account that runs it.")
				.addButton((b) =>
					b.setButtonText("Use another token").onClick(flow.anotherToken),
				);
		} else {
			renderUpdate(el, state.existing);
		}
		new Setting(el)
			.setName("Deploy a new relay")
			.setDesc(
				"Starts empty. Your other devices need its address and secret: send them a new setup link afterwards.",
			)
			.addText((t) => {
				t.inputEl.setAttr("aria-label", "Relay name");
				focusKey(t.inputEl, "name");
				t.setValue(state.newName).onChange(flow.setNewName);
			})
			.addButton((b) => b.setButtonText("Deploy new").onClick(flow.deployNew));
		if (state.error) alertLine(el).setText(state.error);
	};

	const renderUpdate = (el: HTMLElement, name: string): void => {
		callout(
			el,
			"info",
			`A relay named ${name} is already on this Cloudflare account, perhaps from another device or the GitHub action.`,
		);
		new Setting(el)
			.setName("Update it")
			.setDesc(
				"Enter its secret, from Settings → MDSync → Connection on a device that uses it. Its shared folders and links keep working.",
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.setAttr("aria-label", "Relay secret");
				focusKey(t.inputEl, "secret");
				t.setValue(state.secret).onChange(flow.setSecret);
			})
			.addButton((b) => b.setButtonText("Update").onClick(flow.updateExisting));
	};

	const renderProgress = (el: HTMLElement): void => {
		const list = el.createEl("ol", { cls: "mdsync-progress" });
		const labels = [...DEPLOY_STEPS.map((s) => STEP_LABELS[s]), "Answering"];
		labels.forEach((label, at) => {
			const item = list.createEl("li", { cls: "mdsync-progress-step" });
			const dot = item.createSpan({ cls: "mdsync-progress-dot" });
			item.createSpan({ text: label });
			if (at < state.reached) {
				item.addClass("is-done");
				setIcon(dot, "check");
			} else if (at === state.reached) {
				const failed = state.phase === "failed";
				item.addClass(failed ? "is-failed" : "is-running");
				if (failed) setIcon(dot, "x");
			}
		});
		if (state.phase === "waiting") {
			callout(
				el,
				"info",
				"Waiting for the relay to answer. A new workers.dev address can take a few minutes.",
			);
		}
		if (state.phase === "silent") {
			callout(
				el,
				"warning",
				"The relay is deployed but does not answer yet. Check again in a minute.",
			);
			actionRow(el).addButton((b) =>
				b.setButtonText("Check again").setCta().onClick(flow.checkAgain),
			);
		}
	};

	return {
		start: flow.start,
		busy: flow.busy,
		render(el) {
			if (state.phase === "token") {
				callout(
					el,
					"info",
					"MDSync deploys the relay with a Cloudflare token. It runs on the free Workers plan; no payment method needed.",
				);
				renderTokenForm(el, wizard, token, flow.start);
				return;
			}
			if (state.phase === "attaching") {
				busyLine(el, "The relay is still deploying from earlier…");
				return;
			}
			if (state.phase === "checking") {
				busyLine(el, "Looking at your Cloudflare account…");
				return;
			}
			if (state.phase === "taken") {
				renderExisting(el);
				return;
			}
			if (state.phase === "failed" && state.reached === 0) {
				alertLine(el).setText(state.error);
			} else {
				renderProgress(el);
				if (state.phase === "failed") alertLine(el).setText(state.error);
			}
			if (state.phase === "failed") {
				actionRow(el)
					.addButton((b) =>
						b.setButtonText("Use another token").onClick(flow.anotherToken),
					)
					.addButton((b) =>
						b.setButtonText("Try again").setCta().onClick(flow.retry),
					);
			}
		},
	};
}
