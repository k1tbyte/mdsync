/** CHANGELOG.md is the source of truth for release notes: `check [tag]` and `notes <tag> <file>`. */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../", import.meta.url);
const HEADING = /^## \[([^\]]+)\]/;

/** The notes written for `version`; empty when there are none. */
export function notesFor(version) {
	const entry = sections(read("CHANGELOG.md")).find(
		(each) => each.version === version,
	);
	return entry?.notes ?? "";
}

/** The newest section is the one being released: it must match the manifest, and the tag when given. */
function check([tag]) {
	const { version } = JSON.parse(read("manifest.json"));
	const [newest] = sections(read("CHANGELOG.md"));
	if (newest?.version !== version) {
		throw new Error(
			`The newest CHANGELOG.md section is ${newest?.version}, manifest.json says ${version}.`,
		);
	}
	if (!newest.notes) {
		throw new Error(`CHANGELOG.md has no notes for ${version}.`);
	}
	if (tag !== undefined && tag !== version) {
		throw new Error(`Tag ${tag} does not match manifest.json ${version}.`);
	}
}

function notes([tag, file]) {
	check([tag]);
	writeFileSync(file, `${notesFor(tag)}\n`);
}

function sections(text) {
	const found = [];
	for (const line of text.split("\n")) {
		const heading = HEADING.exec(line);
		if (heading) found.push({ version: heading[1], lines: [] });
		else found.at(-1)?.lines.push(line);
	}
	return found.map(({ version, lines }) => ({
		version,
		notes: lines.join("\n").trim(),
	}));
}

function read(name) {
	return readFileSync(new URL(name, ROOT), "utf8").replace(/\r\n?/g, "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
	const [command, ...args] = process.argv.slice(2);
	const commands = { check, notes };
	if (!commands[command]) {
		console.error("usage: changelog.mjs check [tag] | notes <tag> <file>");
		process.exit(2);
	}
	try {
		commands[command](args);
	} catch (error) {
		console.error(error.message);
		process.exit(1);
	}
}
