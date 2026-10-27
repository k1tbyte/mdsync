import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "vitest";

const SRC = join(__dirname, "../../src");
const MAX_MODULES = 12;

function crowded(dir: string): string[] {
	const entries = readdirSync(dir, { withFileTypes: true });
	const modules = entries.filter(
		(e) => e.isFile() && e.name.endsWith(".ts") && !e.name.endsWith(".d.ts"),
	);
	const here =
		modules.length > MAX_MODULES
			? [`${relative(SRC, dir) || "."}: ${modules.length}`]
			: [];
	return [
		...here,
		...entries
			.filter((e) => e.isDirectory())
			.flatMap((e) => crowded(join(dir, e.name))),
	];
}

// Past the cap, group by sub-area, never by kind of file.
test("no source folder holds more than 12 modules", () => {
	expect(crowded(SRC)).toEqual([]);
});
