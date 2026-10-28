#!/usr/bin/env node
/**
 * Measures what chunking would save on a real vault's history (design 9.3). Obsidian must run with the CDP
 * port open (`node tools/obsidian.mjs launch`) and MDSync unlocked; nothing is written to the remote.
 *
 *   pnpm measure:history [--max-pairs 500] [--max-mb 64] [--out report.json]
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import esbuild from "esbuild";
import { openApp } from "../obsidian.mjs";

const { values } = parseArgs({
	options: {
		"max-pairs": { type: "string" },
		"max-mb": { type: "string", default: "64" },
		out: { type: "string" },
	},
});
const plugin = new URL("../../packages/plugin/", import.meta.url);
const { outputFiles } = await esbuild.build({
	entryPoints: [fileURLToPath(new URL("measure.ts", import.meta.url))],
	alias: { "@": fileURLToPath(new URL("src", plugin)) },
	tsconfig: fileURLToPath(new URL("tsconfig.json", plugin)),
	// core/crypto reaches core/vault, which uses the API only in functions this never calls.
	plugins: [
		{
			name: "obsidian-stub",
			setup(build) {
				build.onResolve({ filter: /^obsidian$/ }, () => ({
					path: "obsidian",
					namespace: "stub",
				}));
				build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
					contents: "module.exports = {};",
				}));
			},
		},
	],
	bundle: true,
	write: false,
	format: "iife",
	globalName: "mdsyncMeasure",
	target: "es2020",
});
const options = {
	maxPairs: values["max-pairs"] ? Number(values["max-pairs"]) : undefined,
	maxBytes: Number(values["max-mb"]) * 1024 * 1024,
};

const { browser, page } = await openApp();
page.on("console", (message) => {
	if (message.text().startsWith("measured ")) console.log(message.text());
});
try {
	const report = await page.evaluate(
		([code, opts]) =>
			new Function(`${code}\nreturn mdsyncMeasure.run(arguments[0]);`)(opts),
		[outputFiles[0].text, options],
	);
	print(report);
	if (values.out) writeFileSync(values.out, JSON.stringify(report, null, "\t"));
} finally {
	await browser.close();
}

function print(report) {
	const perDay = report.days ? (report.pushes / report.days).toFixed(1) : "0";
	console.log(
		`${report.layout}: ${report.pushes} pushes over ${report.days} days (${perDay}/day, busiest ${report.busiestDay})`,
	);
	const size =
		report.historyBytes === null ? "" : `, ${kb(report.historyBytes)}`;
	console.log(`history: ${report.historyKeys} keys${size}`);
	console.log(
		`pairs: ${report.pairs} measured, ${report.skipped} skipped (blob gone or too large)`,
	);
	const { compressed, reproducible } = report.drawings;
	if (compressed)
		console.log(
			`LZString drawings: ${reproducible}/${compressed} re-encode byte for byte`,
		);
	const groups = report.groups.sort((a, b) => b.today - a.today);
	const all = {
		kind: "all",
		bucket: "",
		pairs: 0,
		today: 0,
		whole: 0,
		schemes: { A: 0, B: 0, C: 0 },
	};
	for (const group of groups) {
		for (const field of ["pairs", "today", "whole"]) all[field] += group[field];
		for (const name in all.schemes) all.schemes[name] += group.schemes[name];
	}
	const rows = [...groups, all].map((group) => ({
		kind: group.kind,
		size: group.bucket,
		pairs: group.pairs,
		today: kb(group.today),
		whole: share(group.whole, group.today),
		A: share(group.schemes.A, group.today),
		B: share(group.schemes.B, group.today),
		C: share(group.schemes.C, group.today),
		"A decoded":
			group.decoded === undefined ? "" : share(group.decoded, group.today),
	}));
	console.table(rows);
}

function kb(bytes) {
	return bytes < 1024 * 1024
		? `${(bytes / 1024).toFixed(0)} KB`
		: `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function share(bytes, of) {
	return `${kb(bytes)} (${of ? Math.round((100 * bytes) / of) : 0}%)`;
}
