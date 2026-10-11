import type { DataAdapter, SecretStorage } from "obsidian";

import { DeviceKey } from "@/crypto/device-key";

import { InMemoryAdapter } from "./in-memory-adapter";

/** Obsidian's keychain of one vault. */
export class FakeSecretStorage {
	readonly map = new Map<string, string>();

	getSecret(id: string): string | null {
		return this.map.get(id) ?? null;
	}

	setSecret(id: string, secret: string): void {
		this.map.set(id, secret);
	}

	listSecrets(): string[] {
		return [...this.map.keys()];
	}
}

/** The device key as one launch sees it: a new one over the same keychain is a restart. */
export function deviceKey(
	secrets = new FakeSecretStorage(),
	adapter: DataAdapter = new InMemoryAdapter().asDataAdapter(),
): DeviceKey {
	return new DeviceKey(
		secrets as unknown as SecretStorage,
		adapter,
		".obsidian",
	);
}
