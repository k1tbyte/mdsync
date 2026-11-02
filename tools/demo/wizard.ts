/** Demo: a fresh install sets itself up through the wizard, free: R2 storage, a relay deployed to Cloudflare, the first sync. */

import type { Page } from "playwright-core";

import { loaded } from "../../tests/e2e/device";
import { runScenario, sleep } from "../../tests/e2e/harness";
import { launchObsidian } from "../../tests/e2e/obsidian";
import { startS3 } from "../../tests/e2e/s3";
import { fakeCloudflare, routeRequests } from "./fake-cloudflare";
import { attachPage, click, encode, frameWindow, record } from "./recorder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

/** The wizard fills most of a small window, which then films at full width. */
const WINDOW = { width: 960, height: 700, x: 40, y: 40, scale: 2 };
const PORT = 9223;
const S3_PORT = 8802;
const OUT_DIR = "artifacts/demos";
const PASSPHRASE = "lantern-orbit-velvet-meadow";
/** Not a real token: the stand-in for Cloudflare accepts any. */
const TOKEN = "cfat_Zk3pQx9LmT7vR2nB8wYc4HdA1sUeJ6oF0gXiN5tV";
const TYPING = { delay: 28 };

const NOTES = {
	"Ideas.md":
		"- A reading nook by the window\n- Learn to make pastéis de nata\n",
	"Projects/Website redesign.md":
		"- [x] New colour palette\n- [ ] Rewrite the about page\n",
	"Projects/Garden plan.md": "Tomatoes along the south wall.\n",
	"Projects/Reading list.md": "- The Book of Disquiet\n- Blindness\n",
	"Reading/Blindness.md": "Notes on chapters 1 to 9.\n",
	"Reading/The Book of Disquiet.md": "Fragments worth rereading.\n",
	"Recipes/Pastéis de nata.md": "Custard, cinnamon, very hot oven.\n",
	"Recipes/Shakshuka.md": "Eggs, peppers, cumin.\n",
	"Travel/Lisbon trip.md": "Flights, the hostel, a day in Sintra.\n",
	"Travel/Packing list.md": "- Passport\n- Charger\n",
	".obsidian/appearance.json": JSON.stringify({ theme: "obsidian" }),
	...Object.fromEntries(
		Array.from({ length: 12 }, (_, day) => [
			`Daily/2026-10-${String(day + 1).padStart(2, "0")}.md`,
			`Notes from day ${day + 1}.\n`,
		]),
	),
};

/** The wizard's button or choice card with this label. */
const button = (label: string) => `.modal button:has-text("${label}")`;

await runScenario("wizard demo", async () => {
	const s3 = await startS3(S3_PORT);
	process.env.E2E_VISIBLE = "1";
	const obsidian = await launchObsidian({
		port: PORT,
		settings: null,
		files: NOTES,
	});
	try {
		await loaded(obsidian);
		routeRequests(obsidian.vault);
		await obsidian.evaluate(async () => {
			await app.plugins.disablePlugin("mdsync");
			await app.plugins.enablePlugin("mdsync");
		});
		await loaded(obsidian);
		const page = await attachPage(PORT);
		await frameWindow(page, WINDOW);
		await fakeCloudflare(page, s3);
		// A reload keeps the settings the first start saved, so the wizard no longer opens on its own.
		await obsidian.evaluate(() => app.plugins.plugins.mdsync.openSetup());
		await page.locator(button("Start syncing this vault")).waitFor();
		if (process.env.DEMO_HOLD) {
			console.log("holding, stop the process to close Obsidian");
			await new Promise(() => {});
		}

		const take = async () => {
			await sleep(1500);
			await page.screenshot({ path: `${OUT_DIR}/wizard-start.png` });
			const recording = await record(page);
			await scene(page);
			console.log(`wrote ${encode("wizard", await recording.stop())}`);
			await page.screenshot({ path: `${OUT_DIR}/wizard-end.png` });
		};
		await take().catch(async (error: unknown) => {
			await page.screenshot({ path: `${OUT_DIR}/wizard-failed.png` });
			throw error;
		});
	} finally {
		s3.stop();
		await obsidian.stop();
	}
});

async function scene(page: Page): Promise<void> {
	await sleep(1200);
	await click(page, button("Start syncing this vault"));
	await page.locator(button("Cloudflare R2")).waitFor();
	await sleep(1600);

	// R2 storage from one token.
	await click(page, button("Cloudflare R2"));
	const token = page.locator("input[aria-label='Cloudflare token']");
	await token.waitFor();
	await sleep(1200);
	await click(page, token);
	await page.keyboard.type(TOKEN, TYPING);
	await sleep(500);
	await click(page, `.modal button:text-is("Connect")`);

	await field(page, "Passphrase").waitFor({ timeout: 60_000 });
	await sleep(900);
	await click(page, field(page, "Passphrase"));
	await page.keyboard.type(PASSPHRASE, { delay: 40 });
	await click(page, field(page, "Confirm passphrase"));
	await page.keyboard.type(PASSPHRASE, { delay: 15 });
	await sleep(700);
	await click(page, button("Set passphrase"));

	await page.locator(`.modal button:text-is("Next")`).waitFor();
	await sleep(1400);
	await click(page, `.modal button:text-is("Next")`);

	// The relay: one card, and the checklist runs by itself.
	await page.locator(button("Deploy to my Cloudflare")).waitFor();
	await sleep(1800);
	await click(page, button("Deploy to my Cloudflare"));
	await page.locator(".mdsync-progress").waitFor();
	await page
		.locator(".mdsync-progress-step.is-done")
		.nth(4)
		.waitFor({ timeout: 90_000 });
	await sleep(1500);

	// The first sync is previewed before anything moves.
	const sync = page.locator(".modal button", { hasText: /^Sync \d+ files?$/ });
	await sync.waitFor({ timeout: 120_000 });
	await sleep(3000);
	await click(page, sync);
	await page.locator(button("Done")).waitFor({ timeout: 90_000 });
	await sleep(2500);
}

/** The text field of the wizard's setting named `name`. */
function field(page: Page, name: string) {
	return page
		.locator(`.modal .setting-item:has(.setting-item-name:text-is("${name}"))`)
		.locator("input")
		.first();
}
