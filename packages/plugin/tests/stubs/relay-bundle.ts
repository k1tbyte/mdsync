import type { RelayBundle } from "@/cloudflare/bundle";

const bundle: RelayBundle = {
	name: "mdsync-relay",
	version: "test-version",
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
