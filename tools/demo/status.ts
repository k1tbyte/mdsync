/** Demo: the status bar menu, with every relay the vault rides and the folders on each. The relays and folders are staged: it needs no second relay. */

import { CLEAN, loaded, sync, unlock } from "../../tests/e2e/device";
import { check, runScenario, sleep } from "../../tests/e2e/harness";
import { launchObsidian } from "../../tests/e2e/obsidian";
import { startS3 } from "../../tests/e2e/s3";
import { s3Vault } from "../../tests/e2e/sharing";
import {
	attachPage,
	click,
	encode,
	frameWindow,
	glide,
	record,
} from "./recorder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

/** A small window filmed at full width: the menu fills a third of it. */
const WINDOW = { width: 700, height: 500, x: 40, y: 40, scale: 1920 / 700 };
const PORT = 9223;
const S3_PORT = 8802;
const OUT_DIR = "artifacts/demos";
const PASSPHRASE = "demo-passphrase";
const OWN_RELAY = "https://mdsync-relay.k1t.workers.dev";
const OTHER_RELAY = "https://mdsync-relay.alice.workers.dev";

const NOTES = {
	"Ideas.md": "- A reading nook by the window\n",
	"Projects/Website redesign.md": "- [x] New colour palette\n",
	".obsidian/appearance.json": JSON.stringify({ theme: "obsidian" }),
};

await runScenario("status demo", async () => {
	const s3 = await startS3(S3_PORT);
	process.env.E2E_VISIBLE = "1";
	const obsidian = await launchObsidian({
		port: PORT,
		settings: {
			...s3Vault(s3, "demo"),
			relayUrl: OWN_RELAY,
			relaySecret: "x".repeat(32),
		},
		files: NOTES,
	});
	try {
		await loaded(obsidian);
		await unlock(obsidian, PASSPHRASE);
		check("the vault syncs", await sync(obsidian), CLEAN);
		await obsidian.evaluate(
			({ own, other }) => {
				const plugin = app.plugins.plugins.mdsync;
				const { hub } = plugin.realtime;
				const names: Record<string, string> = {
					s1: "Framepod",
					s2: "Design notes",
					s3: "Reading club",
					s4: "Team wiki",
				};
				const status: Record<string, string> = {
					vault: "connected",
					s1: "connected",
					s2: "connected",
					s3: "connected",
					s4: "connected",
				};
				plugin.spaces.partition = () =>
					["vault", ...Object.keys(names)].map((id) => ({
						id,
						root: id === "vault" ? "" : id,
					}));
				plugin.spaces.get = (id: string) =>
					names[id] && {
						id,
						name: names[id],
						root: names[id],
						rev: 1,
						author: "dev",
						access: {
							kind: "participant",
							relayUrl: other,
							token: "t",
							participantId: "p1",
							personName: "Kirill",
						},
					};
				hub.statusOf = (id: string) => status[id] ?? "off";
				hub.relays = () => [
					{
						url: own,
						state: "connected",
						spaces: ["vault", "s1", "s2"],
						full: [],
					},
					{
						url: other,
						state: "connected",
						spaces: ["s3", "s4"],
						full: [],
					},
				];
			},
			{ own: OWN_RELAY, other: OTHER_RELAY },
		);
		const page = await attachPage(PORT);
		await frameWindow(page, WINDOW);
		// Obsidian's own Sync reports itself as not set up there, which has nothing to do with this plugin.
		await page.addStyleTag({
			content: ".status-bar-item.plugin-sync { display: none; }",
		});
		await page.locator(".mdsync-status-bar").first().waitFor();
		if (process.env.DEMO_HOLD) {
			console.log("holding, stop the process to close Obsidian");
			await new Promise(() => {});
		}

		await sleep(1500);
		const recording = await record(page);
		try {
			await sleep(900);
			await click(page, ".mdsync-status-bar", 1000);
			await page.locator(".menu").last().waitFor();
			await sleep(1800);
			await glide(page, ".menu-item:has-text('Reading club')", 900);
			await sleep(1800);
			await glide(page, ".menu-item:has-text('Framepod')", 800);
			await sleep(1800);
		} finally {
			console.log(`wrote ${encode("status", await recording.stop())}`);
		}
		await page.screenshot({ path: `${OUT_DIR}/status-end.png` });
	} finally {
		s3.stop();
		await obsidian.stop();
	}
});
