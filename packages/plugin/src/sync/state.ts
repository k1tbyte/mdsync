import type { DataAdapter } from "obsidian";
import { PLUGIN_ID } from "@/constants";
import { randomId } from "@/crypto";
import { reportWarning } from "@/shared";
import { writeAtomic } from "@/vault/atomic-write";
import { ensureParent } from "@/vault/io";
import { defaultDeviceName } from "./device";
import type { LocalState } from "./types";

const STATE_FILE_NAME = "state.json";

export function stateFilePath(configDir: string): string {
	const trimmed = configDir.endsWith("/") ? configDir.slice(0, -1) : configDir;
	return `${trimmed}/plugins/${PLUGIN_ID}/${STATE_FILE_NAME}`;
}

/** `stored` is the state file's own text, null when the state did not come from it. */
export async function loadState(
	adapter: DataAdapter,
	configDir: string,
): Promise<{ state: LocalState; stored: string | null }> {
	const path = stateFilePath(configDir);
	const candidates = [path, `${path}.new`, `${path}.bak`];
	let unreadable: string | null = null;
	for (const candidate of candidates) {
		if (!(await adapter.exists(candidate))) continue;
		let raw: string | null = null;
		try {
			raw = await adapter.read(candidate);
			const state = normalizeState(JSON.parse(raw) as Partial<LocalState>);
			return { state, stored: candidate === path ? raw : null };
		} catch {
			unreadable ??= raw;
		}
	}
	if (unreadable !== null) await keepUnreadable(adapter, path, unreadable);
	return { state: createEmptyState(), stored: null };
}

/** The fresh state about to be written would replace it: every baseline is compared again from scratch. */
async function keepUnreadable(
	adapter: DataAdapter,
	path: string,
	raw: string,
): Promise<void> {
	reportWarning(
		`Sync state was unreadable and starts fresh; kept as ${path}.unreadable.`,
	);
	await adapter.write(`${path}.unreadable`, raw).catch(() => undefined);
}

/**
 * Split from the write so callers can skip identical payloads. Compact: indenting a 20k-file hash cache adds
 * 0.74 MB per rewrite.
 */
export function serializeState(state: LocalState): string {
	return JSON.stringify(state);
}

export async function saveState(
	adapter: DataAdapter,
	configDir: string,
	serialized: string,
): Promise<void> {
	const path = stateFilePath(configDir);
	await ensureParent(adapter, path);
	await writeAtomic(adapter, path, serialized);
}

export async function resetState(
	adapter: DataAdapter,
	configDir: string,
	previous: LocalState | null,
): Promise<LocalState> {
	const next = createEmptyState(previous ?? undefined);
	await saveState(adapter, configDir, serializeState(next));
	return next;
}

function createEmptyState(previous?: Partial<LocalState>): LocalState {
	return {
		deviceId: previous?.deviceId ?? randomId(),
		deviceName: previous?.deviceName ?? defaultDeviceName(),
		storages: {},
		hashCache: {},
	};
}

function normalizeState(parsed: Partial<LocalState>): LocalState {
	return {
		deviceId: parsed.deviceId ?? randomId(),
		deviceName: parsed.deviceName ?? defaultDeviceName(),
		storages: parsed.storages ?? {},
		hashCache: parsed.hashCache ?? {},
	};
}
