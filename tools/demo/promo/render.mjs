// Renders index.html frame by frame and encodes it: node tools/demo/promo/render.mjs <out.mp4> [fps=30] [seconds]
// With a comma list of seconds (`render.mjs - 30 4,12.5`) it writes stills to artifacts/promo/stills instead.
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const work = join(here, "../../../artifacts/promo");
const require = createRequire(join(here, "../../../package.json"));
const { chromium } = require("playwright-core");

const [out, fpsArg = "30", only] = process.argv.slice(2);
const fps = Number(fpsArg);

const browser = await chromium.launch({
	// `CHROME` points at a browser Playwright did not download; --no-sandbox because containers run as root.
	executablePath: process.env.CHROME,
	args: ["--no-sandbox", "--allow-file-access-from-files"],
});
const page = await browser.newPage({
	viewport: { width: 1920, height: 1080 },
	deviceScaleFactor: 1,
});
await page.goto(`file://${join(here, "index.html")}`);
await page.evaluate(() => document.fonts.ready);
const total = await page.evaluate(() => window.TOTAL);

if (only) {
	const stills = join(work, "stills");
	mkdirSync(stills, { recursive: true });
	for (const t of only.split(",").map(Number)) {
		await page.evaluate((x) => window.setTime(x), t);
		await page.screenshot({
			path: join(stills, `t${String(t).replace(".", "_")}.png`),
		});
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
	await page.evaluate((t) => window.setTime(t), i / fps);
	await page.screenshot({
		path: join(dir, `${String(i).padStart(5, "0")}.jpg`),
		type: "jpeg",
		quality: 95,
	});
	if (i % 60 === 0) {
		console.log(`${i}/${count} ${((Date.now() - started) / 1000).toFixed(0)}s`);
	}
}
await browser.close();

const run = spawnSync(
	"ffmpeg",
	[
		"-y",
		"-framerate",
		String(fps),
		"-i",
		join(dir, "%05d.jpg"),
		"-c:v",
		"libx264",
		"-preset",
		"slow",
		"-crf",
		"17",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		"-r",
		String(fps),
		out,
	],
	{ stdio: "inherit" },
);
if (run.status !== 0) throw new Error("ffmpeg failed");
console.log(`wrote ${out} (${count} frames)`);
