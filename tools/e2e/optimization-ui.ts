import { CLEAN, sync, unlock } from "./device";
import { check, runScenario } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { startS3 } from "./s3";
import { s3Vault } from "./sharing";

const ROW_COUNT = 20_000;
const PAGE_SIZE = 100;

// biome-ignore lint/suspicious/noExplicitAny: Obsidian's renderer app is untyped here.
declare const app: any;

await runScenario("optimization UI e2e", async () => {
	const s3 = await startS3(8832);
	let device: Obsidian | null = null;
	try {
		device = await launchObsidian({
			port: 9233,
			settings: { ...s3Vault(s3, "ui"), fileHistoryEnabled: true },
			files: { "note.md": "test\n" },
		});
		await unlock(device, "ui-passphrase");
		check("the vault syncs", await sync(device), CLEAN);
		await device.evaluate((count) => {
			const history = app.plugins.plugins.obsync.controller.history;
			const paths = Array.from(
				{ length: count },
				(_, index) => `Notes/n${String(index).padStart(5, "0")}.md`,
			);
			const entry = { hash: "h", size: 1, mtime: 1, kind: "vault" };
			const createdAt = Date.now();
			history.listSnapshots = async () => ({
				lagging: false,
				snapshots: [
					{
						id: "snapshot",
						createdAt,
						deviceId: "device",
						pinned: false,
						files: {
							added: Object.fromEntries(paths.map((path) => [path, entry])),
							modified: {},
							deleted: {},
						},
						rank: 0,
						restorable: true,
						isHead: true,
					},
				],
			});
			history.listDeletedFiles = async () => ({
				lagging: false,
				truncated: false,
				files: paths.map((path) => ({
					path,
					entry,
					snapshotId: "snapshot",
					source: "deleted",
					createdAt,
					deviceId: "device",
					rank: 0,
				})),
			});
			app.commands.executeCommandById("obsync:open-source-control");
		}, ROW_COUNT);
		await device.waitFor(
			"source-control tabs",
			() => document.getElementById("obsync-source-tab-timeline") !== null,
			(ready) => ready,
		);
		await device.evaluate(() =>
			document.getElementById("obsync-source-tab-timeline")?.click(),
		);
		await device.waitFor(
			"the snapshot",
			() => document.querySelector(".obsync-timeline-head") !== null,
			(ready) => ready,
		);
		const timelineMs = await device.evaluate(() => {
			const start = performance.now();
			document.querySelector<HTMLElement>(".obsync-timeline-head")?.click();
			return performance.now() - start;
		});
		check(
			"a 20,000-file snapshot mounts one page",
			await device.evaluate(
				() => document.querySelectorAll(".obsync-timeline-file").length,
			),
			PAGE_SIZE,
		);
		await device.evaluate(() => {
			const next = [
				...document.querySelectorAll<HTMLButtonElement>(
					".obsync-timeline-files button",
				),
			].find((button) => button.textContent === "Next page");
			next?.click();
		});
		check(
			"the timeline's next page starts at file 101",
			await device.evaluate(() =>
				document
					.querySelector(".obsync-timeline-file")
					?.getAttribute("data-timeline-focus"),
			),
			JSON.stringify(["snapshot", "Notes/n00100.md"]),
		);
		await device.evaluate(() =>
			document.getElementById("obsync-source-tab-deleted")?.click(),
		);
		await device.waitFor(
			"deleted-file rows",
			() => document.querySelectorAll(".obsync-history-row").length,
			(count: number) => count === PAGE_SIZE,
		);
		check(
			"Trash mounts one page",
			await device.evaluate(
				() => document.querySelectorAll(".obsync-history-row").length,
			),
			PAGE_SIZE,
		);
		await device.evaluate(() => {
			const select = [
				...document.querySelectorAll<HTMLButtonElement>(
					".obsync-history-head-actions button",
				),
			].find((button) => button.textContent === "Select all");
			select?.click();
		});
		check(
			"Select all includes files on other pages",
			await device.evaluate(() =>
				[
					...document.querySelectorAll<HTMLButtonElement>(
						".obsync-history-head-actions button",
					),
				].some((button) => button.textContent === "Restore selected (20000)"),
			),
			true,
		);
		await device.evaluate(() => {
			const next = [
				...document.querySelectorAll<HTMLButtonElement>(
					".obsync-history-list button",
				),
			].find((button) => button.textContent === "Next page");
			next?.click();
		});
		check(
			"Trash retains selection on the next page",
			await device.evaluate(
				() => document.querySelectorAll(".obsync-file-checkbox:checked").length,
			),
			PAGE_SIZE,
		);
		check(
			"the next Trash page starts at file 101",
			await device.evaluate(
				() => document.querySelector(".obsync-history-row-title")?.textContent,
			),
			"Notes/n00100.md",
		);
		console.log(`Expanded snapshot render: ${Math.round(timelineMs)} ms`);
	} finally {
		s3.stop();
		await device?.stop();
	}
});
