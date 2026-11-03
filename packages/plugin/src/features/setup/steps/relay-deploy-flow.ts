import { randomSecret } from "@/core/crypto";
import { isRelayConfigured } from "@/core/settings";
import { serial } from "@/core/ui";
import {
	type AccountRelays,
	accountRelays,
	activateRelay,
	deployOwnRelay,
	ERelayDeployStep,
	failedRelay,
	freeRelayName,
	planRelay,
	RELAY_NAME,
	type RelayTarget,
	relayNameError,
	relayUrlOf,
	runningRelayDeploy,
	testRelay,
} from "@/features/relay";
import {
	cloudflareErrorMessage,
	cloudflareOf,
	forgetCloudflare,
} from "@/features/storage";
import { enablesRealtime } from "../feature-choices";
import type { Wizard } from "../wizard";

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

export const DEPLOY_STEPS = Object.values(ERelayDeployStep);

export interface RelayDeployState {
	readonly phase: Phase;
	readonly error: string;
	readonly existing: string | null;
	readonly secret: string;
	readonly newName: string;
	readonly reached: number;
}

export interface RelayDeployFlow {
	readonly state: RelayDeployState;
	/** A deploy is running or its relay has not answered yet. */
	busy: () => boolean;
	start: () => void;
	setSecret: (value: string) => void;
	setNewName: (value: string) => void;
	updateExisting: () => void;
	deployNew: () => void;
	anotherToken: () => void;
	retry: () => void;
	checkAgain: () => void;
}

/** `online` runs once the relay answers with this build. */
export function relayDeployFlow(
	wizard: Wizard,
	online: () => void,
): RelayDeployFlow {
	const { plugin } = wizard;
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
		const realtime = () => enablesRealtime(wizard.syncMode, plugin.settings);
		if (!(await activateRelay(plugin, realtime))) {
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

	return {
		state: {
			get phase() {
				return phase;
			},
			get error() {
				return error;
			},
			get existing() {
				return existing;
			},
			get secret() {
				return secret;
			},
			get newName() {
				return newName;
			},
			get reached() {
				return reached;
			},
		},
		busy: () =>
			phase === "attaching" || phase === "deploying" || phase === "waiting",
		start: () => void run(plan),
		setSecret: (value) => {
			secret = value.trim();
		},
		setNewName: (value) => {
			newName = value.trim();
		},
		updateExisting: () => void run(updateExisting),
		deployNew: () => void run(deployNew),
		anotherToken,
		retry: () => void run(() => plan(true)),
		checkAgain: () => void run(wait),
	};
}
