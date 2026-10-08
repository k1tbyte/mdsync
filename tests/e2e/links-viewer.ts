/**
 * The link viewer in a real browser, served by the relay: what a recipient sees, the passphrase form,
 * that a reload costs no view, and that a hostile note cannot run script.
 */

import { newLinkKey, toBase64Url } from "@mdsync/protocol";
import {
	type Browser,
	type BrowserContext,
	chromium,
	type Page,
} from "playwright-core";

import { check } from "./harness";
import { admin, type Published, publish } from "./link-client";

const NOTE = {
	title: "Trip notes",
	html: [
		'<h2>Lisbon</h2><p>Landing in <strong>May</strong> with <a href="https://example.com/map">a map</a>.</p>',
		'<div class="callout is-collapsible is-collapsed" data-callout="tip"><div class="callout-title"><div class="callout-title-inner">Pack light</div></div><div class="callout-content"><p>Only a carry-on.</p></div></div>',
		'<ul class="contains-task-list"><li class="task-list-item"><input type="checkbox" checked> Book hotel</li></ul>',
		'<h2>Porto</h2><pre class="language-ts"><code class="language-ts">const a = 1;</code></pre>',
		"<h3>Food</h3><p>Pastel de nata.</p>",
		// Room below, so a jump can bring the last headings to the top.
		"<p>Notes from the road.</p>".repeat(30),
	].join(""),
};

const HOSTILE = {
	title: "Hostile",
	html: '<p>safe text</p><img src="x" onerror="window.__pwned = 1"><script>window.__pwned = 2</script><a href="javascript:window.__pwned = 3">click</a><svg><script>window.__pwned = 4</script></svg>',
};

export async function viewerScenario(base: string): Promise<void> {
	const browser = await launch();
	try {
		await shell(base);
		await recipient(base, browser);
		await oneView(base, browser);
		await protectedNote(base, browser);
		await hostile(base, browser);
		await brokenLinks(base, browser);
	} finally {
		await browser.close();
	}
}

async function launch(): Promise<Browser> {
	try {
		return await chromium.launch({ headless: true });
	} catch {
		return chromium.launch({ headless: true, channel: "chrome" });
	}
}

async function shell(base: string): Promise<void> {
	const { id } = await publish(base, NOTE);
	const page = await fetch(`${base}/s/${id}`);
	const csp = page.headers.get("Content-Security-Policy") ?? "";
	check("the link page is served", page.status, 200);
	check(
		"under a policy that allows no inline script",
		[csp.includes("script-src 'self'"), csp.includes("frame-ancestors 'none'")],
		[true, true],
	);
	check(
		"and never a referrer",
		page.headers.get("Referrer-Policy"),
		"no-referrer",
	);
	check(
		"it loads the viewer script",
		(await page.text()).includes("/viewer/viewer.js"),
		true,
	);
	const script = await fetch(`${base}/viewer/viewer.js`);
	check(
		"the script is served as a plain asset",
		[script.status, script.headers.get("Content-Type")?.includes("javascript")],
		[200, true],
	);
	check(
		"an id that cannot be a link's is 404",
		(await fetch(`${base}/s/short`)).status,
		404,
	);
	check(
		"looking at a link spends no view",
		(await (await admin(base, `/link/${id}/status`)).json()).views,
		0,
	);
}

async function recipient(base: string, browser: Browser): Promise<void> {
	const link = await publish(base, NOTE);
	const context = await browser.newContext();
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	const page = await context.newPage();
	await page.goto(link.url);
	await page.locator(".markdown-rendered").waitFor();
	check(
		"the recipient reads the note",
		await page.locator(".note-title").textContent(),
		"Trip notes",
	);
	check(
		"with its formatting",
		await page.locator("h2").first().textContent(),
		"Lisbon",
	);
	await outlineAndFolds(page);
	check(
		"external links open in a new tab, safely",
		await page.locator("a").getAttribute("rel"),
		"noopener noreferrer nofollow",
	);
	check("the page is titled by the note", await page.title(), "Trip notes");
	check(
		"a folded callout starts closed",
		await page.locator(".callout-content").isVisible(),
		false,
	);
	await page.locator(".callout-title").click();
	check(
		"and opens from its title",
		await page.locator(".callout-content").isVisible(),
		true,
	);
	check(
		"checkboxes cannot be changed",
		await page.locator("input[type=checkbox]").isDisabled(),
		true,
	);
	check("opening spent one view", await views(base, link), 1);
	await page.reload();
	await page.locator(".markdown-rendered").waitFor();
	check(
		"a reload shows the note again",
		await page.locator(".note-title").textContent(),
		"Trip notes",
	);
	check("at no cost", await views(base, link), 1);
	await context.close();
}

async function outlineAndFolds(page: Page): Promise<void> {
	const food = page.getByText("Pastel de nata.");
	check(
		"the outline lists the headings beside the note",
		[
			await page.locator(".outline-item").allTextContents(),
			await page.locator(".outline").isVisible(),
		],
		[["Lisbon", "Porto", "Food"], true],
	);
	await page.locator(".heading-fold").nth(1).click();
	check(
		"a heading folds what is under it",
		[await page.locator("pre").isVisible(), await food.isVisible()],
		[false, false],
	);
	await page.locator(".outline-item", { hasText: "Food" }).click();
	check("the outline opens a folded heading", await food.isVisible(), true);
	await page.locator("h3", { hasText: "Food" }).click();
	check("a click on a heading folds it", await food.isVisible(), false);
	await page.locator("h3", { hasText: "Food" }).click();
	await page.locator(".copy-code-button").click();
	check(
		"a code block copies its code",
		await page.evaluate(() => navigator.clipboard.readText()),
		"const a = 1;",
	);
	await anchors(page);
	const viewport = page.viewportSize();
	await page.setViewportSize({ width: 390, height: 800 });
	const panel = page.locator(".sidebar-panel");
	// The panel slides, so its visibility settles after a transition.
	const settles = (state: "visible" | "hidden") =>
		panel.waitFor({ state, timeout: 2000 }).then(
			() => true,
			() => false,
		);
	const hidden = await settles("hidden");
	await page.locator(".sidebar-toggle").click();
	check(
		"on a phone the outline waits behind a menu button",
		[hidden, await settles("visible")],
		[true, true],
	);
	await page.locator(".outline-item", { hasText: "Lisbon" }).click();
	check("and closes after a jump", await settles("hidden"), true);
	if (viewport) await page.setViewportSize(viewport);
}

async function anchors(page: Page): Promise<void> {
	const key = new URL(page.url()).hash;
	const porto = page.locator("h2", { hasText: "Porto" });
	await porto.hover();
	await porto.locator(".heading-anchor").click();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	check(
		"a heading's anchor copies a link to it and keeps the key in the address",
		[copied === page.url(), new URL(copied).hash],
		[true, `${key}/porto`],
	);
	await page.evaluate(() => window.scrollTo(0, 0));
	await page.reload();
	await porto.waitFor();
	await page.waitForFunction(() => window.scrollY > 0, null, { timeout: 2000 });
	check(
		"opening that link lands on the heading",
		await porto.evaluate((h) => Math.round(h.getBoundingClientRect().top)),
		24,
	);
	await page.locator(".wide-toggle").click();
	await page.reload();
	await porto.waitFor();
	check(
		"wide text is remembered",
		await page.locator(".reader.is-wide").count(),
		1,
	);
	await page.locator(".wide-toggle").click();
}

async function oneView(base: string, browser: Browser): Promise<void> {
	const link = await publish(base, NOTE, { maxViews: 1 });
	const first = await visit(browser, link.url);
	check(
		"the one view shows the note",
		await first.page.locator(".note-title").textContent(),
		"Trip notes",
	);
	check(
		"and says it was the last",
		(await first.page.locator(".link-views").textContent())?.includes(
			"last view",
		),
		true,
	);
	const second = await visit(browser, link.url, ".message");
	check(
		"the next visitor finds it gone",
		await second.page.locator("h1").textContent(),
		"This link is no longer available",
	);
	await first.context.close();
	await second.context.close();
}

async function protectedNote(base: string, browser: Browser): Promise<void> {
	const link = await publish(base, NOTE, { passphrase: "correct horse" });
	const { page, context } = await visit(browser, link.url, ".passphrase");
	check(
		"a protected note asks first",
		await page.locator("h1").textContent(),
		"This note is protected",
	);
	check("and has spent no view", await views(base, link), 0);
	await submit(page, "wrong horse");
	await page.locator(".problem:not(:empty)").waitFor();
	check(
		"a wrong passphrase is refused",
		await page.locator(".problem").textContent(),
		"Wrong passphrase.",
	);
	check("without a view", await views(base, link), 0);
	await submit(page, "correct horse");
	await page.locator(".markdown-rendered").waitFor();
	check(
		"the right one opens it",
		await page.locator(".note-title").textContent(),
		"Trip notes",
	);
	check("for one view", await views(base, link), 1);
	await page.reload();
	await page.locator(".markdown-rendered").waitFor();
	check(
		"a reload remembers the passphrase and costs nothing",
		await views(base, link),
		1,
	);
	const tab = await context.newPage();
	await tab.goto(link.url);
	await tab.locator(".markdown-rendered").waitFor();
	check(
		"another tab of this browser opens it without asking, for a view",
		await views(base, link),
		2,
	);
	await context.close();

	const other = await visit(browser, link.url, ".passphrase");
	await other.page.locator(".remember input").uncheck();
	await submit(other.page, "correct horse");
	await other.page.locator(".markdown-rendered").waitFor();
	await other.page.reload();
	await other.page.locator(".passphrase").waitFor();
	check(
		"another browser asks, and asks again when told not to remember",
		await other.page.locator("h1").textContent(),
		"This note is protected",
	);
	await other.context.close();
}

async function hostile(base: string, browser: Browser): Promise<void> {
	const link = await publish(base, HOSTILE);
	const { page, context } = await visit(browser, link.url);
	check(
		"a hostile note still shows its text",
		await page.locator(".markdown-rendered").textContent(),
		"safe textclick",
	);
	check(
		"and runs nothing",
		await page.evaluate(() => (window as { __pwned?: number }).__pwned),
		undefined,
	);
	check(
		"its javascript link goes nowhere",
		await page.locator("a").getAttribute("href"),
		null,
	);
	await context.close();
}

async function brokenLinks(base: string, browser: Browser): Promise<void> {
	const link = await publish(base, NOTE);
	const bare = await visit(browser, link.url.split("#")[0] ?? "", ".message");
	check(
		"a link without its key says so",
		await bare.page.locator("h1").textContent(),
		"This link is incomplete",
	);
	const cut = await visit(browser, link.url.slice(0, -4), ".message");
	check(
		"a key cut short is incomplete too",
		await cut.page.locator("h1").textContent(),
		"This link is incomplete",
	);
	const other = `${link.url.split("#")[0]}#${toBase64Url(newLinkKey())}`;
	const wrong = await visit(browser, other, ".message");
	check(
		"a whole but wrong key is reported as damaged",
		await wrong.page.locator("h1").textContent(),
		"This note could not be opened",
	);
	await bare.context.close();
	await cut.context.close();
	await wrong.context.close();
}

async function visit(
	browser: Browser,
	url: string,
	ready = ".markdown-rendered",
): Promise<{ page: Page; context: BrowserContext }> {
	const context = await browser.newContext();
	const page = await context.newPage();
	await page.goto(url);
	await page.locator(ready).waitFor();
	return { page, context };
}

async function submit(page: Page, passphrase: string): Promise<void> {
	await page.locator("#passphrase").fill(passphrase);
	await page.locator("button[type=submit]").click();
}

async function views(base: string, link: Published): Promise<number> {
	const status = await admin(base, `/link/${link.id}/status`);
	return status.ok ? ((await status.json()) as { views: number }).views : -1;
}
