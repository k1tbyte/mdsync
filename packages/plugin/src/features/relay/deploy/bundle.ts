/** What `packages/relay/bundle.mjs` emits: the relay ready to upload, configured by its wrangler.toml. */
export interface RelayBundle {
	name: string;
	/** Hash of everything else here; a relay deployed from this bundle reports it on `/status`. */
	version: string;
	mainModule: string;
	worker: string;
	compatibilityDate: string;
	compatibilityFlags: string[];
	kvBindings: string[];
	durableObjects: Array<{ name: string; className: string }>;
	/** Wrangler's `[[migrations]]` as written: a `tag` plus the class changes, passed through as they are. */
	migrations: Array<{ tag: string } & Record<string, unknown>>;
	assets: {
		binding: string;
		runWorkerFirst?: boolean | string[];
		files: RelayAsset[];
	};
}

export interface RelayAsset {
	/** Served path with a leading slash, e.g. `/viewer/index.html`. */
	path: string;
	hash: string;
	size: number;
	type: string;
	text: string;
}
