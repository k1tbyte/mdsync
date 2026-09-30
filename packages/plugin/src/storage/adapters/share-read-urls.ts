import { SIGN_BATCH_MAX } from "@obsync/protocol";

/** The relay signs for 120 s; a URL older than this is not worth the risk. */
const READ_URL_TTL_MS = 60_000;

interface ReadUrl {
	url: string;
	at: number;
}

/**
 * Read URLs signed a batch at a time for objects a pull said it will read.
 * Batches are made when a key is first asked for, so a long pull never holds
 * URLs that expire before it gets to them.
 */
export class ShareReadUrls {
	private pending = new Set<string>();
	private prepared = new Map<string, Promise<ReadUrl | null>>();
	private failed = false;

	constructor(
		private readonly signBatch: (keys: string[]) => Promise<string[]>,
	) {}

	expect(keys: readonly string[]): void {
		this.pending = new Set(keys);
		this.prepared.clear();
		this.failed = false;
	}

	/** The URL for the key, once; null sends the caller to sign it alone. */
	async take(key: string): Promise<string | null> {
		if (!this.prepared.has(key)) this.fill(key);
		const entry = this.prepared.get(key);
		this.prepared.delete(key);
		const ready = await entry;
		return ready && Date.now() - ready.at < READ_URL_TTL_MS ? ready.url : null;
	}

	private fill(key: string): void {
		if (this.failed || !this.pending.has(key)) return;
		const batch: string[] = [];
		let reached = false;
		for (const each of this.pending) {
			reached ||= each === key;
			if (!reached) continue;
			batch.push(each);
			if (batch.length === SIGN_BATCH_MAX) break;
		}
		for (const each of batch) this.pending.delete(each);
		const at = Date.now();
		const urls = this.signBatch(batch).catch(() => {
			this.failed = true;
			return null;
		});
		batch.forEach((each, index) => {
			const ready = urls.then((all) => {
				const url = all?.[index];
				return url ? { url, at } : null;
			});
			this.prepared.set(each, ready);
		});
	}
}
