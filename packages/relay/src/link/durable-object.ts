/** One share link: its sealed blob, view counter and gate. See store.ts for the rules. */

import { DurableObject } from "cloudflare:workers";
import type { LinkMeta, LinkPutMode, LinkStatus } from "@mdsync/protocol";

import {
	type LinkSettings,
	LinkStore,
	type OpenResult,
	type PutResult,
} from "./store";
import type { LinkEnv } from "./stub";

export class Link extends DurableObject<LinkEnv> {
	private readonly store = new LinkStore(this.ctx.storage.sql, Date.now, () =>
		this.release(),
	);

	async put(
		blob: ArrayBuffer,
		settings: LinkSettings,
		mode: LinkPutMode,
	): Promise<PutResult> {
		const result = this.store.put(blob, settings, mode);
		if (result !== "stored" || mode === "update") return result;
		if (settings.expires === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(settings.expires * 1000);
		return result;
	}

	open(gate: string | null, client: string): OpenResult {
		return this.store.open(gate, client);
	}

	status(): LinkStatus | null {
		return this.store.status();
	}

	meta(): LinkMeta | null {
		return this.store.meta();
	}

	revoke(): void {
		this.store.revoke();
	}

	/** The expiry: a link nobody opened again still gives its storage back. */
	alarm(): void {
		this.store.revoke();
	}

	/** Unlike deleting rows, this frees the file; the store tolerates the tables being gone. */
	private release(): void {
		void this.ctx.storage.deleteAlarm();
		void this.ctx.storage.deleteAll();
	}
}
