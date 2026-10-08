/**
 * Sharing a note by link in a real Obsidian against a real relay, then opening it in a real browser: the plugin's
 * rendering and clean-up, the passphrase, the view count, an update and a stop. Run `pnpm build` first.
 */

import { type Browser, chromium, type Page } from "playwright-core";

import { clickMenuItem, confirm, field, fill, loaded, press } from "./device";
import { check, poll, runScenario } from "./harness";
import { admin, SECRET } from "./link-client";
import { launchObsidian, type Obsidian } from "./obsidian";
import { startRelay } from "./relay";

// biome-ignore lint/suspicious/noExplicitAny: Obsidian's renderer app is untyped here.
declare const app: any;
declare const activeDocument: Document;

const OBSIDIAN_PORT = 9246;
const RELAY_PORT = 8799;
const PASSPHRASE = "correct horse battery";
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const NOTE = `---
password: hunter2
---
# Trip

Landing in **May** with [[Other]] and [a map](https://example.com/map). A tag #travel.

Inline math $E=mc^2$ and block:

$$
\\int_0^1 x^2 dx = \\frac{1}{3}
$$

> [!tip] Pack light
> Only a carry-on.

- [x] Book hotel

![[Other]]

![[pic.png]]

%%private comment%%

## Days

### Lisbon

\`\`\`ts
const days = 3;
\`\`\`
`;

await runScenario("links in obsidian e2e", async () => {
	const relay = await startRelay(RELAY_PORT, SECRET);
	const device = await launchObsidian({
		port: OBSIDIAN_PORT,
		settings: {
			realtimeSync: false,
			cachePassphrase: false,
			relayUrl: relay.url,
			relaySecret: SECRET,
		},
		files: { "Trip.md": NOTE, "Other.md": "Other note body, private.\n" },
	});
	const browser = await chromium.launch({ headless: true });
	try {
		await loaded(device);
		await device.evaluate(async (base64) => {
			const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
			await app.vault.createBinary("pic.png", bytes.buffer);
		}, PNG);
		const link = await create(device);
		await recipient(browser, link, relay.url);
		await manage(device, browser, link);
	} finally {
		await browser.close();
		await device.stop();
		relay.stop();
	}
});

async function create(device: Obsidian): Promise<string> {
	await clickMenuItem(device, "Trip.md", "MDSync: Share link");
	await device.waitFor(
		"the preview",
		() => activeDocument.querySelector(".mdsync-link-modal")?.textContent ?? "",
		(text) => text.includes("Left out of the link"),
	);
	const left = await device.evaluate(
		() =>
			[...activeDocument.querySelectorAll(".mdsync-link-modal p")]
				.map((p) => p.textContent)
				.find((text) => text?.startsWith("Left out")) ?? "",
	);
	check(
		"the preview says what is left out",
		left,
		"Left out of the link: 1 embedded file.",
	);
	check(
		"the preview shows what goes out, in a sandbox",
		await device.evaluate(() => {
			const frame = activeDocument.querySelector(".mdsync-link-preview iframe");
			const page = frame?.getAttribute("srcdoc") ?? "";
			return [
				frame?.getAttribute("sandbox"),
				page.includes("Landing in"),
				page.includes("hunter2"),
			];
		}),
		["", true, false],
	);
	await choose(device, "Expires", "date");
	check(
		"a picked date and time, two hours ahead, is taken",
		await device.evaluate(() => {
			const input = activeDocument.querySelector(
				'.modal input[type="datetime-local"]',
			) as HTMLInputElement;
			const when = new Date(Date.now() + 2 * 3600_000);
			const local = new Date(
				when.getTime() - when.getTimezoneOffset() * 60_000,
			);
			input.value = local.toISOString().slice(0, 16);
			input.dispatchEvent(new Event("input"));
			const row = input.closest(".setting-item");
			return [
				input.offsetParent !== null,
				row
					?.querySelector(".setting-item-description")
					?.textContent?.startsWith("Expires "),
			];
		}),
		[true, true],
	);
	await choose(device, "Views", "5");
	await fill(device, "Passphrase", PASSPHRASE);
	await press(device, "Create link");
	const link = await field(device, "Link");
	check(
		"the passphrase is shown once beside the link",
		[
			await field(device, "Passphrase"),
			link.startsWith(`http://127.0.0.1:${RELAY_PORT}/s/`) &&
				link.includes("#"),
		],
		[PASSPHRASE, true],
	);
	await device.evaluate(() => {
		for (const button of activeDocument.querySelectorAll(".modal button")) {
			if (button.textContent === "Done") (button as HTMLElement).click();
		}
	});
	check(
		"the plugin keeps the link but not the passphrase",
		await device.evaluate(() => {
			const { links } = app.plugins.plugins.mdsync.settings;
			const text = JSON.stringify(links);
			return [links.length, text.includes("correct horse")];
		}),
		[1, false],
	);
	return link;
}

async function recipient(
	browser: Browser,
	link: string,
	base: string,
): Promise<void> {
	const page = await open(browser, link);
	check(
		"the link asks for the passphrase",
		await page.locator("#passphrase").count(),
		1,
	);
	await page.locator("#passphrase").fill(PASSPHRASE);
	await page.locator("button[type=submit]").click();
	await page.locator(".markdown-rendered").waitFor();
	const note = page.locator(".markdown-rendered");
	const text = (await note.textContent()) ?? "";
	check(
		"a note opening with its name shows the name once",
		await page.locator("h1", { hasText: "Trip" }).count(),
		1,
	);
	check(
		"it keeps the formatting",
		await note.locator("strong").first().textContent(),
		"May",
	);
	check(
		"web links stay, links to other notes become text",
		[
			await note.locator('a[href="https://example.com/map"]').count(),
			await note.locator("a").count(),
			text.includes("Other"),
		],
		[1, 1, true],
	);
	check(
		"properties, comments and embedded notes stay out",
		[
			text.includes("hunter2"),
			text.includes("password"),
			text.includes("private comment"),
			text.includes("Other note body"),
		],
		[false, false, false, false],
	);
	check(
		"math is MathML",
		[
			await note.locator("math").count(),
			await note.locator('math[display="block"]').count(),
			await note.locator("mjx-container").count(),
		],
		[2, 1, 0],
	);
	check(
		"a block formula needs no scrollbar",
		await note.locator('math[display="block"]').evaluate((math) => ({
			wider: math.scrollWidth > math.clientWidth,
			taller: math.scrollHeight > math.clientHeight,
		})),
		{ wider: false, taller: false },
	);
	check(
		"the callout, the task and the image come along",
		[
			await note.locator('.callout[data-callout="tip"]').count(),
			await note.locator(".callout-title-inner").first().textContent(),
			await note.locator("input[type=checkbox][disabled]").count(),
			await note.locator('img[src^="data:image/png"]').count(),
		],
		[1, "Pack light", 1, 1],
	);
	check(
		"the outline lists the headings, code blocks copy",
		[
			await page.locator(".outline-item").allTextContents(),
			await page.locator("pre .copy-code-button").count(),
		],
		[["Trip", "Days", "Lisbon"], 1],
	);
	check(
		"it tells how many views and how long are left",
		[
			await page.locator(".link-views").textContent(),
			await page.locator(".link-expiry").textContent(),
		],
		["This link can be opened 4 more times.", "Expires in 2 hours."],
	);
	check("the relay counted the view", await views(base, link), 1);
	if (process.env.E2E_SHOTS) {
		await page.screenshot({
			path: "artifacts/e2e-shots/link-viewer.png",
			fullPage: true,
		});
	}
	await page.context().close();
}

async function manage(
	device: Obsidian,
	browser: Browser,
	link: string,
): Promise<void> {
	await device.evaluate(() =>
		app.workspace.getLeaf().openFile(app.vault.getFileByPath("Trip.md")),
	);
	check(
		"a shared note is marked in the tree and in its header",
		await marks(device, "fresh"),
		["fresh", "fresh"],
	);
	await device.evaluate(() =>
		app.vault.modify(
			app.vault.getFileByPath("Trip.md"),
			"# Trip\n\nChanged after sharing.\n",
		),
	);
	check(
		"an edit after sharing marks the link outdated",
		await marks(device, "stale"),
		["stale", "stale"],
	);
	check(
		"the command to update this note's links is offered",
		await device.evaluate(() =>
			app.commands.findCommand("mdsync:update-note-links")?.checkCallback(true),
		),
		true,
	);

	await device.evaluate(() =>
		(
			document.querySelector(
				'[data-path="Trip.md"] .mdsync-published-badge',
			) as HTMLElement
		).click(),
	);
	const status = await device.waitFor(
		"the link's status",
		() =>
			activeDocument.querySelector(
				".mdsync-link-modal .setting-item-description",
			)?.textContent ?? "",
		(text) => text.includes("views left"),
	);
	check(
		"the badge opens this note's links, saying which changed",
		[
			status.startsWith("Changed since it was shared."),
			status.includes("4 of 5 views left"),
		],
		[true, true],
	);

	await press(device, "Update");
	await promptFor(device, PASSPHRASE);
	await device.waitFor(
		"the update to finish",
		() =>
			activeDocument.querySelector(
				".mdsync-link-modal .setting-item-description",
			)?.textContent ?? "",
		(text) => text.includes("views left") && !text.startsWith("Changed"),
	);
	check("an update clears the outdated marks", await marks(device, "fresh"), [
		"fresh",
		"fresh",
	]);
	const page = await open(browser, link);
	await page.locator("#passphrase").fill(PASSPHRASE);
	await page.locator("button[type=submit]").click();
	await page.locator(".markdown-rendered").waitFor();
	check(
		"an update shows the note as it is now and keeps the views spent",
		[
			(await page.locator(".markdown-rendered").textContent())?.includes(
				"Changed after sharing.",
			),
			await page.locator(".link-views").textContent(),
		],
		[true, "This link can be opened 3 more times."],
	);
	await page.context().close();

	await device.evaluate(() => {
		const stop = activeDocument.querySelector(
			'.mdsync-link-modal [aria-label="Stop sharing"]',
		);
		(stop as HTMLElement).click();
	});
	await confirm(device, "Stop sharing");
	const gone = await open(browser, link, "h1");
	check(
		"a stopped link is gone",
		await gone.locator("h1").textContent(),
		"This link is no longer available",
	);
	await gone.context().close();
	check(
		"and leaves the list",
		await device.evaluate(
			() => app.plugins.plugins.mdsync.settings.links.length,
		),
		0,
	);
}

/** Trip.md's tree badge and header button, each "fresh", "stale" or "none", once both read `want`. */
function marks(device: Obsidian, want: string): Promise<string[]> {
	return device.waitFor(
		`the shared-note marks to read ${want}`,
		() =>
			[
				'[data-path="Trip.md"] .mdsync-published-badge',
				".workspace-leaf.mod-active .mdsync-published-action",
			].map((selector) => {
				const mark = document.querySelector(selector);
				if (!mark) return "none";
				return mark.classList.contains("is-stale") ? "stale" : "fresh";
			}),
		(seen) => seen.every((mark) => mark === want),
	);
}

async function open(
	browser: Browser,
	link: string,
	ready = "#passphrase",
): Promise<Page> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(link);
	await page.locator(ready).waitFor();
	return page;
}

async function views(base: string, link: string): Promise<number> {
	const id = new URL(link).pathname.split("/").pop();
	const status = await admin(base, `/link/${id}/status`);
	return ((await status.json()) as { views: number }).views;
}

/** Picks `value` in the open modal's dropdown named `name`. */
function choose(device: Obsidian, name: string, value: string): Promise<void> {
	return device.evaluate(
		({ label, wanted }) => {
			const select = [
				...activeDocument.querySelectorAll(".modal .setting-item"),
			]
				.find(
					(row) =>
						row.querySelector(".setting-item-name")?.textContent === label,
				)
				?.querySelector("select");
			if (!select) throw new Error(`no "${label}" dropdown`);
			select.value = wanted;
			select.dispatchEvent(new Event("change"));
		},
		{ label: name, wanted: value },
	);
}

/** Answers the prompt modal, whose field is not a setting. */
async function promptFor(device: Obsidian, text: string): Promise<void> {
	await poll("the prompt", () =>
		device.evaluate(() =>
			activeDocument.querySelector(".mdsync-prompt-input") ? true : undefined,
		),
	);
	await device.evaluate((value) => {
		const input = activeDocument.querySelector(
			".mdsync-prompt-input",
		) as HTMLInputElement;
		input.value = value;
		input.dispatchEvent(new Event("input"));
	}, text);
	await press(device, "Update");
}
