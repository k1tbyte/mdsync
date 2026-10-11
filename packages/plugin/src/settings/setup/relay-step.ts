import { Setting } from "obsidian";

import { RELAY_VERSION } from "@/cloudflare";
import { type RelayTestResult, testRelay } from "@/settings/connection-test";
import { isRelayConfigured } from "@/settings/model";
import { relayBase } from "@/shared";
import { alertLine, focusKey, onEnter } from "@/ui/common";

import { choiceCard } from "./choice-card";
import { actionRow, busyLine, callout } from "./form";
import { useRelay } from "./relay";
import { relayDeployView } from "./relay-deploy-view";
import { runAction } from "./run-action";
import type { StepView, Wizard } from "./wizard";

type Mode = "choose" | "deploy" | "manual";

const WITHOUT_RELAY =
	"Optional. Without a relay your devices sync on the schedule or when you push and pull, and there is no live editing, no invites to shared folders and no share links. You can add it later under Settings → MDSync → Connection.";

export function createRelayStep(wizard: Wizard): StepView {
	const { plugin } = wizard;
	let mode: Mode = "choose";
	let status: RelayTestResult | null = null;
	const manual = {
		url: plugin.settings.relayUrl,
		secret: "",
		error: "",
		busy: false,
	};
	const moveOn = (): void => {
		if (wizard.isShowing(view) && mode !== "choose") wizard.next();
	};
	const deploy = relayDeployView(wizard, moveOn);

	const checkStatus = async (): Promise<void> => {
		status = await testRelay(plugin.settings);
		wizard.redraw();
	};

	const connect = async (): Promise<void> => {
		const relay = {
			relayUrl: relayBase(manual.url),
			relaySecret: manual.secret,
		};
		const connected = await runAction(wizard, manual, async () => {
			const result = await testRelay(relay);
			if (!result.ok) throw new Error(result.message);
			// A wizard closed meanwhile may be reopened with another relay typed in.
			if (mode !== "manual" || !wizard.isShowing(view)) return;
			Object.assign(plugin.settings, relay);
			await useRelay(plugin);
		});
		if (connected && mode === "manual") moveOn();
	};

	const startDeploy = (): void => {
		mode = "deploy";
		deploy.start();
	};

	const renderStatus = (el: HTMLElement): void => {
		if (!status) {
			busyLine(el, `Checking ${plugin.settings.relayUrl}…`);
			return;
		}
		if (!status.ok) {
			callout(
				el,
				"warning",
				`Relay: ${plugin.settings.relayUrl}. ${status.message}`,
			);
		} else if (status.version === RELAY_VERSION) {
			callout(el, "success", "Relay connected and up to date.");
			return;
		} else {
			callout(
				el,
				"info",
				status.version
					? "Relay connected. This version of MDSync has a newer relay."
					: "Relay connected. It was deployed outside MDSync, so its version is unknown.",
			);
		}
		new Setting(el)
			.setName("Update relay")
			.setDesc(
				"Deploys this version's relay to your Cloudflare account. Its secret, shared folders and links stay.",
			)
			.addButton((b) =>
				b.setButtonText("Update").setCta().onClick(startDeploy),
			);
	};

	const renderChoice = (el: HTMLElement): void => {
		if (isRelayConfigured(plugin.settings)) {
			renderStatus(el);
			return;
		}
		el.createEl("p", {
			text: "A relay is a small server in your own Cloudflare account. It tells your devices the moment something changes, and carries live editing, shared folders and share links.",
		});
		callout(el, "info", WITHOUT_RELAY);
		const choices = el.createDiv({ cls: "mdsync-choices" });
		choiceCard(choices, {
			icon: "rocket",
			title: "Deploy to my Cloudflare",
			badge: "Recommended",
			desc: "MDSync uploads the relay and can update it later. Takes about a minute. If your account has no workers.dev address yet, MDSync registers a random one for it.",
			primary: true,
			onClick: startDeploy,
		});
		choiceCard(choices, {
			icon: "plug",
			title: "I already have a relay",
			desc: "Enter the address and secret of a relay you deployed yourself.",
			onClick: () => {
				mode = "manual";
				wizard.redraw();
			},
		});
	};

	const renderManual = (el: HTMLElement): void => {
		new Setting(el).setName("Relay URL").addText((t) => {
			focusKey(t.inputEl, "url");
			onEnter(t.inputEl, connect);
			t.setPlaceholder("https://mdsync-relay.<account>.workers.dev")
				.setValue(manual.url)
				.onChange((v) => {
					manual.url = v.trim();
				});
		});
		new Setting(el).setName("Relay secret").addText((t) => {
			t.inputEl.type = "password";
			focusKey(t.inputEl, "secret");
			onEnter(t.inputEl, connect);
			t.setValue(manual.secret).onChange((v) => {
				manual.secret = v.trim();
			});
		});
		if (manual.error) alertLine(el).setText(manual.error);
		actionRow(el).addButton((b) =>
			b
				.setButtonText(manual.busy ? "Connecting…" : "Connect")
				.setCta()
				.setDisabled(manual.busy)
				.onClick(() => void connect()),
		);
	};

	if (isRelayConfigured(plugin.settings)) void checkStatus();
	const view: StepView = {
		render(el) {
			el.createEl("h3", { text: "Relay" });
			if (mode === "deploy") deploy.render(el);
			else if (mode === "manual") renderManual(el);
			else renderChoice(el);
		},
		back() {
			if (mode === "choose") return false;
			mode = "choose";
			manual.error = "";
			return true;
		},
		blocksNext: () => deploy.busy(),
	};
	return view;
}
