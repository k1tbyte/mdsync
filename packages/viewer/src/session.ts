/** One visit to a link: asks the relay, unlocks, and tells the view what to show. */

import {
	deriveLinkKeys,
	fromBase64Url,
	type LinkKeys,
	type LinkMeta,
	type LinkPayload,
	openLinkPayload,
} from "@mdsync/protocol";

import type { LinkApi } from "./api";
import type { CachedLink, LinkCache } from "./cache";
import type { RememberedKeys } from "./keys";

export type ViewState =
	| { kind: "loading" }
	| { kind: "passphrase"; problem?: string }
	| {
			kind: "content";
			payload: LinkPayload;
			viewsLeft: number | null;
			expires: number | null;
	  }
	| { kind: "gone" }
	| { kind: "invalid" }
	| { kind: "error"; message: string };

export interface SessionDeps {
	id: string;
	key: Uint8Array;
	api: LinkApi;
	cache: LinkCache;
	keys: RememberedKeys;
	show(state: ViewState): void;
}

/** How the keys came: typed for once, typed to be kept, or kept from an earlier visit. */
type Unlock = "once" | "remember" | "remembered";

const BROKEN = "This link is damaged: its address may have been cut short.";
const WRONG = "Wrong passphrase.";

export class LinkSession {
	private meta: LinkMeta | null = null;
	private cached: CachedLink | null = null;

	constructor(private readonly deps: SessionDeps) {}

	async start(): Promise<void> {
		const { id, key, api, cache, keys, show } = this.deps;
		show({ kind: "loading" });
		await this.guarded(async () => {
			this.cached = cache.get(id);
			this.meta = this.cached ?? (await api.meta(id));
			if (!this.meta) {
				await keys.drop(id);
				return show({ kind: "gone" });
			}
			if (!this.meta.protected) {
				return this.open(await deriveLinkKeys(key), "once");
			}
			const remembered = await keys.get(id);
			if (remembered) return this.open(remembered, "remembered");
			show({ kind: "passphrase" });
		});
	}

	async submit(passphrase: string, remember: boolean): Promise<void> {
		const meta = this.meta;
		if (!passphrase || !meta?.protected) return;
		this.deps.show({ kind: "loading" });
		await this.guarded(async () => {
			const keys = await deriveLinkKeys(
				this.deps.key,
				meta.salt !== null
					? { passphrase, salt: fromBase64Url(meta.salt) }
					: undefined,
			);
			await this.open(keys, remember ? "remember" : "once");
		});
	}

	private async open(keys: LinkKeys, unlock: Unlock): Promise<void> {
		const { show } = this.deps;
		// A reload costs no view; a wrong passphrase is only known by failing to open.
		const cached = this.cached;
		const entry = cached ?? (await this.fetch(keys, unlock));
		if (!entry) return;
		const payload = await this.read(entry.sealed, keys.content);
		if (!payload) {
			if (!cached) return show({ kind: "error", message: BROKEN });
			if (!this.meta?.protected)
				return show({ kind: "error", message: BROKEN });
			return show({ kind: "passphrase", problem: WRONG });
		}
		await this.keep(keys, unlock, entry.expires);
		show({
			kind: "content",
			payload,
			viewsLeft: entry.viewsLeft,
			expires: entry.expires,
		});
	}

	/** Spends a view; null once it has shown why the relay did not serve. */
	private async fetch(
		keys: LinkKeys,
		unlock: Unlock,
	): Promise<CachedLink | null> {
		const { id, api, cache, show } = this.deps;
		const outcome = await api.open(id, keys.gate);
		if (outcome.kind === "gone") {
			await this.deps.keys.drop(id);
			show({ kind: "gone" });
			return null;
		}
		if (outcome.kind === "gate" || outcome.kind === "cooldown") {
			// Without a passphrase only a cut-short address fails the gate.
			if (!this.meta?.protected) {
				show({ kind: "error", message: BROKEN });
				return null;
			}
			// Kept keys the relay refuses would otherwise be tried on every visit.
			if (outcome.kind === "gate" && unlock === "remembered") {
				await this.deps.keys.drop(id);
			}
			show({
				kind: "passphrase",
				problem: outcome.retryAfter ? waitMessage(outcome.retryAfter) : WRONG,
			});
			return null;
		}
		const meta = this.meta as LinkMeta;
		const entry: CachedLink = {
			sealed: outcome.sealed,
			protected: meta.protected,
			salt: meta.salt,
			viewsLeft: outcome.viewsLeft,
			expires: outcome.expires,
		};
		cache.put(id, entry);
		this.cached = entry;
		return entry;
	}

	private async keep(
		keys: LinkKeys,
		unlock: Unlock,
		expires: number | null,
	): Promise<void> {
		if (unlock === "remember")
			await this.deps.keys.put(this.deps.id, keys, expires);
	}

	private async read(
		sealed: Uint8Array,
		content: CryptoKey,
	): Promise<LinkPayload | null> {
		try {
			return await openLinkPayload(this.deps.id, sealed, content);
		} catch {
			return null;
		}
	}

	private async guarded(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch (error) {
			this.deps.show({
				kind: "error",
				message:
					error instanceof Error && error.message
						? error.message
						: "The relay could not be reached.",
			});
		}
	}
}

function waitMessage(seconds: number): string {
	return seconds < 90
		? `Too many wrong attempts. Try again in ${seconds} seconds.`
		: `Too many wrong attempts. Try again in ${Math.ceil(seconds / 60)} minutes.`;
}
