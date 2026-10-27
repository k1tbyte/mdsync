import type { DataAdapter, SecretStorage } from "obsidian";

import { PLUGIN_ID } from "@/core/constants";
import { reportWarning } from "@/core/shared";
import { base64ToBytes, bytesToBase64 } from "@/core/utils";
import { deletePath, readBinary } from "@/core/vault";
import { type EncryptionKey, importAesKey, randomBytes } from "./cipher";
import { DEVICE_KEY_BYTES, DEVICE_KEY_FILE_NAME } from "./constants";

const SECRET_ID = `${PLUGIN_ID}-device-key`;

/**
 * Seals what this device keeps in the plugin folder. It lives in Obsidian's keychain, outside the vault, so a
 * copy of the vault folder opens none of it.
 */
export class DeviceKey {
	private key: Promise<EncryptionKey | null> | null = null;
	private created: Promise<EncryptionKey> | null = null;

	constructor(
		private readonly secrets: SecretStorage,
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
	) {}

	/** Null until something sealed needed one, or when the keychain lost it. */
	read(): Promise<EncryptionKey | null> {
		this.key ??= this.load();
		return this.key;
	}

	/** One key however many callers ask at once: a second would orphan what the first sealed. */
	readOrCreate(): Promise<EncryptionKey> {
		this.created ??= this.read().then((key) => key ?? this.create());
		return this.created;
	}

	private async load(): Promise<EncryptionKey | null> {
		await this.moveLegacyFile();
		const value = this.secrets.getSecret(SECRET_ID);
		if (!value) return null;
		try {
			const bytes = base64ToBytes(value);
			return bytes.length === DEVICE_KEY_BYTES
				? await importAesKey(bytes)
				: null;
		} catch {
			return null;
		}
	}

	private async create(): Promise<EncryptionKey> {
		const bytes = randomBytes(DEVICE_KEY_BYTES);
		this.secrets.setSecret(SECRET_ID, bytesToBase64(bytes));
		const key = await importAesKey(bytes);
		this.key = Promise.resolve(key);
		return key;
	}

	/** Earlier builds kept the key beside what it sealed; retried at every launch until the file is gone. */
	private async moveLegacyFile(): Promise<void> {
		const path = `${this.configDir.replace(/\/$/, "")}/plugins/${PLUGIN_ID}/${DEVICE_KEY_FILE_NAME}`;
		try {
			if (!(await this.adapter.exists(path))) return;
			if (!this.secrets.getSecret(SECRET_ID)) {
				const bytes = await readBinary(this.adapter, path);
				if (bytes.length === DEVICE_KEY_BYTES) {
					this.secrets.setSecret(SECRET_ID, bytesToBase64(bytes));
				}
			}
			await deletePath(this.adapter, path);
		} catch (err) {
			reportWarning(
				"Could not move the device key into Obsidian's keychain.",
				err,
			);
		}
	}
}
