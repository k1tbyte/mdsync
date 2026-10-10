import { Setting } from "obsidian";

import { randomSecret } from "@/crypto";
import { forgetCloudflare } from "@/settings/cloudflare-login";
import { testRelay } from "@/settings/connection-test";
import {
	type FieldContext,
	renderCheckRow,
	renderField,
} from "@/settings/fields";
import { isRelayConfigured } from "@/settings/model";
import { ESetupStep } from "@/settings/setup/steps";
import { relayBase } from "@/shared";
import { EFieldKind } from "@/storage";
import { runWithNotice } from "@/ui/common";

function secretButtonLabel(secret: string): string {
	return secret ? "Copy" : "Generate";
}

export function renderRelaySection(
	parent: HTMLElement,
	ctx: FieldContext,
): void {
	const { plugin } = ctx;
	new Setting(parent).setName("Relay server").setHeading();
	new Setting(parent)
		.setDesc(
			"Your own Cloudflare worker: instant sync between devices, live notes and share links. MDSync deploys it to your Cloudflare account.",
		)
		.addButton((button) =>
			button
				.setButtonText(
					isRelayConfigured(plugin.settings) ? "Update relay" : "Deploy relay",
				)
				.onClick(() => plugin.openSetup(ESetupStep.Relay)),
		);

	renderField(parent, ctx, {
		kind: EFieldKind.Text,
		name: "Relay URL",
		placeholder: "https://mdsync-relay.<account>.workers.dev",
		get: (s) => s.relayUrl,
		set: (v) => ({ relayUrl: relayBase(v) }),
	});

	const secretRow = renderField(parent, ctx, {
		kind: EFieldKind.Password,
		name: "Relay secret",
		desc: "Matches RELAY_SECRET on the worker. Sent only to your relay.",
		get: (s) => s.relaySecret,
		set: (v) => ({ relaySecret: v.trim() }),
	});
	secretRow.addButton((button) => {
		const showLabel = (): void => {
			button.setButtonText(secretButtonLabel(plugin.settings.relaySecret));
		};
		showLabel();
		secretRow.controlEl
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

	renderCheckRow(
		parent,
		"Test relay",
		"Checks that the URL reaches your relay and the secret matches.",
		() => testRelay(plugin.settings),
	);

	if (plugin.settings.cloudflareToken) {
		new Setting(parent)
			.setName("Cloudflare token")
			.setDesc("Kept on this device to deploy and update the relay.")
			.addButton((button) =>
				button.setButtonText("Forget").onClick(async () => {
					await forgetCloudflare(plugin);
					ctx.rerender();
				}),
			);
	}
}
