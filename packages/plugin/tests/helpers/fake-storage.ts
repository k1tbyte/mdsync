import type { ListedObject, StorageAdapter } from "@/storage/types";

/** In-memory StorageAdapter. */
export class FakeStorage implements StorageAdapter {
	readonly map = new Map<string, Uint8Array>();
	/** Last write per key, epoch ms; tests age objects by editing it. */
	readonly modified = new Map<string, number>();
	/** Count requests for test assertions. */
	existsCalls = 0;
	getCalls = 0;
	listCalls = 0;

	constructor(private readonly name = "fake") {}

	identity(): string {
		return this.name;
	}

	exists(key: string): Promise<boolean> {
		this.existsCalls++;
		return Promise.resolve(this.map.has(key));
	}

	get(key: string): Promise<Uint8Array | null> {
		this.getCalls++;
		return Promise.resolve(this.map.get(key) ?? null);
	}

	put(key: string, body: Uint8Array): Promise<void> {
		this.map.set(key, body);
		this.modified.set(key, Date.now());
		return Promise.resolve();
	}

	putIfAbsent(key: string, body: Uint8Array): Promise<boolean> {
		if (this.map.has(key)) return Promise.resolve(false);
		return this.put(key, body).then(() => true);
	}

	delete(key: string): Promise<void> {
		this.map.delete(key);
		this.modified.delete(key);
		return Promise.resolve();
	}

	list(prefix: string): Promise<string[]> {
		this.listCalls++;
		return Promise.resolve(
			[...this.map.keys()].filter((k) => k.startsWith(prefix)),
		);
	}

	async listDetailed(prefix: string): Promise<ListedObject[]> {
		return (await this.list(prefix)).map((key) => ({
			key,
			etag: null,
			modified: this.modified.get(key) ?? null,
		}));
	}

	/** Backdates every object, as if written that long ago. */
	age(ms: number): void {
		for (const [key, at] of this.modified) this.modified.set(key, at - ms);
	}
}
