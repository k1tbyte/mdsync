import { Setting } from "obsidian";

import { ERelayDeployStep } from "@/cloudflare";
import { randomSecret } from "@/crypto";
import {
	cloudflareErrorMessage,
	cloudflareOf,
	forgetCloudflare,
} from "@/settings/cloudflare-login";
import { testRelay } from "@/settings/connection-test";
import { isRelayConfigured } from "@/settings/model";
import { alertLine, focusKey, serial } from "@/ui/common";

import { renderTokenForm, tokenForm } from "./cloudflare-token";
import {
	type AccountRelays,
	accountRelays,
	deployOwnRelay,
	freeRelayName,
	ownRelayName,
	RELAY_NAME,
	type RelayTarget,
	relayNameError,
	relayUrlOf,
	useRelay,
	waitForRelay,
} from "./relay";
import type { Wizard } from "./wizard";

type Phase =
	| "token"
	| "checking"
	| "taken"
	| "deploying"
	| "waiting"
	| "silent"
	| "failed";

const STEP_LABELS: Record<ERelayDeployStep, string> = {
	[ERelayDeployStep.Subdomain]: "Workers address",
	[ERelayDeployStep.Storage]: "Relay storage",
	[ERelayDeployStep.Files]: "Share page files",
	[ERelayDeployStep.Worker]: "Relay code",
	[ERelayDeployStep.Route]: "Public address",
};
const DEPLOY_STEPS = Object.values(ERelayDeployStep);

export interface RelayDeployView {
	start(): void;
	render(el: HTMLElement): void;
}

/** `online` runs once the relay answers with this build. */
export function relayDeployView(
	wizard: Wizard,
	online: () => void,
): RelayDeployView {
	const { plugin } = wizard;
	const token = tokenForm();
	let phase: Phase = "checking";
	let error = "";
	let relays: AccountRelays | null = null;
	/** The worker to update with a secret typed here; null when this device's relay is not on the account. */
	let existing: string | null = RELAY_NAME;
	let secret = "";
	let newName = "";
	let reached = 0;
	const fail = (err: unknown): void => {
		phase = "failed";
		error = cloudflareErrorMessage(err);
		wizard.redraw();
	};

	/** The deploy goes on after Back or a closed wizard; a second one must not start beside it. */
	const run = serial((task: () => Promise<void>) => task().catch(fail));

	/** Updates this device's relay when it can; replacing a relay, or one whose secret is unknown, is asked. */
	const plan = async (): Promise<void> => {
		const login = cloudflareOf(plugin.settings);
		if (!login) {
			phase = "token";
			wizard.redraw();
			return;
		}
		phase = "checking";
		reached = 0;
		error = "";
		wizard.redraw();
		relays = await accountRelays(login);
		newName = freeRelayName(relays.taken);
		const own = ownRelayName(relays, plugin.settings.relayUrl);
		if (own && (await testRelay(plugin.settings)).ok) {
			return deploy({ name: own, secret: plugin.settings.relaySecret });
		}
		const configured = isRelayConfigured(plugin.settings);
		if (!own && !configured && !relays.taken.includes(RELAY_NAME)) {
			return deploy({ name: RELAY_NAME, secret: randomSecret() });
		}
		existing = own ?? (configured ? null : RELAY_NAME);
		phase = "taken";
		wizard.redraw();
	};

	const deploy = async (target: RelayTarget): Promise<void> => {
		const login = cloudflareOf(plugin.settings);
		if (!login) return plan();
		phase = "deploying";
		reached = 0;
		error = "";
		wizard.redraw();
		await deployOwnRelay(plugin, login, target, (step) => {
			reached = DEPLOY_STEPS.indexOf(step);
			wizard.redraw();
		});
		reached = DEPLOY_STEPS.length;
		await wait();
	};

	const wait = async (): Promise<void> => {
		phase = "waiting";
		wizard.redraw();
		if (!(await waitForRelay(plugin.settings, () => wizard.isOpen()))) {
			phase = "silent";
			wizard.redraw();
			return;
		}
		await useRelay(plugin);
		online();
	};

	const updateExisting = async (): Promise<void> => {
		// What was checked is what goes out, even if the field changes meanwhile.
		const target = { name: existing, secret };
		const relayUrl =
			target.name && relays ? relayUrlOf(relays, target.name) : null;
		if (!target.name || !relayUrl || !target.secret) return;
		const checked = await testRelay({ relayUrl, relaySecret: target.secret });
		if (!checked.ok) {
			error = checked.message;
			wizard.redraw();
			return;
		}
		await deploy({ name: target.name, secret: target.secret });
	};

	const anotherToken = (): void =>
		void run(async () => {
			await forgetCloudflare(plugin);
			await plan();
		});

	const deployNew = async (): Promise<void> => {
		error = relayNameError(newName, relays?.taken ?? []) ?? "";
		if (error) {
			wizard.redraw();
			return;
		}
		await deploy({ name: newName, secret: randomSecret() });
	};

	const renderExisting = (el: HTMLElement): void => {
		if (!existing) {
			el.createEl("p", {
				text: `This device's relay, ${plugin.settings.relayUrl}, is not on this Cloudflare account.`,
			});
			new Setting(el)
				.setName("Update it")
				.setDesc("Connect the Cloudflare account that runs it.")
				.addButton((b) =>
					b.setButtonText("Use another token").onClick(anotherToken),
				);
		} else {
			renderUpdate(el, existing);
		}
		new Setting(el)
			.setName("Deploy a new relay")
			.setDesc(
				"Starts empty. Your other devices need its address and secret: send them a new setup link afterwards.",
			)
			.addText((t) => {
				t.inputEl.setAttr("aria-label", "Relay name");
				focusKey(t.inputEl, "name");
				t.setValue(newName).onChange((v) => {
					newName = v.trim();
				});
			})
			.addButton((b) =>
				b.setButtonText("Deploy new").onClick(() => void run(deployNew)),
			);
		if (error) alertLine(el).setText(error);
	};

	const renderUpdate = (el: HTMLElement, name: string): void => {
		el.createEl("p", {
			text: `A relay named ${name} is already on this Cloudflare account, perhaps from another device or the GitHub action.`,
		});
		new Setting(el)
			.setName("Update it")
			.setDesc(
				"Enter its secret, from Settings → MDSync → Connection on a device that uses it. Its shared folders and links keep working.",
			)
			.addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.setAttr("aria-label", "Relay secret");
				focusKey(t.inputEl, "secret");
				t.setValue(secret).onChange((v) => {
					secret = v.trim();
				});
			})
			.addButton((b) =>
				b.setButtonText("Update").onClick(() => void run(updateExisting)),
			);
	};

	const renderProgress = (el: HTMLElement): void => {
		const list = el.createEl("ul", { cls: "mdsync-setup-checklist" });
		const labels = [...DEPLOY_STEPS.map((s) => STEP_LABELS[s]), "Answering"];
		labels.forEach((label, at) => {
			const item = list.createEl("li", { text: label });
			if (at < reached) item.addClass("is-done");
			else if (at === reached) {
				item.addClass(phase === "failed" ? "is-failed" : "is-running");
			}
		});
		if (phase === "waiting") {
			el.createEl("p", {
				text: "Waiting for the relay to answer. A new workers.dev address can take a few minutes.",
			});
		}
		if (phase === "silent") {
			el.createEl("p", {
				text: "The relay is deployed but does not answer yet. Check again in a minute.",
			});
			new Setting(el).addButton((b) =>
				b.setButtonText("Check again").onClick(() => void run(wait)),
			);
		}
	};

	return {
		start: () => void run(plan),
		render(el) {
			if (phase === "token") {
				el.createEl("p", {
					text: "MDSync deploys the relay with a Cloudflare token. It runs on the free Workers plan; no payment method needed.",
				});
				renderTokenForm(el, wizard, token, () => void run(plan));
				return;
			}
			if (phase === "checking") {
				el.createEl("p", { text: "Looking at your Cloudflare account…" });
				return;
			}
			if (phase === "taken") {
				renderExisting(el);
				return;
			}
			if (phase === "failed" && reached === 0) {
				alertLine(el).setText(error);
			} else {
				renderProgress(el);
				if (phase === "failed") alertLine(el).setText(error);
			}
			if (phase === "failed") {
				new Setting(el)
					.addButton((b) =>
						b.setButtonText("Use another token").onClick(anotherToken),
					)
					.addButton((b) =>
						b
							.setButtonText("Try again")
							.setCta()
							.onClick(() => void run(plan)),
					);
			}
		},
	};
}
