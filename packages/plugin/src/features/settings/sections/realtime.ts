import type { Setting, SettingDefinitionGroup } from "obsidian";
import { LIVE_SEND_MS } from "@/core/constants";
import type { RelayStatus } from "@/core/hub";
import { RELAY_TEXT } from "@/core/hub";
import {
	EFieldKind,
	type FieldContext,
	fieldRow,
	group,
	type SettingsField,
	type SettingsHost,
	SUB_SETTING_CLASS,
} from "@/core/settings";
import type { LiveSessions } from "@/features/live";
import type { People } from "@/features/presence";
import type { HubConnection } from "@/features/relay";
import { VAULT_SPACE } from "@/features/sync";
import type { SettingsTabHost } from "../host";

/** The wizard shows these too, so they ask only what its host has. */
type RealtimeFieldHost = SettingsHost & {
	readonly realtime: {
		readonly hub: HubConnection;
		readonly live: LiveSessions;
	};
};

const REALTIME_FIELD: SettingsField<RealtimeFieldHost> = {
	kind: EFieldKind.Toggle,
	name: "Real-time sync",
	desc: "Other devices pull the moment you push, and you see who is in which note. Turning it off also stops live editing. Your devices use the relay server (Connection tab), shared folders their owner's.",
	get: (s) => s.realtimeSync,
	set: (v) => ({ realtimeSync: v }),
	after: restartRelay,
	rerender: true,
};

const LIVE_EDITING_FIELD: SettingsField<RealtimeFieldHost> = {
	kind: EFieldKind.Toggle,
	name: "Live editing",
	desc: "Notes open in the editor edit together, keystroke by keystroke, across your devices and with the people in shared folders, through the relay.",
	when: (s) => s.realtimeSync,
	sub: true,
	get: (s) => s.liveEditing,
	set: (v) => ({ liveEditing: v }),
	after: (plugin) => void plugin.realtime.live.refresh(),
	rerender: true,
};

const LIVE_SPEED_FIELD: SettingsField<SettingsTabHost> = {
	kind: EFieldKind.Choice,
	name: "Live editing speed",
	desc: "How often your typing reaches others. Each send is a write on the relay, and Cloudflare's free plan allows 100,000 a day. Set per device.",
	when: (s) => s.realtimeSync && s.liveEditing,
	sub: true,
	options: {
		[LIVE_SEND_MS.instant]: "Instant",
		[LIVE_SEND_MS.balanced]: "Balanced",
		[LIVE_SEND_MS.economical]: "Economical: once a second",
	},
	get: (s) => String(s.liveSendMs),
	set: (v) => ({ liveSendMs: Number(v) }),
};

const SHOW_OPEN_NOTE_FIELD: SettingsField<RealtimeFieldHost> = {
	kind: EFieldKind.Toggle,
	name: "Show my open note to others",
	desc: "Off, others see only that you are online. Live editing still shows you in a note you both have open.",
	when: (s) => s.realtimeSync,
	sub: true,
	get: (s) => s.showOpenNote,
	set: (v) => ({ showOpenNote: v }),
};

/** What the setup wizard's Features step shows under real-time sync, which its sync mode turns on. */
export const SETUP_FIELDS: ReadonlyArray<SettingsField<RealtimeFieldHost>> = [
	LIVE_EDITING_FIELD,
	SHOW_OPEN_NOTE_FIELD,
];

const REALTIME_FIELDS: ReadonlyArray<SettingsField<SettingsTabHost>> = [
	REALTIME_FIELD,
	LIVE_EDITING_FIELD,
	LIVE_SPEED_FIELD,
	SHOW_OPEN_NOTE_FIELD,
];

export function realtimeSection(
	ctx: FieldContext<SettingsTabHost>,
): SettingDefinitionGroup {
	return group("Real time", [
		...REALTIME_FIELDS.map((field) => fieldRow(ctx, field)),
		{
			name: "Connected devices",
			visible: () => ctx.plugin.settings.realtimeSync,
			render: (setting) => renderConnectedDevices(setting, ctx.plugin),
		},
	]);
}

function renderConnectedDevices(
	devicesSetting: Setting,
	plugin: SettingsTabHost,
): () => void {
	devicesSetting.settingEl.addClass(SUB_SETTING_CLASS);
	const { hub, people } = plugin.realtime;
	const render = (): void => {
		devicesSetting.setDesc(
			describeConnectedDevices(
				plugin.realtime.hub.statusOf(VAULT_SPACE.id),
				people.devices(),
			),
		);
	};
	render();

	const unsubscribeStatus = hub.listen({ onConnectionChange: render });
	const unsubscribeDevices = people.subscribe(render);
	return () => {
		unsubscribeStatus();
		unsubscribeDevices();
	};
}

function restartRelay(plugin: RealtimeFieldHost): void {
	plugin.realtime.hub.restart();
}

function describeConnectedDevices(
	status: RelayStatus,
	{ locked, devices }: ReturnType<People["devices"]>,
): string {
	if (status !== "connected") return RELAY_TEXT[status];
	if (locked) return "Sync once to unlock the device list.";
	if (devices.length === 0) {
		return "No other devices connected.";
	}
	return devices.map((device) => device.name).join(", ");
}
