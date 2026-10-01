import { type Space, spaceOf } from "@/sync/space";
import type { HashCacheEntry } from "@/sync/types";
import type {
	IndexedFile,
	IndexedFolder,
	VaultIndex,
} from "@/vault/file-index";

export class ScanCycle {
	readonly cache: Record<string, HashCacheEntry>;
	private readonly hashes = new Map<string, Record<string, HashCacheEntry>>();
	private indexes: Map<
		string,
		{ files: IndexedFile[]; folders: IndexedFolder[] }
	> | null = null;

	constructor(
		private readonly partition: readonly Space[],
		cache: Record<string, HashCacheEntry>,
	) {
		this.cache = { ...cache };
		for (const [path, entry] of Object.entries(cache)) {
			const id = spaceOf(partition, path).id;
			let hashes = this.hashes.get(id);
			if (!hashes) {
				hashes = {};
				this.hashes.set(id, hashes);
			}
			hashes[path] = entry;
		}
	}

	hashesFor(space: Space): Record<string, HashCacheEntry> {
		return this.hashes.get(space.id) ?? {};
	}

	update(space: Space, cache: Record<string, HashCacheEntry>): void {
		for (const path of Object.keys(this.hashesFor(space)))
			delete this.cache[path];
		Object.assign(this.cache, cache);
		this.hashes.set(space.id, cache);
	}

	indexFor(space: Space, source?: VaultIndex): VaultIndex | undefined {
		if (!source) return undefined;
		if (!this.indexes) {
			this.indexes = new Map(
				this.partition.map(({ id }) => [id, { files: [], folders: [] }]),
			);
			for (const file of source.files())
				this.indexes
					.get(spaceOf(this.partition, file.path).id)
					?.files.push(file);
			for (const folder of source.folders())
				this.indexes
					.get(spaceOf(this.partition, folder.path).id)
					?.folders.push(folder);
		}
		const index = this.indexes.get(space.id);
		return {
			configDir: source.configDir,
			rename: (from, to) => source.rename(from, to),
			files: () => index?.files ?? [],
			folders: () => index?.folders ?? [],
		};
	}
}
