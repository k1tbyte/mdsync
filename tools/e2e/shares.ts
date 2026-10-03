/**
 * A share between two devices of its owner in real Obsidians: the laptop shares and moves a folder, the
 * desktop mounts, follows, pauses and resumes it.
 */

import {
	CLEAN,
	clickMenuItem,
	closeModals,
	openSettings,
	press,
	read,
	sync,
	unlock,
	write,
} from "./device";
import { check, poll, runScenario } from "./harness";
import { launchObsidian, type Obsidian } from "./obsidian";
import { type S3, startS3 } from "./s3";

const S3_PORT = 8802;
const CDP_PORTS = [9223, 9224];
const PASSPHRASE = "e2e-passphrase";
const PLAN = "Team/plan.md";
const TODO = "Team/todo.md";
const NOTES = "notes.md";
const MOVED = "Projects/Team";
const SHARE_ITEM = "MDSync: Share folder";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runScenario("shares e2e", async () => {
	const s3 = await startS3(S3_PORT);
	const devices: Obsidian[] = [];
	try {
		const settings = {
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
		};
		const files: Record<string, string>[] = [
			{ [PLAN]: "plan v1\n", [TODO]: "todo v1\n", [NOTES]: "vault note\n" },
			{},
		];
		for (const [index, port] of CDP_PORTS.entries()) {
			const device = await launchObsidian({
				port,
				settings,
				files: files[index],
			});
			devices.push(device);
			await unlock(device, PASSPHRASE);
			check(`device ${index + 1} syncs the vault`, await sync(device), CLEAN);
		}
		const [laptop, desktop] = devices as [Obsidian, Obsidian];
		await scenario(laptop, desktop, s3);
	} finally {
		s3.stop();
		await Promise.all(devices.map((device) => device.stop()));
	}
});

async function scenario(
	laptop: Obsidian,
	desktop: Obsidian,
	s3: S3,
): Promise<void> {
	check("the desktop pulls the folder", await read(desktop, PLAN), "plan v1\n");
	const frozen = await vaultEntry(laptop, PLAN);

	await clickMenuItem(laptop, "Team", SHARE_ITEM);
	const id = await laptop.waitFor(
		"the share's record",
		() => app.plugins.plugins.mdsync.settings.spaces[0]?.id,
		(value: string | undefined) => value !== undefined,
	);
	// Sharing opens the share's window for the first invite.
	await closeModals(laptop);
	const manifest = `vault/shares/${id}/manifest.json.enc`;
	await poll("the share pushed", async () =>
		s3.keys().includes(manifest) ? true : undefined,
	);
	check("the laptop settles", await sync(laptop), CLEAN);
	const keys = s3.keys();
	check(
		"the share sits in its own prefix, its record beside the vault's",
		[
			keys.includes(manifest),
			keys.includes(`vault/spaces/${id}.json.enc`),
			keys.some((key) => key.startsWith(`vault/shares/${id}/keys`)),
		],
		[true, true, false],
	);

	check("the desktop mounts the share", await sync(desktop), CLEAN);
	check(
		"the desktop knows the share",
		await desktop.evaluate(() =>
			app.plugins.plugins.mdsync.settings.spaces.map(
				(space: { id: string; root: string }) => [space.id, space.root],
			),
		),
		[[id, "Team"]],
	);

	await write(desktop, PLAN, "plan v2\n");
	check("the desktop pushes into the share", await sync(desktop), CLEAN);
	check("the laptop pulls from the share", await sync(laptop), CLEAN);
	check("the edit reaches the laptop", await read(laptop, PLAN), "plan v2\n");

	await write(laptop, PLAN, "plan v3\n");
	await write(laptop, NOTES, "vault note 2\n");
	check("the laptop pushes both spaces", await sync(laptop), CLEAN);
	check("the desktop pulls both spaces", await sync(desktop), CLEAN);
	check(
		"both edits reach the desktop",
		[await read(desktop, PLAN), await read(desktop, NOTES)],
		["plan v3\n", "vault note 2\n"],
	);
	check(
		"the vault's next push leaves the folder out",
		[frozen !== null, await vaultEntry(laptop, PLAN)],
		[true, null],
	);

	await pauseHere(desktop, "Pause on this device", 1);
	await write(laptop, PLAN, "plan v4\n");
	check("the laptop pushes to the paused desktop", await sync(laptop), CLEAN);
	const todo = await vaultEntry(desktop, TODO);
	await write(desktop, TODO, "todo from the paused desktop\n");
	check(
		"the paused desktop syncs its vault alone, the folder left as it is",
		[await sync(desktop), await read(desktop, PLAN)],
		[CLEAN, "plan v3\n"],
	);
	check(
		"the vault never takes the paused folder",
		await vaultEntry(desktop, TODO),
		todo,
	);
	await pauseHere(desktop, "Resume on this device", 0);
	check("the desktop resumes", await sync(desktop), CLEAN);
	check("the laptop pulls the paused edit", await sync(laptop), CLEAN);
	check(
		"both sides meet",
		[await read(desktop, PLAN), await read(laptop, TODO)],
		["plan v4\n", "todo from the paused desktop\n"],
	);

	await moveFolder(laptop, desktop);

	await desktop.evaluate(
		(root) => app.vault.delete(app.vault.getFolderByPath(root), true),
		MOVED,
	);
	check(
		"the desktop syncs past its vanished folder",
		await sync(desktop),
		CLEAN,
	);
	check(
		"the desktop names the folder instead of deleting it for everyone",
		await desktop.evaluate(() =>
			app.plugins.plugins.mdsync.controller
				.getSnapshot()
				.spaceErrors.map((each: { root: string }) => each.root),
		),
		[MOVED],
	);
	check("the laptop pulls nothing", await sync(laptop), CLEAN);
	check(
		"the laptop keeps the folder",
		await read(laptop, `${MOVED}/plan.md`),
		"plan v5\n",
	);
}

/** The laptop renames the shared folder; the desktop moves its own copy by itself. */
async function moveFolder(laptop: Obsidian, desktop: Obsidian): Promise<void> {
	await laptop.evaluate(async (to) => {
		await app.vault.createFolder("Projects");
		await app.fileManager.renameFile(app.vault.getFolderByPath("Team"), to);
	}, MOVED);
	await laptop.waitFor(
		"the moved root saved",
		() => app.plugins.plugins.mdsync.settings.spaces[0]?.root,
		(root: string) => root === MOVED,
	);
	check("the laptop syncs the move", await sync(laptop), CLEAN);
	check("the desktop follows", await sync(desktop), CLEAN);
	const plan = `${MOVED}/plan.md`;
	check(
		"the folder moved on the desktop, nothing left behind",
		await desktop.evaluate(
			([moved, old]) => [
				app.vault.getFileByPath(moved) !== null,
				app.vault.getFolderByPath(old),
				app.plugins.plugins.mdsync.settings.localRoots,
			],
			[plan, "Team"],
		),
		[true, null, {}],
	);

	await write(desktop, plan, "plan v5\n");
	check("the desktop pushes at the new root", await sync(desktop), CLEAN);
	check("the laptop pulls it", await sync(laptop), CLEAN);
	check(
		"the edit crosses, and the vault never takes the moved folder",
		[await read(laptop, plan), await vaultEntry(laptop, plan)],
		["plan v5\n", null],
	);
}

/** The vault manifest's own entry for a note of the shared folder. */
function vaultEntry(device: Obsidian, path: string): Promise<string | null> {
	return device.evaluate(
		(target) =>
			app.plugins.plugins.mdsync.controller.runtimeState.resultOf({
				id: "vault",
				root: "",
			})?.remote?.files[target]?.hash ?? null,
		path,
	);
}

/** Pause or resume the only share on this device, from its window in the settings. */
async function pauseHere(
	device: Obsidian,
	action: string,
	paused: number,
): Promise<void> {
	await openSettings(device, "Sync");
	await press(device, "Manage");
	await press(device, action);
	await device.waitFor(
		`${action} saved`,
		() => app.plugins.plugins.mdsync.settings.pausedSpaces.length,
		(count: number) => count === paused,
	);
	await closeModals(device);
}
