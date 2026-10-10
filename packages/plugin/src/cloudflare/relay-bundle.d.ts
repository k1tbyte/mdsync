/** The relay this build deploys, built from packages/relay by esbuild.relay-bundle.mjs. */
declare module "mdsync:relay-bundle" {
	import type { RelayBundle } from "@/cloudflare/bundle";

	const bundle: RelayBundle;
	export default bundle;
}
