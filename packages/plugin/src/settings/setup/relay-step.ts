import { Setting } from "obsidian";

import { type RelayTestResult, testRelay } from "@/settings/connection-test";
import { isRelayConfigured } from "@/settings/model";
import { relayBase } from "@/shared";
import { alertLine, focusKey } from "@/ui/common";

import { RELAY_VERSION, useRelay } from "./relay";
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
			if (mode !== "manual") return;
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
		const line = el.createEl("p");
		if (!status) {
			line.setText(`Relay: ${plugin.settings.relayUrl}. Checking it…`);
			return;
		}
		if (!status.ok) {
			line.setText(`Relay: ${plugin.settings.relayUrl}. ${status.message}`);
		} else if (status.version === RELAY_VERSION) {
			line.setText("Relay connected and up to date.");
			return;
		} else {
			line.setText(
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
		el.createEl("p", { text: WITHOUT_RELAY });
		new Setting(el)
			.setName("Deploy to my Cloudflare")
			.setDesc(
				"Recommended. MDSync uploads the relay and can update it later. Takes about a minute.",
			)
			.addButton((b) =>
				b.setButtonText("Deploy").setCta().onClick(startDeploy),
			);
		new Setting(el)
			.setName("I already have a relay")
			.setDesc("Enter the address and secret of a relay you deployed yourself.")
			.addButton((b) =>
				b.setButtonText("Enter").onClick(() => {
					mode = "manual";
					wizard.redraw();
				}),
			);
	};

	const renderManual = (el: HTMLElement): void => {
		new Setting(el).setName("Relay URL").addText((t) => {
			focusKey(t.inputEl, "url");
			t.setPlaceholder("https://mdsync-relay.<account>.workers.dev")
				.setValue(manual.url)
				.onChange((v) => {
					manual.url = v.trim();
				});
		});
		new Setting(el).setName("Relay secret").addText((t) => {
			t.inputEl.type = "password";
			focusKey(t.inputEl, "secret");
			t.setValue(manual.secret).onChange((v) => {
				manual.secret = v.trim();
			});
		});
		if (manual.error) alertLine(el).setText(manual.error);
		new Setting(el).addButton((b) =>
			b
				.setButtonText("Connect")
				.setCta()
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
	};
	return view;
}
