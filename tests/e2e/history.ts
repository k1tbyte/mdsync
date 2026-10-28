/**
 * The reworked file history in a real Obsidian: pushes from one device on an in-memory S3, one pinned,
 * then the Timeline tab (activity calendar, age groups, session cards, filter, day chip) and the setting
 * that hides the calendar.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { chromium, type Page } from "playwright-core";

import { CLEAN, loaded, openSettings, sync, unlock } from "./device";
import { check, poll, runScenario, sleep } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { startS3 } from "./s3";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
declare const activeDocument: Document;

const CDP_PORT = 9250;
const S3_PORT = 8850;
const PASSPHRASE = "e2e-passphrase";
const PUSH_GAP_MS = 2500;
const BRIEF = "Projects/Alpha/Brief.md";
const DAILY = "Daily/2026-10-28.md";
const DRAFT = "Inbox/Draft.md";
const ROADMAP = "Roadmap.md";
const PIN_LABEL = "Release 1.4";
const SHOTS_DIR = process.env.E2E_SHOTS_DIR ?? "temp/e2e-shots";
/** Sidebar width the shots are taken at. */
const SIDEBAR_PX = 400;
const CARD = ".mdsync-timeline-card";
const FILTER = ".mdsync-timeline-filter input";

await runScenario("history e2e", async () => {
	const s3 = await startS3(S3_PORT);
	let device: Obsidian | undefined;
	let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
	try {
		device = await launchObsidian({
			port: CDP_PORT,
			settings: {
				storageConfigs: {
					s3: {
						kind: "s3",
						endpoint: s3.url,
						region: "auto",
						bucket: s3.bucket,
						prefix: "vault",
						accessKeyId: "e2e",
						secretAccessKey: "e2e",
						forcePathStyle: true,
						concurrency: 4,
					},
				},
				activeStorageKind: "s3",
			},
		});
		await loaded(device);
		await device.evaluate(async () => {
			const plugin = app.plugins.plugins.mdsync;
			plugin.settings.fileHistoryEnabled = true;
			plugin.settings.fileHistoryActivity = true;
			await plugin.saveSettings();
		});
		await unlock(device, PASSPHRASE);
		check("the first sync is clean", await sync(device), CLEAN);

		browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
		const page = await poll("the main window", async () => {
			for (const candidate of browser?.contexts().flatMap((c) => c.pages()) ??
				[]) {
				if ((await candidate.locator(".workspace").count()) > 0)
					return candidate;
			}
			return undefined;
		});
		await page.setViewportSize({ width: 1280, height: 860 });

		await pushes(device);
		await pin(device);
		await openTimeline(device, page);
		await checkOverview(device, page);
		await checkExpanded(device, page);
		await checkFilter(device, page);
		await checkDayChip(device, page);
		await checkFileHistory(device, page);
		await checkDeleted(device, page);
		await checkActivitySetting(device, browser);
		await checkHolds(device, browser);
		await checkDashboard(device, browser);
	} finally {
		s3.stop();
		await browser?.close().catch(() => undefined);
		await device?.stop();
	}
});

/** Six pushes, a few seconds apart: two adds and an edit, a second edit, a file that comes and goes, an edit. */
async function pushes(device: Obsidian): Promise<void> {
	await create(device, BRIEF, "# Alpha brief\n\nv1\n");
	await create(device, DAILY, "# 2026-10-28\n\n- standup\n");
	await create(device, ROADMAP, "# Roadmap\n\n- Q4\n");
	check("push 1: three files added", await pushed(device), CLEAN);
	await write(device, BRIEF, "# Alpha brief\n\nv2, scope agreed\n");
	check("push 2: brief edited", await pushed(device), CLEAN);
	await write(device, BRIEF, "# Alpha brief\n\nv3, scope agreed\n\nBudget.\n");
	check("push 3: brief edited again", await pushed(device), CLEAN);
	await create(device, DRAFT, "draft\n");
	check("push 4: draft added", await pushed(device), CLEAN);
	await device.evaluate(
		(path) => app.vault.delete(app.vault.getFileByPath(path)),
		DRAFT,
	);
	check("push 5: draft deleted", await pushed(device), CLEAN);
	await write(device, ROADMAP, "# Roadmap\n\n- Q4\n- Q1\n");
	check("push 6: roadmap edited", await pushed(device), CLEAN);
}

async function pushed(
	device: Obsidian,
): Promise<Awaited<ReturnType<typeof sync>>> {
	const result = await sync(device);
	await sleep(PUSH_GAP_MS);
	return result;
}

function create(device: Obsidian, path: string, text: string): Promise<void> {
	return device.evaluate(
		async ({ target, content }) => {
			const folder = target.split("/").slice(0, -1).join("/");
			if (folder && !app.vault.getFolderByPath(folder)) {
				await app.vault.createFolder(folder);
			}
			await app.vault.create(target, content);
		},
		{ target: path, content: text },
	);
}

function write(device: Obsidian, path: string, text: string): Promise<void> {
	return device.evaluate(
		([target, content]) =>
			app.vault.modify(app.vault.getFileByPath(target), content),
		[path, text],
	);
}

/** Pins the push that made the second edit of the brief: older than the newest ones, so it splits the sessions. */
async function pin(device: Obsidian): Promise<void> {
	const listed = await poll("the pushes in history", async () => {
		const rows = await device.evaluate(async () => {
			const { snapshots } =
				await app.plugins.plugins.mdsync.controller.history.listSnapshots();
			return snapshots.map(
				(row: { id: string; pushes: number; pinned: boolean }) => ({
					id: row.id,
					pushes: row.pushes,
					pinned: row.pinned,
				}),
			);
		});
		return rows.length >= 4 ? rows : undefined;
	});
	console.log(`snapshots, newest first: ${JSON.stringify(listed)}`);
	const target = listed[3];
	if (!target) throw new Error("no fourth snapshot to pin");
	await device.evaluate(
		([id, label]) =>
			app.plugins.plugins.mdsync.controller.history.setSnapshotPinned(
				id,
				true,
				label,
			),
		[target.id, PIN_LABEL],
	);
	check(
		"the pin is listed",
		await device.evaluate(async () => {
			const { snapshots } =
				await app.plugins.plugins.mdsync.controller.history.listSnapshots();
			return snapshots
				.filter((row: { pinned: boolean }) => row.pinned)
				.map((row: { label?: string }) => row.label);
		}),
		[PIN_LABEL],
	);
}

/** The source control view in the right sidebar at `SIDEBAR_PX`, on its Timeline tab with the cards drawn. */
async function openTimeline(device: Obsidian, page: Page): Promise<void> {
	await device.evaluate(() =>
		app.commands.executeCommandById("mdsync:open-source-control"),
	);
	await device.waitFor(
		"the source control view",
		() => document.querySelector(".mdsync-source-control") !== null,
		Boolean,
	);
	await device.evaluate((width) => {
		const split = app.workspace.rightSplit;
		split.expand();
		split.setSize?.(width);
		split.containerEl.style.width = `${width}px`;
		app.workspace.onResize();
	}, SIDEBAR_PX);
	await page.locator('[data-mdsync-tab="timeline"]').click();
	await device.waitFor(
		"the timeline cards",
		() => document.querySelectorAll(".mdsync-timeline-card").length,
		(count: number) => count > 0,
	);
	const width = await device.evaluate(
		() =>
			document.querySelector<HTMLElement>(".mdsync-source-control")
				?.clientWidth ?? 0,
	);
	console.log(`source control view is ${width}px wide`);
	check("the view is sidebar-sized", width >= 360 && width <= 440, true);
}

async function checkOverview(device: Obsidian, page: Page): Promise<void> {
	const seen = await device.evaluate(() => {
		const text = (selector: string) =>
			[...document.querySelectorAll(selector)].map(
				(el) => el.textContent ?? "",
			);
		const firstUnpinned = [
			...document.querySelectorAll(".mdsync-timeline-card"),
		]
			.find((card) => !card.querySelector(".mdsync-history-pin"))
			?.querySelector(".mdsync-history-row-title")?.textContent;
		return {
			activity: document.querySelector(".mdsync-timeline-activity")
				?.textContent,
			calendarDays: document.querySelectorAll(".mdsync-calendar-day").length,
			groups: text(".mdsync-timeline-day"),
			cards: document.querySelectorAll(".mdsync-timeline-card").length,
			firstUnpinned,
		};
	});
	console.log(`timeline: ${JSON.stringify(seen)}`);
	check(
		"the activity card counts pushes",
		seen.activity?.includes("pushes since"),
		true,
	);
	check("the calendar draws a year of days", seen.calendarDays >= 300, true);
	check(
		"a Last hour group",
		seen.groups.some((text) => text.toLowerCase().includes("last hour")),
		true,
	);
	check(
		"a Pinned group",
		seen.groups.some((text) => text.toLowerCase().startsWith("pinned")),
		true,
	);
	check("session cards are drawn", seen.cards > 0, true);
	check(
		"a session title carries its device and span",
		seen.firstUnpinned?.includes(" · "),
		true,
	);
	await shot(page, "1-timeline");
}

async function checkExpanded(device: Obsidian, page: Page): Promise<void> {
	const index = await device.evaluate(() =>
		[...document.querySelectorAll(".mdsync-timeline-card")].findIndex(
			(card) => !card.querySelector(".mdsync-history-pin"),
		),
	);
	const card = page.locator(CARD).nth(index);
	await card.locator(".mdsync-timeline-head").first().click();
	await poll("the card's files", async () =>
		(await card.locator(".mdsync-timeline-file").count()) > 0
			? true
			: undefined,
	);
	check(
		"an opened session lists its files",
		(await card.locator(".mdsync-timeline-file").count()) > 0,
		true,
	);
	const more = card.locator(".mdsync-timeline-more");
	if ((await more.count()) > 0) {
		console.log(`Show all: "${await more.first().textContent()}"`);
		await more.first().click();
		await poll("the card's pushes", async () =>
			(await card.locator(".mdsync-timeline-version").count()) > 0
				? true
				: undefined,
		);
		check(
			"Show all lists the pushes",
			(await card.locator(".mdsync-timeline-version").count()) > 0,
			true,
		);
	} else console.log("no Show all button on this card");
	await shot(page, "2-expanded");
}

async function checkFilter(device: Obsidian, page: Page): Promise<void> {
	const before = await page.locator(CARD).count();
	const input = page.locator(FILTER);
	await input.click();
	await page.keyboard.type("Brief", { delay: 60 });
	await sleep(400);
	check(
		"the filter keeps focus while typing",
		await filterFocused(device),
		true,
	);
	await poll("fewer cards", async () =>
		(await page.locator(CARD).count()) < before ? true : undefined,
	);
	const shown = await page.locator(CARD).count();
	console.log(`cards: ${before} unfiltered, ${shown} for Brief`);
	check("a filter leaves a card for Brief", shown >= 1, true);
	// Opening every card shows the files it kept: all of them must be the filtered path.
	for (let index = 0; index < shown; index++) {
		const head = page.locator(
			`${CARD} >> nth=${index} >> .mdsync-timeline-head`,
		);
		const head0 = head.first();
		if ((await head0.getAttribute("aria-expanded")) !== "true") {
			await head0.click();
		}
	}
	await sleep(400);
	const files = await device.evaluate(() =>
		[...document.querySelectorAll(".mdsync-timeline-file")].map(
			(el) => el.textContent ?? "",
		),
	);
	console.log(`files under Brief: ${JSON.stringify(files)}`);
	check("a file row is shown", files.length > 0, true);
	check(
		"every file row is Brief",
		files.every((text) => text.toLowerCase().includes("brief")),
		true,
	);
	await shot(page, "3-filtered");

	await input.fill("");
	await input.click();
	await page.keyboard.type("zzz-none", { delay: 60 });
	await sleep(400);
	check("the filter keeps focus on a miss", await filterFocused(device), true);
	const empty = await device.waitFor(
		"the empty state",
		() =>
			document.querySelector(".mdsync-timeline-sessions .mdsync-empty-state")
				?.textContent ?? "",
		(text: string) => text !== "",
	);
	check(
		"a miss says no pushes touch it",
		empty.includes("No pushes touch"),
		true,
	);
	check("a miss draws no card", await page.locator(CARD).count(), 0);
}

function filterFocused(device: Obsidian): Promise<boolean> {
	return device.evaluate(
		() =>
			document.activeElement?.matches(".mdsync-timeline-filter input") ?? false,
	);
}

async function checkDayChip(device: Obsidian, page: Page): Promise<void> {
	await page.locator(FILTER).fill("");
	await poll("the cards back", async () =>
		(await page.locator(CARD).count()) > 0 ? true : undefined,
	);
	check("clearing the filter brings the cards back", true, true);
	const today = page.locator(".mdsync-calendar-day").last();
	await today.scrollIntoViewIfNeeded();
	await today.click();
	await poll("the day chip", async () =>
		(await page.locator(".mdsync-timeline-day-chip").count()) > 0
			? true
			: undefined,
	);
	check(
		"picking today shows a day chip",
		await device.evaluate(
			() =>
				document.querySelector(".mdsync-timeline-day-chip")?.textContent !==
				undefined,
		),
		true,
	);
	console.log(
		`day chip: ${await page.locator(".mdsync-timeline-day-chip").textContent()}, cards: ${await page.locator(CARD).count()}`,
	);
	await shot(page, "4-day");
}

/** Brief.md on the History tab: its pinned version apart, the rest by age, the footer on what thins. */
async function checkFileHistory(device: Obsidian, page: Page): Promise<void> {
	await device.evaluate(async () => {
		const file = app.vault.getAbstractFileByPath("Projects/Alpha/Brief.md");
		await app.workspace.getLeaf(false).openFile(file);
	});
	await page.locator('[data-mdsync-tab="history"]').click();
	await device.waitFor(
		"the history rows",
		() => document.querySelectorAll(".mdsync-history-row").length,
		(count: number) => count > 0,
	);
	const seen = await device.evaluate(() => {
		const text = (selector: string) =>
			[...document.querySelectorAll(selector)].map(
				(each) => each.textContent ?? "",
			);
		return {
			headers: text(".mdsync-history-pane .mdsync-timeline-day"),
			meta: text(".mdsync-history-row .mdsync-history-row-meta"),
			footer: text(".mdsync-history-footer").join(""),
			tooltips: [...document.querySelectorAll(".mdsync-history-row")].map(
				(row) => row.getAttribute("aria-label") ?? "",
			),
		};
	});
	console.log(`history: ${JSON.stringify(seen)}`);
	check(
		"the pinned version leads",
		seen.headers[0]?.toLowerCase().startsWith("pinned"),
		true,
	);
	check(
		"the rest sit in the last hour",
		seen.headers.some((header) => header.toLowerCase().includes("last hour")),
		true,
	);
	check(
		"the oldest says it created the file",
		seen.meta.some((meta) => meta.endsWith("first version")),
		true,
	);
	check(
		"a tooltip carries the whole meta",
		seen.tooltips.some((tooltip) => tooltip.endsWith("first version")),
		true,
	);
	check(
		"the footer says what thins",
		seen.footer.includes("only pinned versions and activity counts remain"),
		true,
	);
	await shot(page, "6-history");
}

/** Draft.md on the Deleted tab: how long history keeps it, and the path filter. */
async function checkDeleted(device: Obsidian, page: Page): Promise<void> {
	await page.locator('[data-mdsync-tab="deleted"]').click();
	await device.waitFor(
		"the deleted rows",
		() => document.querySelectorAll(".mdsync-deleted-row").length,
		(count: number) => count > 0,
	);
	const seen = await device.evaluate(() => ({
		kept: document.querySelector(".mdsync-deleted-kept")?.textContent ?? "",
		notes: [...document.querySelectorAll(".mdsync-deleted-note")].map(
			(each) => each.textContent ?? "",
		),
	}));
	console.log(`deleted: ${JSON.stringify(seen)}`);
	check("the head says how long", seen.kept, "Kept 3 months after deletion");
	check(
		"the draft says until when",
		seen.notes.some((note) => note.startsWith("Kept until")),
		true,
	);
	await shot(page, "7-deleted");
	const copyWidth = () =>
		device.evaluate(
			() => document.querySelector(".mdsync-deleted-copy")?.clientWidth,
		);
	const still = await copyWidth();
	await page.locator(".mdsync-deleted-row").first().hover();
	check("hovering a row reflows nothing", await copyWidth(), still);
	check(
		"hovering a row shows its actions",
		await page.locator(".mdsync-deleted-row .mdsync-row-actions").isVisible(),
		true,
	);
	await shot(page, "7-deleted-hover");
	const input = page.locator(
		".mdsync-deleted-panel .mdsync-timeline-filter input",
	);
	await input.click();
	await page.keyboard.type("zzz-none", { delay: 60 });
	await device.waitFor(
		"the no-match state",
		() =>
			document.querySelector(".mdsync-deleted-list .mdsync-empty-state")
				?.textContent ?? "",
		(text: string) => text.includes("No deleted files match"),
	);
	check(
		"the filter keeps focus on a miss",
		await device.evaluate(
			() =>
				document.activeElement?.matches(".mdsync-deleted-panel input") ?? false,
		),
		true,
	);
	await input.fill("draft");
	await device.waitFor(
		"the draft alone",
		() => document.querySelectorAll(".mdsync-deleted-row").length,
		(count: number) => count === 1,
	);
}

/** The plugin's Sync page, scrolled to the toggle that hides the calendar. */
async function checkActivitySetting(
	device: Obsidian,
	browser: NonNullable<Awaited<ReturnType<typeof chromium.connectOverCDP>>>,
): Promise<void> {
	await openSettings(device, "Sync");
	const row = await device.evaluate(() => {
		const found = [
			...activeDocument.querySelectorAll<HTMLElement>(
				".mod-settings .setting-item",
			),
		].find(
			(each) =>
				each.querySelector(".setting-item-name")?.textContent ===
				"Show activity in Timeline",
		);
		if (!found) return null;
		found.scrollIntoView({ block: "center" });
		const box = found.getBoundingClientRect();
		const height = activeDocument.defaultView?.innerHeight ?? 0;
		return {
			shown: found.checkVisibility(),
			inView: box.top >= 0 && box.bottom <= height,
			on: found.querySelector(".checkbox-container.is-enabled") !== null,
		};
	});
	console.log(`Show activity in Timeline: ${JSON.stringify(row)}`);
	check("the activity toggle is in the Sync page", row !== null, true);
	check("the activity toggle is visible", row?.shown && row.inView, true);
	check("the activity toggle is on", row?.on, true);
	const page = await poll("the settings window", async () => {
		for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
			if ((await candidate.locator(".mod-settings").count()) > 0)
				return candidate;
		}
		return undefined;
	});
	await shot(page, "5-activity-setting");
}

/** **What history holds** under **Keep history for**; a day opens the Timeline on it. */
async function checkHolds(
	device: Obsidian,
	browser: NonNullable<Awaited<ReturnType<typeof chromium.connectOverCDP>>>,
): Promise<void> {
	const ladder = await device.waitFor(
		"the holds calendar",
		() => {
			const row = activeDocument.querySelector<HTMLElement>(".mdsync-holds");
			if (!row?.querySelector(".mdsync-calendar-day")) return null;
			row.scrollIntoView({ block: "center" });
			return [...row.querySelectorAll(".mdsync-holds-step")].map((step) =>
				[...step.children].map((part) => part.textContent).join(""),
			);
		},
		(steps: string[] | null) => steps !== null,
	);
	console.log(`ladder: ${JSON.stringify(ladder)}`);
	check("the ladder starts at every push", ladder?.[0], "Every pushLast hour");
	check(
		"the ladder ends at activity only",
		ladder?.at(-1),
		"Activity onlyOlder",
	);
	for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
		if ((await candidate.locator(".mdsync-holds").count()) === 0) continue;
		await shot(candidate, "8-holds");
		await candidate
			.locator(".mdsync-holds .mdsync-calendar-day")
			.last()
			.click();
	}
	const chip = await device.waitFor(
		"the Timeline on the picked day",
		() => document.querySelector(".mdsync-timeline-day-chip")?.textContent,
		(text: string | undefined) => Boolean(text),
	);
	check("a day opens the Timeline on it", Boolean(chip), true);
	check(
		"the settings close",
		await device.evaluate(() => !document.querySelector(".mod-settings")),
		true,
	);
}

/** The root page draws the activity the Timeline already read, then opens the Timeline. */
async function checkDashboard(
	device: Obsidian,
	browser: NonNullable<Awaited<ReturnType<typeof chromium.connectOverCDP>>>,
): Promise<void> {
	await openSettings(device);
	const head = await device.waitFor(
		"the dashboard activity",
		() => {
			const card = activeDocument.querySelector(".mdsync-overview-activity");
			if (!card?.querySelector(".mdsync-calendar-day")) return null;
			return {
				text:
					card.querySelector(".mdsync-overview-card-lines")?.textContent ?? "",
				bands: card.querySelector(".mdsync-calendar-bands") !== null,
				today: (() => {
					const scroller = card.querySelector(
						".mdsync-calendar",
					) as HTMLElement;
					return (
						scroller.scrollLeft + scroller.clientWidth >=
						scroller.scrollWidth - 1
					);
				})(),
			};
		},
		(found: { text: string; bands: boolean; today: boolean } | null) =>
			found?.today === true,
	);
	console.log(`dashboard: ${JSON.stringify(head)}`);
	check("the dashboard counts pushes", /\d+ push/.test(head?.text ?? ""), true);
	check("the dashboard names no resolutions", head?.bands, false);
	for (const candidate of browser.contexts().flatMap((c) => c.pages())) {
		if ((await candidate.locator(".mdsync-overview-activity").count()) === 0)
			continue;
		await shot(candidate, "9-dashboard");
		await candidate
			.locator(".mdsync-overview-activity button", { hasText: "Open timeline" })
			.click();
	}
	const shown = await device.waitFor(
		"the Timeline from the dashboard",
		() =>
			!document.querySelector(".mod-settings") &&
			document
				.querySelector('[data-mdsync-tab="timeline"]')
				?.getAttribute("aria-selected") === "true",
		(open: boolean) => open,
	);
	check("Open timeline shows the Timeline", shown, true);
}

async function shot(page: Page, name: string): Promise<void> {
	if (!process.env.E2E_SHOTS) return;
	mkdirSync(SHOTS_DIR, { recursive: true });
	const path = join(SHOTS_DIR, `${name}.png`);
	await page.screenshot({
		path,
		style: ".notice-container { display: none; }",
	});
	console.log(`shot ${path}`);
}
