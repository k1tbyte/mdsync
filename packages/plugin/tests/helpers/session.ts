import { beforeAll } from "vitest";
import { deriveKey, type EncryptionKey } from "@/core/crypto/cipher";
import { DEFAULT_SETTINGS_SYNC } from "@/core/settings/model";
import { compare, type EngineDependencies } from "@/features/sync/engine";
import type { OperationContext } from "@/features/sync/operations/types";
import { WriteJournal } from "@/features/sync/recovery/journal";
import { VAULT_SPACE } from "@/features/sync/remote/space";
import { createScopePolicy } from "@/features/sync/scope/scope";
import type { SessionState } from "@/features/sync/types";
import { FakeStorage } from "./fake-storage";
import { InMemoryAdapter } from "./in-memory-adapter";

let sharedKey: EncryptionKey;

export function useEncryptionKey(): void {
	beforeAll(async () => {
		sharedKey = await deriveKey("pw", new Uint8Array(16));
	});
}

const scope = createScopePolicy({
	settingsSync: DEFAULT_SETTINGS_SYNC,
	configDir: ".obsidian",
});

/** One device: an in-memory vault, a fake remote, and mutable session state. */
export class TestSession {
	readonly adapter = new InMemoryAdapter();
	journal = new WriteJournal(this.adapter.asDataAdapter(), ".obsidian");
	readonly logged: string[] = [];
	/** Set to store big files in chunks. */
	chunkIds?: CryptoKey;
	state: SessionState;

	constructor(
		deviceId = "device-a",
		readonly storage: FakeStorage = new FakeStorage(),
	) {
		this.state = {
			deviceId,
			deviceName: deviceId,
			vaultId: null,
			baseline: null,
			hashCache: {},
		};
	}

	deps(): EngineDependencies {
		return {
			space: VAULT_SPACE,
			adapter: this.adapter.asDataAdapter(),
			storage: this.storage,
			scope,
			key: sharedKey,
			chunkIds: this.chunkIds,
			state: this.state,
			maxFileBytes: 1_000_000,
			concurrency: 2,
			journal: this.journal,
		};
	}

	context(): OperationContext {
		return {
			setProgress: () => undefined,
			reportProgressSoon: () => undefined,
			persistState: async (state) => {
				this.state = state;
			},
			getFreshState: () => this.state,
			logInfo: async (_operation, message) => {
				this.logged.push(message);
			},
		};
	}

	compare(): ReturnType<typeof compare> {
		return compare(this.deps());
	}

	text(path: string): string {
		return this.adapter.readText(path);
	}

	/** Adopts the remote head as the baseline. */
	async adoptRemote(): Promise<void> {
		const result = await this.compare();
		this.state = {
			...this.state,
			vaultId: result.remote?.vaultId ?? null,
			baseline: result.remote,
			hashCache: result.updatedCache,
		};
	}
}

/** A second device sharing one remote. */
export function pairedSessions(): [TestSession, TestSession] {
	const storage = new FakeStorage();
	return [
		new TestSession("device-a", storage),
		new TestSession("device-b", storage),
	];
}
