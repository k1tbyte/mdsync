/** Demo: a note edited on two devices, resolved in the three-way merge editor. */

import type { Page } from "playwright-core";

import { CLEAN, sync, write } from "../../tests/e2e/device";
import { check, poll, sleep } from "../../tests/e2e/harness";
import { click, glide } from "./recorder";
import { openAndCompare, rowShown, runDemo } from "./stage";

const NOTE = "Lisbon trip.md";
const BASE = `## Flights
- Out: 14 March, 07:40
- Back: 23 March, 18:15

## Stay
Apartment in Alfama, check-in after 15:00.

## To do
- Book the tram 28 tour
- Buy a Viva Viagem card
- Pack the travel adapter
`;
const ON_PHONE = BASE.replace("18:15", "20:05").replace(
	"- Pack the travel adapter\n",
	"- Pack the travel adapter\n- Reserve dinner at Taberna da Rua das Flores\n",
);
const ON_LAPTOP = BASE.replace("23 March, 18:15", "24 March, 09:30").replace(
	"check-in after 15:00.",
	"check-in after 15:00. Door code 4821.",
);

await runDemo("merge", {
	files: { [NOTE]: BASE },
	prepare: async ({ laptop, phone }) => {
		await write(phone, NOTE, ON_PHONE);
		check("the phone pushes its edit", await sync(phone), CLEAN);
		await write(laptop, NOTE, ON_LAPTOP);
	},
	stage: async (laptop) => {
		await openAndCompare(laptop, NOTE);
		await rowShown(laptop, NOTE);
	},
	scene,
});

async function scene(page: Page): Promise<void> {
	await sleep(800);
	await click(page, ".mdsync-file-row:has-text('Lisbon trip')");
	await page.locator("button.mod-cta:has-text('Merge…')").waitFor();
	await sleep(1200);
	await click(page, "button.mod-cta:has-text('Merge…')");
	await page.locator(".mdsync-merge-panel").waitFor();
	await sleep(1000);
	// Room for the three panes side by side.
	await click(page, ".sidebar-toggle-button.mod-right", 800);
	const dividers = page.locator(".mdsync-divider-canvas");
	await poll("side-by-side panes", async () =>
		(await dividers.count()) === 2 ? true : undefined,
	);
	await sleep(600);

	// An open conflict is settled from its head in Result; the strips only take a side.
	const settle = ".mdsync-merge-panel [aria-label='Take remote']";
	await page.locator(settle).waitFor();
	await sleep(1000);
	await click(page, settle, 900);
	await sleep(1800);
	const save = ".mdsync-diff-resolution button:has-text('Save and push')";
	await glide(page, save, 900);
	await sleep(500);
	await click(page, save, 100);
	await page.locator(".mdsync-merge-panel").waitFor({ state: "detached" });
	await sleep(1000);
}
