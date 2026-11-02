import type { DataAdapter } from "obsidian";
import { sha256Hex } from "@/core/crypto";
import { sceneOfBytes } from "@/core/drawing";
import type { HashCacheEntry, ManifestEntry } from "../types";

export async function buildEntry(
	adapter: DataAdapter,
	path: string,
	size: number,
	mtime: number,
	kind: ManifestEntry["kind"],
	/** A hit the caller settled; re-testing can disagree once a future mtime turns racy. */
	hit: HashCacheEntry | undefined,
	/** Present for large files, to keep several of them out of memory at once. */
	gate?: <T>(run: () => Promise<T>) => Promise<T>,
): Promise<ManifestEntry> {
	if (hit) return { hash: hit.hash, size, mtime, kind, scene: hit.scene };
	const build = async (): Promise<ManifestEntry> => {
		const bytes = new Uint8Array(await adapter.readBinary(path));
		const hash = await sha256Hex(bytes);
		return { hash, size, mtime, kind, scene: await sceneOfBytes(path, bytes) };
	};
	return gate ? gate(build) : build();
}
