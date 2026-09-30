import { Setting } from "obsidian";

import {
	type FieldContext,
	renderCheckRow,
	renderField,
} from "@/settings/fields";
import { relayBase } from "@/shared/path";
import { EFieldKind } from "@/storage/field-spec";
import { runWithNotice } from "@/ui/common";
import { bytesToBase64Url } from "@/utils/base64";

import { testRelay } from "../connection-test";

const SECRET_BYTES = 32;

function secretButtonLabel(secret: string): string {
	return secret ? "Copy" : "Generate";
}

export function renderRelaySection(
	parent: HTMLElement,
	ctx: FieldContext,
): void {
	const { plugin } = ctx;
	new Setting(parent).setName("Relay server").setHeading();
	new Setting(parent).setDesc(
		"Your own Cloudflare worker: instant sync between devices. Generate a secret, save it as the RELAY_SECRET repository secret, run the Deploy Relay GitHub action and paste the URL it prints.",
	);

	renderField(parent, ctx, {
		kind: EFieldKind.Text,
		name: "Relay URL",
		placeholder: "https://obsync-relay.<account>.workers.dev",
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
				plugin.settings.relaySecret = bytesToBase64Url(
					crypto.getRandomValues(new Uint8Array(SECRET_BYTES)),
				);
				await plugin.saveSettings();
				ctx.rerender();
			}
			const { relaySecret } = plugin.settings;
			await runWithNotice(
				() => navigator.clipboard.writeText(relaySecret),
				"Relay secret copied. Save it as the RELAY_SECRET repository secret.",
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
}
