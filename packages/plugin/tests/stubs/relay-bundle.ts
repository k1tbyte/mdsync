import type { RelayBundle } from "@/cloudflare/bundle";

const bundle: RelayBundle = {
	name: "mdsync-relay",
	version: "1.3.0+test",
	mainModule: "index.js",
	worker: "export default {};",
	compatibilityDate: "2025-01-01",
	compatibilityFlags: [],
	kvBindings: [],
	durableObjects: [],
	migrations: [],
	assets: { binding: "ASSETS", files: [] },
};

export default bundle;
