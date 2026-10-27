import { deviceKey, FakeSecretStorage } from "@tests/helpers/device-key";
import { link } from "@tests/helpers/shared-links";
import { describe, expect, it } from "vitest";
import { mergeSettings } from "@/app/settings";
import { SettingsEnvelope } from "@/app/settings-envelope";
import { encryptJson } from "@/core/crypto/cipher";
import type { MdsyncSettings } from "@/core/settings/model";
import { bytesToBase64 } from "@/core/utils/base64";
import { defaultS3Config } from "@/features/storage/backends/s3";

const SEALED = [
	"storageConfigs",
	"relaySecret",
	"cloudflareToken",
	"spaces",
	"localRoots",
	"spacesVault",
	"links",
];

function configured(bucket = "notes"): MdsyncSettings {
	return mergeSettings({
		storageConfigs: {
			s3: {
				...defaultS3Config(),
				bucket,
				accessKeyId: "AKIA",
				secretAccessKey: "S".repeat(40),
			},
		},
		relaySecret: "relay-secret",
		cloudflareToken: "cf-token",
		localRoots: { share: "Moved" },
		spacesVault: "s3|vault",
		links: [link("a")],
		uiLayout: "flat",
	});
}

/** What Obsidian writes to data.json and reads back. */
function onDisk(data: object): Record<string, unknown> {
	return JSON.parse(JSON.stringify(data));
}

async function launch(
	data: Record<string, unknown> | null,
	secrets: FakeSecretStorage,
) {
	const envelope = new SettingsEnvelope(deviceKey(secrets));
	const opened = await envelope.open(data);
	return { envelope, ...opened, settings: mergeSettings(opened.stored) };
}

describe("SettingsEnvelope", () => {
	it("keeps the secrets out of the file in the clear and opens them on the next launch", async () => {
		const secrets = new FakeSecretStorage();
		const settings = configured();
		const file = onDisk(
			await new SettingsEnvelope(deviceKey(secrets)).seal(settings),
		);

		for (const field of SEALED) expect(file).not.toHaveProperty(field);
		expect(JSON.stringify(file)).not.toContain("relay-secret");
		expect(file.uiLayout).toBe("flat");

		const next = await launch(file, secrets);
		expect(next.settings).toEqual(settings);
		expect(next.settings).not.toHaveProperty("secrets");
		expect(next.inTheClear).toBe(false);
		expect(next.envelope.unreadable()).toBe(false);
	});

	it("takes an earlier build's file as it is and says it holds secrets in the clear", async () => {
		const file = onDisk(configured());

		const next = await launch(file, new FakeSecretStorage());

		expect(next.inTheClear).toBe(true);
		expect(next.settings).toEqual(configured());
	});

	it("opens no secrets in a copy on another device, but keeps the rest", async () => {
		const file = onDisk(
			await new SettingsEnvelope(deviceKey(new FakeSecretStorage())).seal(
				configured(),
			),
		);

		const copy = await launch(file, new FakeSecretStorage());

		expect(copy.envelope.unreadable()).toBe(true);
		expect(copy.settings).toEqual(mergeSettings({ uiLayout: "flat" }));
	});

	it("writes an unreadable envelope back untouched until the sealed settings change", async () => {
		const file = onDisk(
			await new SettingsEnvelope(deviceKey(new FakeSecretStorage())).seal(
				configured(),
			),
		);
		const secrets = new FakeSecretStorage();
		const copy = await launch(file, secrets);

		copy.settings.uiLayout = "tree";
		expect((await copy.envelope.seal(copy.settings)).secrets).toBe(
			file.secrets,
		);

		const again = configured("other");
		const resealed = onDisk(await copy.envelope.seal(again));
		expect(resealed.secrets).not.toBe(file.secrets);
		expect(copy.envelope.unreadable()).toBe(false);
		expect((await launch(resealed, secrets)).settings).toEqual(again);
	});

	it("keeps what is sealed after an unreadable envelope, even before storage is set up", async () => {
		const file = onDisk(
			await new SettingsEnvelope(deviceKey(new FakeSecretStorage())).seal(
				configured(),
			),
		);
		const secrets = new FakeSecretStorage();
		const copy = await launch(file, secrets);

		copy.settings.cloudflareToken = "new-token";
		copy.settings.links = [link("b")];
		const saved = onDisk(await copy.envelope.seal(copy.settings));

		expect(saved.secrets).not.toBe(file.secrets);
		const next = await launch(saved, secrets);
		expect(next.settings.cloudflareToken).toBe("new-token");
		expect(next.settings.links).toEqual([link("b")]);
	});

	it("takes only the sealed fields from what it opens", async () => {
		const secrets = new FakeSecretStorage();
		const key = deviceKey(secrets);
		const foreign = bytesToBase64(
			await encryptJson(await key.readOrCreate(), {
				version: 1,
				passphrase: "hunter2",
				binding: "b",
			}),
		);

		const next = await launch({ uiLayout: "flat", secrets: foreign }, secrets);

		expect(next.settings).not.toHaveProperty("passphrase");
		expect(
			JSON.stringify(await next.envelope.seal(next.settings)),
		).not.toContain("hunter2");
	});

	it("lets the envelope win over secrets an older build left beside it, and asks to scrub them", async () => {
		const secrets = new FakeSecretStorage();
		const file = onDisk(
			await new SettingsEnvelope(deviceKey(secrets)).seal(configured()),
		);

		const next = await launch({ ...file, relaySecret: "stale" }, secrets);
		const copy = await launch(
			{ ...file, relaySecret: "stale" },
			new FakeSecretStorage(),
		);

		expect(next.settings.relaySecret).toBe("relay-secret");
		expect(next.inTheClear).toBe(true);
		expect(copy.inTheClear).toBe(true);
		expect(await copy.envelope.seal(copy.settings)).not.toHaveProperty(
			"relaySecret",
		);
	});
});
