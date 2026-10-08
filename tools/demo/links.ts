/** Demo: a note is shared as a link, read in a browser, then stopped from Manage share links. */

import { type Browser, chromium, type Page } from "playwright-core";

import { loaded } from "../../tests/e2e/device";
import { runScenario, sleep } from "../../tests/e2e/harness";
import { SECRET } from "../../tests/e2e/link-client";
import { launchObsidian } from "../../tests/e2e/obsidian";
import { startRelay } from "../../tests/e2e/relay";
import { installCursor } from "./cursor";
import {
	attachPage,
	click,
	encode,
	frameWindow,
	glide,
	pickMenuItem,
	record,
	SOLO,
	sequence,
} from "./recorder";
import { runCommand } from "./stage";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

const OBSIDIAN_PORT = 9223;
const RELAY_PORT = 8801;
const OUT_DIR = "artifacts/demos";
const NOTE = "Lisbon trip.md";
const MODAL = ".mdsync-link-modal";
const WHEEL_STEP = 60;
const FILES = {
	[NOTE]: `![[lisbon.jpg]]

Four days in **May**, no rush: walk the hills, ride the old tram and eat pastéis de nata until it stops being a joke.

> [!tip] Pack light
> Only a carry-on. The streets are steep and cobbled, and you will want a free hand for coffee.

## Plan

| Day | Morning | Evening |
| --- | --- | --- |
| Thu | Alfama and the cathedral | Fado in a small bar |
| Fri | Belém: tower and monastery | Sunset at Miradouro da Graça |
| Sat | Sintra by train | Dinner by the river |
| Sun | Time Out Market | Flight home |

## Before we go

- [x] Book the flights
- [x] Hotel in Alfama
- [ ] Reserve a table for Saturday
- [ ] Download the offline map

## Budget

The whole trip split over the four days:

$$
\\text{per day} = \\frac{\\text{flights} + \\text{hotel} + \\text{food}}{4}
$$

## Food

Order **pastéis de nata** warm, with cinnamon. Have a *bifana* at lunch and keep the evening for grilled sardines.
`,
	"Ideas.md":
		"- A reading nook by the window\n- Learn to make pastéis de nata\n",
	"Projects/Website redesign.md":
		"- [x] New colour palette\n- [ ] Rewrite the about page\n",
	"Projects/Reading list.md": "- The Book of Disquiet\n- Blindness\n",
	"Daily/2026-10-01.md": "Called the landlord about the boiler.\n",
	".obsidian/appearance.json": JSON.stringify({ theme: "obsidian" }),
};

await runScenario("links demo", async () => {
	const relay = await startRelay(RELAY_PORT, SECRET);
	process.env.E2E_VISIBLE = "1";
	const device = await launchObsidian({
		port: OBSIDIAN_PORT,
		settings: {
			realtimeSync: false,
			cachePassphrase: false,
			relayUrl: relay.url,
			relaySecret: SECRET,
		},
		files: FILES,
	});
	const browser = await chromium.launch({ headless: true });
	try {
		await loaded(device);
		await device.evaluate(drawBanner);
		await device.evaluate(async (path) => {
			app.workspace.rightSplit.collapse();
			app.workspace.leftSplit.expand();
			await app.workspace
				.getLeaf(false)
				.openFile(app.vault.getFileByPath(path), {
					state: { mode: "preview" },
				});
		}, NOTE);
		const page = await attachPage(OBSIDIAN_PORT);
		await frameWindow(page);
		const web = await newTab(browser);

		const take = async () => {
			// Toasts from startup (no storage backend is set) are not part of the story.
			await page.evaluate(() => {
				for (const notice of document.querySelectorAll(".notice")) {
					notice.remove();
				}
			});
			await sleep(800);
			const making = await record(page);
			const { link, passphrase } = await createLink(page);
			const created = await making.stop();

			await web.goto(link);
			await web.locator("#passphrase").waitFor();
			await installCursor(web);
			const reading = await record(web);
			await readNote(web, passphrase);
			const read = await reading.stop();

			const stopping = await record(page);
			await stopSharing(page);
			const stopped = await stopping.stop();

			// A reload would be served from the first tab's cache: the next reader is a new tab.
			const next = await newTab(browser);
			await next.goto(link);
			await next.locator("h1", { hasText: "no longer available" }).waitFor();
			await installCursor(next);
			const gone = await record(next);
			await sleep(2000);
			const missing = await gone.stop();

			console.log(
				`wrote ${encode("links", sequence(created, read, stopped, missing))}`,
			);
		};
		await take().catch(async (error: unknown) => {
			await page.screenshot({ path: `${OUT_DIR}/links-failed-obsidian.png` });
			await web.screenshot({ path: `${OUT_DIR}/links-failed-browser.png` });
			throw error;
		});
	} finally {
		await browser.close();
		await device.stop();
		relay.stop();
	}
});

/** A reader's browser, the size of the Obsidian window. */
async function newTab(browser: Browser): Promise<Page> {
	const context = await browser.newContext({
		viewport: { width: SOLO.width, height: SOLO.height },
		deviceScaleFactor: 1.5,
		colorScheme: "dark",
		// The drawn cursor is an injected stylesheet, which the viewer's own policy refuses.
		bypassCSP: true,
		permissions: ["clipboard-read", "clipboard-write"],
	});
	return context.newPage();
}

/** A sunset over rooftops, drawn in the renderer so the vault has a picture without shipping one. */
async function drawBanner(): Promise<void> {
	const width = 1400;
	const height = 460;
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const g = canvas.getContext("2d");
	if (!g) throw new Error("no canvas");
	const sky = g.createLinearGradient(0, 0, 0, height);
	sky.addColorStop(0, "#1f2f66");
	sky.addColorStop(0.5, "#d9667a");
	sky.addColorStop(0.8, "#f6a35f");
	sky.addColorStop(1, "#fbd48a");
	g.fillStyle = sky;
	g.fillRect(0, 0, width, height);
	const glow = g.createRadialGradient(980, 300, 10, 980, 300, 260);
	glow.addColorStop(0, "rgba(255, 244, 200, 0.95)");
	glow.addColorStop(0.25, "rgba(255, 214, 140, 0.45)");
	glow.addColorStop(1, "rgba(255, 190, 120, 0)");
	g.fillStyle = glow;
	g.fillRect(0, 0, width, height);
	g.fillStyle = "#fff4c8";
	g.beginPath();
	g.arc(980, 300, 52, 0, Math.PI * 2);
	g.fill();
	const hill = (base: number, amp: number, wave: number, color: string) => {
		g.fillStyle = color;
		g.beginPath();
		g.moveTo(0, height);
		for (let x = 0; x <= width; x += 8) {
			g.lineTo(x, base + Math.sin(x / wave) * amp + Math.sin(x / 37) * 4);
		}
		g.lineTo(width, height);
		g.fill();
	};
	hill(330, 26, 140, "#9c5675");
	hill(372, 30, 110, "#6a3b66");
	g.fillStyle = "#3d2347";
	for (let x = 0; x < width; x += 34) {
		const roof = 60 + ((x * 7) % 45);
		g.fillRect(x, height - roof - 20, 30, roof + 20);
		g.beginPath();
		g.moveTo(x - 2, height - roof - 20);
		g.lineTo(x + 15, height - roof - 36);
		g.lineTo(x + 32, height - roof - 20);
		g.fill();
	}
	g.fillStyle = "rgba(255, 214, 140, 0.8)";
	for (let x = 8; x < width; x += 34) {
		for (let row = 0; row < 3; row++) {
			if ((x * (row + 3)) % 5 < 2) g.fillRect(x, height - 36 - row * 22, 6, 9);
		}
	}
	hill(430, 14, 90, "#1d1226");
	const blob = await new Promise<Blob | null>((done) =>
		canvas.toBlob(done, "image/jpeg", 0.92),
	);
	if (!blob) throw new Error("no image");
	await app.vault.createFolder("Attachments");
	await app.vault.createBinary(
		"Attachments/lisbon.jpg",
		await blob.arrayBuffer(),
	);
}

/** The note's menu, the form, a generated passphrase, and the link made; hands back what the reader needs. */
async function createLink(
	page: Page,
): Promise<{ link: string; passphrase: string }> {
	await pickMenuItem(
		page,
		`.nav-file-title[data-path='${NOTE}']`,
		"MDSync: Share link",
		"right",
	);
	await page.locator(`${MODAL} .mdsync-link-preview details`).waitFor();
	await sleep(1000);
	// Obsidian keeps a hidden twin of each dropdown to measure it.
	const views = setting(page, "Views").locator("select:not(.is-measuring)");
	await glide(page, views, 600);
	await views.selectOption("5");
	await sleep(600);
	await click(page, `${MODAL} button:has-text('Generate')`, 600);
	await sleep(900);
	await click(page, `${MODAL} button:has-text('Create link')`, 600);
	await page
		.locator(`${MODAL} .modal-title:has-text('Link created')`)
		.waitFor();
	await sleep(800);
	const link = await setting(page, "Link").locator("input").inputValue();
	const passphrase = await setting(page, "Passphrase")
		.locator("input")
		.inputValue();
	await click(page, setting(page, "Link").locator(".clickable-icon"), 600);
	await sleep(1200);
	await click(page, `${MODAL} button:has-text('Done')`, 600);
	const badge = page.locator(
		`.nav-file-title[data-path='${NOTE}'] .mdsync-published-badge`,
	);
	await badge.waitFor();
	await glide(page, badge, 700);
	await sleep(1300);
	return { link, passphrase };
}

/** The reader: the passphrase, the note, its Markdown copied, wide text, and a read down the page. */
async function readNote(web: Page, passphrase: string): Promise<void> {
	await sleep(600);
	await click(web, "#passphrase", 600);
	await web.keyboard.type(passphrase, { delay: 60 });
	await sleep(400);
	await click(web, "button[type=submit]", 500);
	await web.locator(".markdown-rendered").waitFor();
	await sleep(1400);
	await click(web, ".copy-markdown", 700);
	await sleep(1100);
	await click(web, ".wide-toggle", 600);
	await sleep(1400);
	await scroll(web, 600);
	await click(web, ".outline-item >> text=Food", 700);
	await sleep(1400);
}

/** Wheel scrolling in small steps, so the page glides. */
async function scroll(web: Page, distance: number): Promise<void> {
	for (let moved = 0; moved < distance; moved += WHEEL_STEP) {
		await web.mouse.wheel(0, WHEEL_STEP);
		await sleep(30);
	}
	await sleep(700);
}

/** Manage share links from the palette: the views left, then the link stopped. */
async function stopSharing(page: Page): Promise<void> {
	await runCommand(page, "Manage share links");
	await page
		.locator(`${MODAL} .setting-item-description:has-text('views left')`)
		.waitFor();
	await sleep(1500);
	await click(page, `${MODAL} [aria-label='Stop sharing']`, 600);
	await page.locator(".modal button:has-text('Stop sharing')").last().waitFor();
	await sleep(700);
	await click(
		page,
		page.locator(".modal button:has-text('Stop sharing')").last(),
	);
	await page.locator(`${MODAL} :text('No links yet')`).waitFor();
	await sleep(900);
	await page.keyboard.press("Escape");
	await page
		.locator(`.nav-file-title[data-path='${NOTE}'] .mdsync-published-badge`)
		.waitFor({ state: "detached" });
	await sleep(1000);
}

function setting(page: Page, name: string) {
	return page.locator(`${MODAL} .setting-item`).filter({
		has: page.locator(".setting-item-name", {
			hasText: new RegExp(`^${name}$`),
		}),
	});
}
