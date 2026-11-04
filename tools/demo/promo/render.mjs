// Renders index.html frame by frame and encodes it: node tools/demo/promo/render.mjs <out.mp4> [fps=30]
// With a comma list of seconds (`render.mjs - 30 4,12.5`) it writes stills to artifacts/promo/stills instead.
// Reads the takes from artifacts/demos/<take>.mp4 (DEMO_VIDEO=1) and extracts only the seconds scenes.js uses.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const work = join(root, "artifacts/promo");
const require = createRequire(join(root, "package.json"));
const { chromium } = require("playwright-core");

const [out, fpsArg = "30", only] = process.argv.slice(2);
const fps = Number(fpsArg);

function ffmpeg(args) {
	const run = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], {
		stdio: "inherit",
	});
	if (run.status !== 0) throw new Error("ffmpeg failed");
}

const browser = await chromium.launch({
	// `CHROME` points at a browser Playwright did not download; --no-sandbox because containers run as root.
	executablePath: process.env.CHROME,
	args: ["--no-sandbox", "--allow-file-access-from-files"],
});
const page = await browser.newPage({
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
});
/** A take's still stretches, [from, to] in seconds; one running to the end has no freeze_end. */
function holds(take) {
	const run = spawnSync(
		"ffmpeg",
		[
			"-hide_banner",
			"-i",
			join(root, "artifacts/demos", `${take}.mp4`),
			"-vf",
			"freezedetect=n=-95dB:d=0.5",
			"-map",
			"0:v",
			"-f",
			"null",
			"-",
		],
		{ encoding: "utf8" },
	);
	const marks = [...run.stderr.matchAll(/freeze_(?:start|end): ([\d.]+)/g)].map(
		(m) => Number(m[1]),
	);
	const list = [];
	for (let i = 0; i < marks.length; i += 2)
		list.push([marks[i], marks[i + 1] ?? 1e9]);
	return list;
}

const url = pathToFileURL(join(here, "index.html")).href;
await page.goto(url);
const takes = await page.evaluate(() => Object.keys(window.RANGES));
// timeline.js squeezes the holds while it builds the plan, so the page loads again with them.
await page.addInitScript(
	(h) => {
		window.HOLDS = h;
	},
	Object.fromEntries(takes.map((take) => [take, holds(take)])),
);
await page.goto(url);
const { total, ranges } = await page.evaluate(() => ({
	total: window.TOTAL,
	ranges: window.RANGES,
}));

// Frame NNNN is source second NNNN / 30, the numbering timeline.js reads.
for (const [take, list] of Object.entries(ranges)) {
	const dir = join(work, "frames", take);
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	for (const [start, end] of list) {
		ffmpeg([
			"-ss",
			String(start),
			"-t",
			String(end - start),
			"-i",
			join(root, "artifacts/demos", `${take}.mp4`),
			"-vf",
			"fps=30",
			"-q:v",
			"2",
			"-start_number",
			String(Math.round(start * 30)),
			join(dir, "%04d.jpg"),
		]);
	}
}

const shoot = async (t, path, type) => {
	await page.evaluate((x) => window.setTime(x), t);
	await page.screenshot({
		path,
		type,
		...(type === "jpeg" ? { quality: 95 } : {}),
	});
};

if (only) {
	const stills = join(work, "stills");
	mkdirSync(stills, { recursive: true });
	for (const t of only.split(",").map(Number)) {
		await shoot(t, join(stills, `t${String(t).replace(".", "_")}.png`), "png");
	}
	await browser.close();
	console.log(`stills in ${stills}`);
	process.exit(0);
}

const dir = join(work, "out");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const count = Math.round(total * fps);
const started = Date.now();
for (let i = 0; i < count; i++) {
	await shoot(i / fps, join(dir, `${String(i).padStart(5, "0")}.jpg`), "jpeg");
	if (i % 300 === 0)
		console.log(`${i}/${count} ${((Date.now() - started) / 1000).toFixed(0)}s`);
}
await browser.close();

ffmpeg([
	"-framerate",
	String(fps),
	"-i",
	join(dir, "%05d.jpg"),
	"-c:v",
	"libx264",
	"-preset",
	"slow",
	"-crf",
	"16",
	"-pix_fmt",
	"yuv420p",
	"-movflags",
	"+faststart",
	out,
]);
console.log(`wrote ${out} (${count} frames)`);
