import type { DataAdapter } from "obsidian";
import { PLUGIN_ID } from "@/core/constants";
import { deletePath, readBinary, writeBinary } from "@/core/vault";
import { decryptJson, encryptJson } from "./cipher";
import { PASSPHRASE_CACHE_FILE_NAME } from "./constants";
import type { DeviceKey } from "./device-key";

interface CachedPayload {
	version: 1;
	passphrase: string;
	binding: string;
}

export async function loadCachedPassphrase(
	adapter: DataAdapter,
	configDir: string,
	deviceKey: DeviceKey,
	binding: string,
): Promise<string | null> {
	const path = cachePath(configDir);
	if (!(await adapter.exists(path))) return null;
	const key = await deviceKey.read();
	if (!key) return null;
	try {
		const blob = await readBinary(adapter, path);
		const payload = await decryptJson<CachedPayload>(key, blob);
		if (payload.binding !== binding) return null;
		if (!payload.passphrase) return null;
		return payload.passphrase;
	} catch {
		return null;
	}
}

export async function saveCachedPassphrase(
	adapter: DataAdapter,
	configDir: string,
	deviceKey: DeviceKey,
	passphrase: string,
	binding: string,
): Promise<void> {
	const key = await deviceKey.readOrCreate();
	const payload: CachedPayload = { version: 1, passphrase, binding };
	const blob = await encryptJson(key, payload);
	await writeBinary(adapter, cachePath(configDir), blob);
}

export async function clearCachedPassphrase(
	adapter: DataAdapter,
	configDir: string,
): Promise<void> {
	await deletePath(adapter, cachePath(configDir));
}

function cachePath(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}/${PASSPHRASE_CACHE_FILE_NAME}`;
}
