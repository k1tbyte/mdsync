import { readFileSync, writeFileSync } from "node:fs";

import { notesFor } from "./tools/changelog.mjs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	throw new Error("npm_package_version is not set");
}
if (!notesFor(targetVersion)) {
	throw new Error(
		`Add a "## [${targetVersion}]" section to CHANGELOG.md first.`,
	);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
// Biome's formatter wants the trailing newline.
const writeJson = (path, data) =>
	writeFileSync(path, `${JSON.stringify(data, null, "\t")}\n`);

const manifest = readJson("manifest.json");
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeJson("manifest.json", manifest);

const plugin = readJson("packages/plugin/package.json");
plugin.version = targetVersion;
writeJson("packages/plugin/package.json", plugin);

const versions = readJson("versions.json");
if (versions[targetVersion] !== minAppVersion) {
	versions[targetVersion] = minAppVersion;
	writeJson("versions.json", versions);
}
