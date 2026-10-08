import { fromBase64Url, toBase64Url } from "@mdsync/protocol";

/** What a reload needs to show the note again without spending another view. */
export interface CachedLink {
	sealed: Uint8Array;
	protected: boolean;
	salt: string | null;
	viewsLeft: number | null;
	expires: number | null;
}

export interface LinkCache {
	get(id: string): CachedLink | null;
	put(id: string, link: CachedLink): void;
}

const PREFIX = "mdsync-link:";

/** The sealed bytes only, in this tab's session storage: the key and passphrase are never written. */
export function sessionCache(
	storage: Storage | null = tabStorage(),
): LinkCache {
	return {
		get(id) {
			try {
				const raw = storage?.getItem(PREFIX + id);
				if (!raw) return null;
				const stored = JSON.parse(raw) as Omit<CachedLink, "sealed"> & {
					sealed: string;
				};
				return {
					...stored,
					sealed: fromBase64Url(stored.sealed),
					expires: stored.expires ?? null,
				};
			} catch {
				return null;
			}
		},
		put(id, link) {
			try {
				storage?.setItem(
					PREFIX + id,
					JSON.stringify({ ...link, sealed: toBase64Url(link.sealed) }),
				);
			} catch {
				// A note past the storage quota just costs a view on reload.
			}
		},
	};
}

/** Browsers that block site storage throw on merely reading `sessionStorage`; the note opens uncached then. */
function tabStorage(): Storage | null {
	try {
		return sessionStorage;
	} catch {
		return null;
	}
}
