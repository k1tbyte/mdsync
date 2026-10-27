import type { SettingDefinitionGroup } from "obsidian";

import { randomSecret } from "@/core/crypto";
import {
	checkRow,
	type FieldContext,
	fieldRow,
	group,
	isRelayConfigured,
} from "@/core/settings";
import { relayBase } from "@/core/shared";
import { runWithNotice } from "@/core/ui";
import { ESetupStep } from "@/features/setup/step-state";
import { EFieldKind, forgetCloudflare, testRelay } from "@/features/storage";

function secretButtonLabel(secret: string): string {
	return secret ? "Copy" : "Generate";
}

export function relaySection(ctx: FieldContext): SettingDefinitionGroup {
	const { plugin } = ctx;
	const secretRow = fieldRow(ctx, {
		kind: EFieldKind.Password,
		name: "Relay secret",
		desc: "Matches RELAY_SECRET on the worker. Sent only to your relay.",
		get: (s) => s.relaySecret,
		set: (v) => ({ relaySecret: v.trim() }),
	});
	return group("Relay server", [
		{
			name: "Deploy relay",
			desc: "Your own Cloudflare worker: instant sync between devices, live notes and share links. MDSync deploys it to your Cloudflare account.",
			render: (setting) => {
				const configured = isRelayConfigured(plugin.settings);
				setting.setName(configured ? "Update relay" : "Deploy relay");
				setting.addButton((button) =>
					button
						.setButtonText(configured ? "Update" : "Deploy")
						.onClick(() => plugin.openSetup(ESetupStep.Relay)),
				);
			},
		},
		fieldRow(ctx, {
			kind: EFieldKind.Text,
			name: "Relay URL",
			placeholder: "https://mdsync-relay.<account>.workers.dev",
			get: (s) => s.relayUrl,
			set: (v) => ({ relayUrl: relayBase(v) }),
		}),
		{
			...secretRow,
			render: (setting) => {
				secretRow.render(setting);
				setting.addButton((button) => {
					const showLabel = (): void => {
						button.setButtonText(
							secretButtonLabel(plugin.settings.relaySecret),
						);
					};
					showLabel();
					setting.controlEl
						.querySelector("input")
						?.addEventListener("input", showLabel);
					button.onClick(async () => {
						if (!plugin.settings.relaySecret) {
							plugin.settings.relaySecret = randomSecret();
							await plugin.saveSettings();
							ctx.rerender();
						}
						const { relaySecret } = plugin.settings;
						await runWithNotice(
							() => navigator.clipboard.writeText(relaySecret),
							"Relay secret copied.",
							"Could not copy the relay secret",
						);
					});
				});
			},
		},

		checkRow(
			"Test relay",
			"Checks that the URL reaches your relay and the secret matches.",
			() => testRelay(plugin.settings),
		),
		{
			name: "Cloudflare token",
			desc: "Kept on this device to deploy and update the relay. R2 storage keys made from it stop working if it is deleted in Cloudflare.",
			visible: () => Boolean(plugin.settings.cloudflareToken),
			render: (setting) => {
				setting.addButton((button) =>
					button.setButtonText("Forget").onClick(async () => {
						await forgetCloudflare(plugin);
						ctx.rerender();
					}),
				);
			},
		},
	]);
}
