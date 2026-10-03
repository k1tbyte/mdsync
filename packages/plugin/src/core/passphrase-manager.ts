import type { DataAdapter } from "obsidian";

import type { EncryptionKey } from "@/crypto";
import type { LiveKeys } from "@/crypto/live-keys";
import {
	clearCachedPassphrase,
	loadCachedPassphrase,
	saveCachedPassphrase,
} from "@/crypto/passphrase-cache";
import {
	activeStorage,
	isStorageConfigured,
	type MdsyncSettings,
} from "@/settings/model";
import { reportWarning } from "@/shared";
import {
	createStorageAdapter,
	type ObjectStorage,
	storageIdentity,
} from "@/storage";
import { resolveContentKey, rotatePassphrase } from "@/sync/keyfile";

interface CachedKey {
	key: EncryptionKey;
	liveKeys: LiveKeys;
	signature: string;
	epoch: number;
}

interface Resolving {
	signature: string;
	passphrase: string;
	key: Promise<EncryptionKey>;
}

export class PassphraseManager {
	private passphrase: string | null = null;
	/** Typed, not yet known to open the keyfile: cached on disk only once it does. */
	private unverified = false;
	private cachedKey: CachedKey | null = null;
	private pendingPrompt: Promise<boolean> | null = null;
	private pendingReplace = false;
	/** One derivation for every caller: each is a PBKDF2 run, and on a first sync a keyfile. */
	private resolving: Resolving | null = null;

	constructor(
		private readonly ask: () => Promise<string | null>,
		private readonly adapter: DataAdapter,
		private readonly configDir: string,
		private readonly settings: MdsyncSettings,
	) {}

	has(): boolean {
		return this.passphrase !== null;
	}

	current(): string | null {
		return this.passphrase;
	}

	async forget(): Promise<void> {
		this.passphrase = null;
		this.unverified = false;
		this.cachedKey = null;
		try {
			await clearCachedPassphrase(this.adapter, this.configDir);
		} catch (err) {
			reportWarning("Could not clear the cached passphrase.", err);
		}
	}

	dispose(): void {
		this.passphrase = null;
		this.cachedKey = null;
	}

	invalidateKey(): void {
		this.cachedKey = null;
	}

	/** Concurrent askers share one prompt instead of stacking modals. */
	async prompt(replace: boolean): Promise<boolean> {
		if (this.passphrase && !replace) return true;
		// A forced prompt is recovery: joining an in-flight one would answer with the passphrase that failed.
		while (this.pendingPrompt) {
			// A forced one already asks past the passphrase that failed.
			if (!replace || this.pendingReplace) return this.pendingPrompt;
			await this.pendingPrompt.catch(() => undefined);
		}
		const prompt = this.runPrompt(replace).finally(() => {
			if (this.pendingPrompt === prompt) this.pendingPrompt = null;
		});
		this.pendingPrompt = prompt;
		this.pendingReplace = replace;
		return prompt;
	}

	private async runPrompt(replace: boolean): Promise<boolean> {
		if (!replace && (await this.tryLoadCached())) return true;
		const value = await this.ask();
		if (!value) return false;
		this.passphrase = value;
		this.unverified = true;
		this.cachedKey = null;
		return true;
	}

	/** Re-wraps the data key without re-encrypting content. Returns the new key epoch, or null if it could not run. */
	async rotate(next: string): Promise<number | null> {
		if (!isStorageConfigured(this.settings)) {
			throw new Error("Configure a storage backend first.");
		}
		if (!(await this.prompt(false))) return null;
		if (!this.passphrase) return null;
		const storage = createStorageAdapter(activeStorage(this.settings));
		const epoch = await rotatePassphrase(storage, this.passphrase, next);
		await this.replacePassphrase(next);
		return epoch;
	}

	/** Adopts a passphrase known to open the vault: a rotation's, or one that opened a transfer. */
	async replacePassphrase(value: string): Promise<void> {
		this.passphrase = value;
		this.unverified = false;
		this.cachedKey = null;
		await this.persistIfEnabled();
	}

	async persistIfEnabled(): Promise<void> {
		if (!this.settings.cachePassphrase) return;
		if (!this.passphrase || this.unverified) return;
		try {
			await saveCachedPassphrase(
				this.adapter,
				this.configDir,
				this.passphrase,
				this.bindingSignature(),
			);
		} catch (err) {
			reportWarning("Could not cache the passphrase.", err);
		}
	}

	resolveKey(storage: ObjectStorage): Promise<EncryptionKey> {
		const { passphrase } = this;
		if (!passphrase) return Promise.reject(new Error("Passphrase is not set"));
		const signature = this.bindingSignature();
		if (this.cachedKey?.signature === signature) {
			return Promise.resolve(this.cachedKey.key);
		}
		const same = this.resolving;
		if (same?.signature === signature && same.passphrase === passphrase) {
			return same.key;
		}
		const key = this.derive(storage, passphrase, signature);
		const resolving = { signature, passphrase, key };
		this.resolving = resolving;
		const done = () => {
			if (this.resolving === resolving) this.resolving = null;
		};
		key.then(done, done);
		return key;
	}

	private async derive(
		storage: ObjectStorage,
		passphrase: string,
		signature: string,
	): Promise<EncryptionKey> {
		const { contentKey, liveKeys, epoch } = await resolveContentKey(
			storage,
			passphrase,
		);
		// Forgotten or replaced meanwhile: the old key must not come back.
		if (this.passphrase !== passphrase) return contentKey;
		this.cachedKey = { key: contentKey, liveKeys, signature, epoch };
		if (this.unverified) {
			this.unverified = false;
			await this.persistIfEnabled();
		}
		return contentKey;
	}

	/** Key epoch from the last {@link resolveKey}, or null if not resolved. */
	epoch(): number | null {
		return this.cachedKey?.epoch ?? null;
	}

	/** Live-layer keys of the current storage, once a sync session resolved the key. */
	liveKeys(): LiveKeys | null {
		const cached = this.cachedKey;
		return cached?.signature === this.bindingSignature()
			? cached.liveKeys
			: null;
	}

	private bindingSignature(): string {
		return storageIdentity(activeStorage(this.settings));
	}

	private async tryLoadCached(): Promise<boolean> {
		if (!this.settings.cachePassphrase) return false;
		const cached = await loadCachedPassphrase(
			this.adapter,
			this.configDir,
			this.bindingSignature(),
		);
		if (!cached) return false;
		this.passphrase = cached;
		this.cachedKey = null;
		return true;
	}
}
