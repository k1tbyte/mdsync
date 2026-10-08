import { chromium, type Page } from "playwright-core";

import { fill, loaded, press } from "./device";
import { check, poll, runScenario } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";

// biome-ignore lint/suspicious/noExplicitAny: Obsidian's renderer app is untyped here.
declare const app: any;
declare const activeDocument: Document;

const PORT = 9235;
const LOCAL_RULES = "Attachments/\n*.tmp";
const SHARED_RULES = "Archive/\n";

await runScenario("settings UX e2e", async () => {
	const device = await launchObsidian({
		port: PORT,
		settings: { realtimeSync: false, cachePassphrase: false },
		files: { "syncignore.md": SHARED_RULES },
	});
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
	try {
		await loaded(device);
		await device.evaluate(
			() =>
				new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve)),
		);
		await device.evaluate(() => {
			app.setting.open();
		});
		const page = await poll("settings navigation ready", async () => {
			for (const candidate of browser
				.contexts()
				.flatMap((context) => context.pages())) {
				if (
					(await candidate
						.locator(".vertical-tab-nav-item-title", { hasText: /^MDSync$/ })
						.count()) > 0
				)
					return candidate;
			}
			return undefined;
		});
		await page.setViewportSize({ width: 1100, height: 760 });
		await page
			.locator(".vertical-tab-nav-item-title", { hasText: /^MDSync$/ })
			.click();
		await checkPassphraseScroll(device, page);
		await checkSyncSettings(device, page);
		await checkExclusions(device, page);
		await checkPhoneLayout(device, page);
		await page.getByRole("tab", { name: "Sync", exact: true }).click();
		await page
			.getByRole("button", { name: "Open syncignore.md", exact: true })
			.click();
		await device.waitFor(
			"shared rules opened outside settings",
			() => activeDocument.querySelector(".mdsync-settings") === null,
			Boolean,
		);
		check(
			"opening shared rules reveals the note outside settings",
			await device.evaluate(() => app.workspace.getActiveFile()?.path),
			"syncignore.md",
		);
	} finally {
		await browser.close();
		await device.stop();
	}
});

async function checkPassphraseScroll(
	device: Obsidian,
	page: Page,
): Promise<void> {
	const row = settingRow(page, "Passphrase on this device");
	await row.scrollIntoViewIfNeeded();
	const before = await scrollTop(device);
	check("the passphrase action starts below the top", before > 0, true);
	await row.getByRole("button", { name: "Enter…", exact: true }).click();
	await fill(device, "Passphrase", "settings-test-passphrase");
	await press(device, "Continue");
	await row.getByText(/Loaded for this session/).waitFor();
	check(
		"entering a passphrase preserves scroll",
		await scrollTop(device),
		before,
	);

	await row.getByRole("button", { name: "Forget", exact: true }).click();
	await row.getByText(/Not loaded for this session/).waitFor();
	check(
		"forgetting a passphrase preserves scroll",
		await scrollTop(device),
		before,
	);
	await row.getByRole("button", { name: "Enter…", exact: true }).click();
	await press(device, "Cancel");
	check(
		"cancelling a passphrase preserves scroll",
		await scrollTop(device),
		before,
	);

	await settingRow(page, "Change vault passphrase").getByRole("button").click();
	check(
		"unconfigured rotation does not ask for a new password",
		await device.evaluate(() =>
			[...activeDocument.querySelectorAll(".modal-title")].some(
				(el) => el.textContent === "Change passphrase",
			),
		),
		false,
	);
}

async function checkSyncSettings(device: Obsidian, page: Page): Promise<void> {
	await page.getByRole("tab", { name: "Sync", exact: true }).click();
	check("switching sections starts at the top", await scrollTop(device), 0);
	const toggle = settingRow(page, "Push shared folders right away").locator(
		".checkbox-container",
	);
	await toggle.evaluate((el) => el.scrollIntoView({ block: "center" }));
	const before = await scrollTop(device);
	check("the shared-folder toggle starts below the top", before > 0, true);
	await toggle.click();
	await settingRow(page, "Push only added, moved and deleted files").waitFor({
		state: "detached",
	});
	check(
		"a conditional toggle preserves scroll",
		await scrollTop(device),
		before,
	);
	await toggle.click();
	await settingRow(page, "Push only added, moved and deleted files").waitFor();
	check(
		"revealing a sub-setting preserves scroll",
		await scrollTop(device),
		before,
	);
}

async function checkExclusions(device: Obsidian, page: Page): Promise<void> {
	const textarea = page.locator(".mdsync-ignore-patterns textarea");
	await textarea.scrollIntoViewIfNeeded();
	check(
		"local rules are explicitly labelled",
		await textarea.getAttribute("aria-labelledby"),
		"mdsync-local-ignore-label",
	);
	check(
		"local rules do not display the shared note",
		await textarea.inputValue(),
		"",
	);
	check(
		"the shared-note button is outside the textarea row",
		await page.locator(".mdsync-ignore-patterns button").count(),
		0,
	);
	await textarea.fill(LOCAL_RULES);
	await page.getByRole("tab", { name: "Interface", exact: true }).click();
	await poll(
		"local rules saved after leaving the tab",
		async () =>
			(await device.evaluate(
				async () =>
					(
						await app.plugins.plugins.mdsync.loadData()
					).ignorePatterns,
			)) === LOCAL_RULES || undefined,
	);
	check(
		"editing local rules leaves the shared note unchanged",
		await device.evaluate(() =>
			app.vault.read(app.vault.getFileByPath("syncignore.md")),
		),
		SHARED_RULES,
	);

	await page.getByRole("tab", { name: "Sync", exact: true }).click();
	check(
		"local rules survive a rerender",
		await textarea.inputValue(),
		LOCAL_RULES,
	);
	await textarea.scrollIntoViewIfNeeded();
	await shot(page, "settings-exclusions-desktop");
}

async function checkPhoneLayout(device: Obsidian, page: Page): Promise<void> {
	await device.evaluate(() => {
		activeDocument.body.classList.remove("is-desktop");
		activeDocument.body.classList.add("is-mobile", "is-phone");
	});
	for (const width of [320, 390, 600]) {
		await page.setViewportSize({ width, height: 844 });
		const textarea = page.locator(".mdsync-ignore-patterns textarea");
		await textarea.scrollIntoViewIfNeeded();
		const layout = await device.evaluate(() => {
			const root =
				activeDocument.querySelector<HTMLElement>(".mdsync-settings");
			const row = root?.querySelector<HTMLElement>(".mdsync-ignore-patterns");
			const text = row?.querySelector("textarea");
			const label = row?.querySelector(".setting-item-info");
			const controls = row?.querySelector(".setting-item-control");
			if (!root || !text || !label || !controls)
				throw new Error("Missing exclusion controls");
			const input = text.getBoundingClientRect();
			const control = controls.getBoundingClientRect();
			return {
				fullWidth: Math.abs(input.width - control.width) < 2,
				belowLabel: input.top >= label.getBoundingClientRect().bottom,
				usableWidth: input.width >= root.clientWidth - 64,
				noOverflow: root.scrollWidth <= root.clientWidth,
				largeButtons: [...root.querySelectorAll("button")].every(
					(button) => button.getBoundingClientRect().height >= 44,
				),
			};
		});
		check(`phone layout at ${width}px`, layout, {
			fullWidth: true,
			belowLabel: true,
			usableWidth: true,
			noOverflow: true,
			largeButtons: true,
		});
		await shot(page, `settings-exclusions-${width}px`);
	}
	await page.getByRole("tab", { name: "Connection", exact: true }).click();
	await page.setViewportSize({ width: 320, height: 844 });
	check(
		"connection controls fit a narrow phone",
		await device.evaluate(() => {
			const root =
				activeDocument.querySelector<HTMLElement>(".mdsync-settings");
			if (!root) throw new Error("No settings container");
			return root.scrollWidth <= root.clientWidth;
		}),
		true,
	);
	await checkPassphraseScroll(device, page);
}

async function shot(page: Page, name: string): Promise<void> {
	if (!process.env.E2E_SHOTS) return;
	await page.locator(".mdsync-settings").screenshot({
		path: `artifacts/e2e-shots/${name}.png`,
		style: ".notice-container { display: none; }",
	});
}

function settingRow(page: Page, name: string) {
	return page.locator(".mdsync-settings .setting-item").filter({
		has: page.locator(".setting-item-name", {
			hasText: new RegExp(`^${name}$`),
		}),
	});
}

function scrollTop(device: Obsidian): Promise<number> {
	return device.evaluate(() => {
		const root = activeDocument.querySelector<HTMLElement>(".mdsync-settings");
		if (!root) throw new Error("No settings container");
		return root.scrollTop;
	});
}
