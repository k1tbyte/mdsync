import { Setting, setIcon } from "obsidian";
import { randomSecret } from "@/core/crypto";
import { isRelayConfigured } from "@/core/settings";
import { alertLine, callout, focusKey, serial } from "@/core/ui";
import {
	activateRelay,
	deployOwnRelay,
	failedRelay,
	planRelay,
	runningRelayDeploy,
} from "@/features/relay/deploy/deploy-flow";
import {
	type AccountRelays,
	accountRelays,
	freeRelayName,
	RELAY_NAME,
	type RelayTarget,
	relayNameError,
	relayUrlOf,
} from "@/features/relay/deploy/relay-account";
import { ERelayDeployStep } from "@/features/relay/deploy/relay-deploy";
import {
	cloudflareErrorMessage,
	cloudflareOf,
	forgetCloudflare,
	testRelay,
} from "@/features/storage";
import { actionRow, busyLine } from "../form";
import type { Wizard } from "../wizard";
import { renderTokenForm, tokenForm } from "./cloudflare-token";

type Phase =
	| "token"
	| "attaching"
	| "checking"
	| "taken"
	| "deploying"
	| "waiting"
	| "silent"
	| "failed"
	| "done";

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
	let phase: Phase = "checking";
	let error = "";
	let relays: AccountRelays | null = null;
	/** The worker to update with a secret typed here; null when this device's relay is not on the account. */
	let existing: string | null = RELAY_NAME;
	let secret = "";
	let newName = "";
	let reached = 0;
	/** The deploy that went last: "Try again" repeats it with the secret it chose. */
	let attempted: RelayTarget | null = null;
	const fail = (err: unknown): void => {
		phase = "failed";
		error = cloudflareErrorMessage(err);
		wizard.redraw();
	};

	/** The deploy goes on after Back or a closed wizard; a second one must not start beside it. */
	const run = serial((task: () => Promise<void>) => task().catch(fail));

	const plan = async (retry = false): Promise<void> => {
		const login = cloudflareOf(plugin.settings);
		if (!login) {
			phase = "token";
			wizard.redraw();
			return;
		}
		const running = runningRelayDeploy();
		if (running) return attach(running, login.accountId);
		phase = "checking";
		reached = 0;
		error = "";
		wizard.redraw();
		relays = await accountRelays(login.api, login.accountId);
		newName = freeRelayName(relays.taken);
		const next = await planRelay(
			relays,
			plugin.settings,
			(retry ? attempted : null) ??
				// Only while no relay is set: its secret exists nowhere else. Otherwise a stale one could replace a working relay.
				(isRelayConfigured(plugin.settings)
					? null
					: failedRelay(login.accountId)),
		);
		if ("deploy" in next) return deploy(next.deploy);
		existing = next.ask;
		phase = "taken";
		wizard.redraw();
	};

	const deploy = async (target: RelayTarget): Promise<void> => {
		const login = cloudflareOf(plugin.settings);
		if (!login) return plan();
		const running = runningRelayDeploy();
		if (running) return attach(running, login.accountId);
		attempted = target;
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

	/** A wizard closed mid-deploy left it running: this one follows it instead of starting another. */
	const attach = async (
		running: Promise<void>,
		accountId: string,
	): Promise<void> => {
		phase = "attaching";
		wizard.redraw();
		try {
			await running;
		} catch (err) {
			attempted = failedRelay(accountId);
			throw err;
		}
		reached = DEPLOY_STEPS.length;
		await wait();
	};

	const wait = async (): Promise<void> => {
		phase = "waiting";
		wizard.redraw();
		if (!(await activateRelay(plugin))) {
			phase = "silent";
			wizard.redraw();
			return;
		}
		phase = "done";
		reached = DEPLOY_STEPS.length + 1;
		if (!wizard.isLive()) return;
		wizard.redraw();
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
			attempted = null;
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
			callout(
				el,
				"warning",
				`This device's relay, ${plugin.settings.relayUrl}, is not on this Cloudflare account.`,
			);
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
				t.setValue(secret).onChange((v) => {
					secret = v.trim();
				});
			})
			.addButton((b) =>
				b.setButtonText("Update").onClick(() => void run(updateExisting)),
			);
	};

	const renderProgress = (el: HTMLElement): void => {
		const list = el.createEl("ol", { cls: "mdsync-progress" });
		const labels = [...DEPLOY_STEPS.map((s) => STEP_LABELS[s]), "Answering"];
		labels.forEach((label, at) => {
			const item = list.createEl("li", { cls: "mdsync-progress-step" });
			const dot = item.createSpan({ cls: "mdsync-progress-dot" });
			item.createSpan({ text: label });
			if (at < reached) {
				item.addClass("is-done");
				setIcon(dot, "check");
			} else if (at === reached) {
				const failed = phase === "failed";
				item.addClass(failed ? "is-failed" : "is-running");
				if (failed) setIcon(dot, "x");
			}
		});
		if (phase === "waiting") {
			callout(
				el,
				"info",
				"Waiting for the relay to answer. A new workers.dev address can take a few minutes.",
			);
		}
		if (phase === "silent") {
			callout(
				el,
				"warning",
				"The relay is deployed but does not answer yet. Check again in a minute.",
			);
			actionRow(el).addButton((b) =>
				b
					.setButtonText("Check again")
					.setCta()
					.onClick(() => void run(wait)),
			);
		}
	};

	return {
		start: () => void run(plan),
		busy: () =>
			phase === "attaching" || phase === "deploying" || phase === "waiting",
		render(el) {
			if (phase === "token") {
				callout(
					el,
					"info",
					"MDSync deploys the relay with a Cloudflare token. It runs on the free Workers plan; no payment method needed.",
				);
				renderTokenForm(el, wizard, token, () => void run(plan));
				return;
			}
			if (phase === "attaching") {
				busyLine(el, "The relay is still deploying from earlier…");
				return;
			}
			if (phase === "checking") {
				busyLine(el, "Looking at your Cloudflare account…");
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
				actionRow(el)
					.addButton((b) =>
						b.setButtonText("Use another token").onClick(anotherToken),
					)
					.addButton((b) =>
						b
							.setButtonText("Try again")
							.setCta()
							.onClick(() => void run(() => plan(true))),
					);
			}
		},
	};
}
