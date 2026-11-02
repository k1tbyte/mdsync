import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE = fileURLToPath(
	new URL("../relay/dist/relay-bundle.json", import.meta.url),
);
const PACKAGE = fileURLToPath(new URL("./package.json", import.meta.url));
// What the bundle is built from: the worker, the viewer it serves, and the protocol both import.
const SOURCES = ["relay", "viewer", "protocol"].map((name) =>
	fileURLToPath(new URL(`../${name}/src`, import.meta.url)),
);

/**
 * Serves `mdsync:relay-bundle`: the relay built in the same run, so a release deploys the relay of
 * its own commit. A watch rebuilds it when the sources above change, and only then.
 */
export function relayBundle() {
	let built;
	return {
		name: "relay-bundle",
		setup(build) {
			build.onResolve({ filter: /^mdsync:relay-bundle$/ }, (args) => ({
				path: args.path,
				namespace: "relay-bundle",
			}));
			build.onLoad({ filter: /.*/, namespace: "relay-bundle" }, () => {
				const { files, dirs } = sourceTree();
				// watchDirs sees only entries added or removed, not subfolders or edits: files cover those.
				const watch = { watchFiles: files, watchDirs: dirs };
				// onLoad runs on every rebuild, also those caused by the plugin's own sources.
				let stamp = stampOf(files);
				// A save during the build is already in the watch's baseline and would never rebuild: build again.
				while (built?.stamp !== stamp) {
					try {
						built = { stamp, contents: buildRelay() };
					} catch (error) {
						built = undefined;
						// A throw would end the watch for good: esbuild keeps no watch list of a failed load.
						return { errors: [{ text: error.message }], ...watch };
					}
					stamp = stampOf(files);
				}
				return { contents: built.contents, loader: "json", ...watch };
			});
		},
	};
}

function buildRelay() {
	// Through the shell: pnpm is a .cmd shim on Windows.
	execSync("pnpm --filter mdsync-relay run bundle", {
		stdio: ["ignore", "ignore", "inherit"],
	});
	const bundle = JSON.parse(readFileSync(BUNDLE, "utf8"));
	const { version } = JSON.parse(readFileSync(PACKAGE, "utf8"));
	// The release orders relays, so an older plugin never offers a downgrade.
	bundle.version = `${version}+${bundle.version}`;
	return JSON.stringify(bundle);
}

function stampOf(files) {
	return files
		.map(
			(file) => `${file}:${statSync(file, { throwIfNoEntry: false })?.mtimeMs}`,
		)
		.join("\n");
}

function sourceTree() {
	const files = [];
	const dirs = [...SOURCES];
	for (const root of SOURCES) {
		for (const entry of readdirSync(root, {
			recursive: true,
			withFileTypes: true,
		})) {
			(entry.isDirectory() ? dirs : files).push(
				join(entry.parentPath, entry.name),
			);
		}
	}
	return { files, dirs };
}
