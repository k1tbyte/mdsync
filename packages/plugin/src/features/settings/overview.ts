import {
	ButtonComponent,
	type SettingDefinitionGroup,
	setIcon,
} from "obsidian";
import type { PluginHost } from "@/app/host";
import type { RelayStatus } from "@/core/hub";
import { RELAY_TEXT } from "@/core/hub";
import type { FieldContext } from "@/core/settings";
import {
	activeStorage,
	canSync,
	isGuest,
	isRelayConfigured,
	isStorageConfigured,
} from "@/core/settings";
import { formatRelativeTime, pluralize } from "@/core/shared";
import { describeStorageTarget, storageIdentity } from "@/features/storage";
import { VAULT_SPACE } from "@/features/sync";

type Tone = "ok" | "muted" | "warning" | "error";

interface Card {
	icon: string;
	title: string;
	state: string;
	tone: Tone;
	lines: string[];
	action?: { text: string; run: () => void };
}

const RELAY_STATE: Record<RelayStatus, [string, Tone]> = {
	connected: ["Connected", "ok"],
	connecting: ["Connecting", "muted"],
	offline: ["Offline", "warning"],
	unauthorized: ["Refused", "error"],
	full: ["Full", "warning"],
	paused: ["Paused", "muted"],
	off: ["Off", "muted"],
	"no-relay": ["Not set up", "muted"],
};

/** The root page's head: the setup wizard and where storage, encryption and the relay stand, live. */
export function overviewGroup(ctx: FieldContext): SettingDefinitionGroup {
	const { plugin } = ctx;
	return {
		type: "group",
		cls: "mdsync-settings-overview",
		items: [
			{
				name: "Status",
				searchable: false,
				render: (setting) => {
					const root = setting.settingEl;
					root.empty();
					const head = root.createDiv({ cls: "mdsync-overview-head" });
					head.createDiv({ cls: "mdsync-overview-title", text: "MDSync" });
					const wizard = new ButtonComponent(head)
						.setButtonText("Setup wizard")
						.onClick(() => plugin.openSetup());
					if (!canSync(plugin.settings)) wizard.setCta();
					const grid = root.createDiv({ cls: "mdsync-overview-cards" });
					const draw = (): void => {
						grid.empty();
						renderCard(grid, storageCard(plugin));
						renderCard(grid, encryptionCard(plugin, draw));
						renderCard(grid, relayCard(plugin));
					};
					draw();
					const { hub, people } = plugin.realtime;
					const stops = [
						plugin.controller.subscribe(draw),
						plugin.passphrase.subscribe(draw),
						hub.listen({ onConnectionChange: draw }),
						people.subscribe(draw),
						plugin.relayUpdate.subscribe(draw),
					];
					return () => {
						for (const stop of stops) stop();
					};
				},
			},
		],
	};
}

function renderCard(grid: HTMLElement, card: Card): void {
	const el = grid.createDiv({ cls: `mdsync-overview-card is-${card.tone}` });
	const top = el.createDiv({ cls: "mdsync-overview-card-top" });
	setIcon(top.createSpan({ cls: "mdsync-overview-card-icon" }), card.icon);
	const state = top.createSpan({ cls: "mdsync-overview-card-state" });
	if (card.tone === "ok") setIcon(state.createSpan(), "check");
	state.createSpan({ text: card.state });
	el.createDiv({ cls: "mdsync-overview-card-title", text: card.title });
	const lines = el.createDiv({ cls: "mdsync-overview-card-lines" });
	for (const line of card.lines) lines.createDiv({ text: line });
	if (card.action) {
		new ButtonComponent(el)
			.setButtonText(card.action.text)
			.onClick(card.action.run);
	}
}

function storageCard(plugin: PluginHost): Card {
	const { settings } = plugin;
	const base = { icon: "hard-drive", title: "Storage" };
	if (!isStorageConfigured(settings)) {
		return isGuest(settings)
			? {
					...base,
					state: "Shares only",
					tone: "muted",
					lines: ["Only shared folders sync on this device."],
				}
			: {
					...base,
					state: "Not set up",
					tone: "muted",
					lines: ["Choose where the vault syncs in the setup wizard."],
				};
	}
	const config = activeStorage(settings);
	const where = describeStorageTarget(config);
	const { error, vaultCheck } = plugin.controller.getSnapshot();
	if (error)
		return { ...base, state: "Error", tone: "error", lines: [where, error] };
	// A target edited since its last compare is not the one that answered.
	if (vaultCheck?.storage !== storageIdentity(config)) {
		return {
			...base,
			state: "Not checked",
			tone: "muted",
			lines: [where, "A compare checks the connection."],
		};
	}
	return {
		...base,
		state: "Connected",
		tone: "ok",
		lines: [where, `Checked ${formatRelativeTime(vaultCheck.at)}`],
	};
}

function encryptionCard(plugin: PluginHost, redraw: () => void): Card {
	const { settings, passphrase } = plugin;
	const base = { icon: "lock", title: "Encryption" };
	if (!isStorageConfigured(settings)) {
		return {
			...base,
			state: "Not set up",
			tone: "muted",
			lines: ["The passphrase comes with the storage."],
		};
	}
	if (!passphrase.has()) {
		return {
			...base,
			state: "Locked",
			tone: "warning",
			lines: ["Nothing syncs until the passphrase is entered."],
			action: {
				text: "Enter passphrase",
				run: () => void passphrase.prompt(false).then(redraw),
			},
		};
	}
	return {
		...base,
		state: "Unlocked",
		tone: "ok",
		lines: [
			settings.cachePassphrase
				? "Passphrase kept on this device."
				: "Asked again after a restart.",
		],
	};
}

function relayCard(plugin: PluginHost): Card {
	const base = { icon: "radio-tower", title: "Relay" };
	if (!isRelayConfigured(plugin.settings)) {
		return {
			...base,
			state: "Not set up",
			tone: "muted",
			lines: ["Live editing, shared folders and links need one."],
		};
	}
	const { hub, people } = plugin.realtime;
	const status = hub.statusOf(VAULT_SPACE.id);
	const [state, tone] = RELAY_STATE[status];
	const line =
		status === "connected"
			? devicesText(people.devices())
			: `${RELAY_TEXT[status]}.`;
	if (!plugin.relayUpdate.ready()) {
		return { ...base, state, tone, lines: [line] };
	}
	return {
		...base,
		state: "Update ready",
		tone: "warning",
		lines: [`${state} · ${line}`],
		action: {
			text: "Update relay",
			run: () => void plugin.relayUpdate.offer(),
		},
	};
}

function devicesText({
	locked,
	devices,
}: ReturnType<PluginHost["realtime"]["people"]["devices"]>): string {
	if (locked) return "Sync once to see your other devices.";
	if (devices.length === 0) return "No other device online.";
	return `${pluralize(devices.length, "other device")} online.`;
}
