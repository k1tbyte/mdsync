import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(
	new URL("../relay/dist/relay-bundle.json", import.meta.url),
);

/**
 * Serves `mdsync:relay-bundle`: the relay built in the same run, so a release deploys the relay of
 * its own commit. Built once per process; a watch picks up relay changes on restart.
 */
export function relayBundle() {
	let contents;
	return {
		name: "relay-bundle",
		setup(build) {
			build.onResolve({ filter: /^mdsync:relay-bundle$/ }, (args) => ({
				path: args.path,
				namespace: "relay-bundle",
			}));
			build.onLoad({ filter: /.*/, namespace: "relay-bundle" }, () => {
				if (!contents) {
					// Through the shell: pnpm is a .cmd shim on Windows.
					execSync("pnpm --filter mdsync-relay run bundle", {
						stdio: ["ignore", "ignore", "inherit"],
					});
					contents = readFileSync(BUNDLE, "utf8");
				}
				return { contents, loader: "json" };
			});
		},
	};
}
