import { mergeSettings } from "@/app/settings";
import type { DeviceKey } from "@/core/crypto";
import { decryptJson, encryptJson } from "@/core/crypto";
import type { MdsyncSettings } from "@/core/settings";
import { base64ToBytes, bytesToBase64 } from "@/core/utils";

/** The secrets, and the share state that means nothing without them: kept or lost as one. */
const SEALED = [
	"storageConfigs",
	"relaySecret",
	"cloudflareToken",
	"spaces",
	"localRoots",
	"spacesVault",
	"links",
] as const satisfies readonly (keyof MdsyncSettings)[];

type Stored = Record<string, unknown>;

/** `data.json` with the secrets sealed by the device key under `secrets`; every other field stays readable. */
export class SettingsEnvelope {
	/** One this device cannot open, written back until the sealed settings change: the keychain may recover. */
	private held: string | null = null;
	private heldView = "";

	constructor(private readonly deviceKey: DeviceKey) {}

	unreadable(): boolean {
		return this.held !== null;
	}

	/**
	 * `inTheClear`: the file holds secrets anyone who copies it can read, written by an earlier build. Beside an
	 * envelope they are a downgrade's leftovers, and the envelope wins.
	 */
	async open(
		data: Stored | null,
	): Promise<{ stored: Stored | null; inTheClear: boolean }> {
		if (!data) return { stored: null, inTheClear: false };
		const { secrets, ...rest } = data;
		const inTheClear = SEALED.some((field) => field in rest);
		if (typeof secrets !== "string") return { stored: data, inTheClear };
		const plain = withoutSealed(rest);
		try {
			const key = await this.deviceKey.read();
			const opened =
				key && (await decryptJson<unknown>(key, base64ToBytes(secrets)));
			if (typeof opened === "object" && opened !== null) {
				// Only the sealed fields: a blob sealed for another purpose must not leak into the settings.
				return { stored: { ...plain, ...sealedOf(opened) }, inTheClear };
			}
		} catch {
			// Another key sealed it, or none is left: held below.
		}
		this.held = secrets;
		this.heldView = JSON.stringify(sealedOf(mergeSettings(plain)));
		return { stored: plain, inTheClear };
	}

	async seal(settings: MdsyncSettings): Promise<Stored> {
		const plain = withoutSealed(settings);
		const sealed = sealedOf(settings);
		if (this.held !== null && JSON.stringify(sealed) === this.heldView) {
			return { ...plain, secrets: this.held };
		}
		const key = await this.deviceKey.readOrCreate();
		const secrets = bytesToBase64(await encryptJson(key, sealed));
		this.held = null;
		return { ...plain, secrets };
	}
}

function sealedOf(fields: object): Stored {
	const source = fields as Stored;
	return Object.fromEntries(
		SEALED.filter((field) => field in source).map((field) => [
			field,
			source[field],
		]),
	);
}

function withoutSealed(fields: object): Stored {
	const plain: Stored = { ...fields };
	for (const field of SEALED) delete plain[field];
	return plain;
}
