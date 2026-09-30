/**
 * A friend with no vault storage joins a share: only the share syncs, the
 * vault stays on the device. Once the friend sets up a vault of their own, the
 * share's record goes there and the vault never takes the share's files.
 */

import { CLEAN, read, sync, unlock, write } from "./device";
import { check } from "./harness";
import type { Obsidian } from "./obsidian";
import type { S3 } from "./s3";
import {
	accept,
	arrives,
	invite,
	mounted,
	runSharing,
	s3Vault,
	shareFolder,
	vaultHash,
} from "./sharing";

const PLAN = "Team/plan.md";
const MOUNTED = "Shared/Team/plan.md";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
declare const activeDocument: Document;

await runSharing(
	"guest e2e",
	{
		owner: { [PLAN]: "plan v1\n" },
		friend: { "mine.md": "the friend's own\n" },
	},
	async (owner, friend, s3) => {
		const id = await joinAsGuest(owner, friend, s3);
		await setUpVault(owner, friend, s3, id);
	},
	{ guest: true },
);

async function joinAsGuest(
	owner: Obsidian,
	friend: Obsidian,
	s3: S3,
): Promise<string> {
	const id = await shareFolder(owner, s3, "Team");
	await accept(friend, await invite(owner, "Team", "Friend"));
	check(
		"the guest pulls the share",
		await mounted(friend, MOUNTED),
		"plan v1\n",
	);
	check("the guest settles", await sync(friend), CLEAN);

	await write(friend, MOUNTED, "plan v2 from the guest\n");
	check("the guest pushes into the share", await sync(friend), CLEAN);
	await arrives(owner, PLAN, "plan v2 from the guest\n");
	await write(owner, PLAN, "plan v3 from the owner\n");
	check("the owner pushes", await sync(owner), CLEAN);
	await arrives(friend, MOUNTED, "plan v3 from the owner\n");

	check(
		"the guest asks for no storage and writes no vault",
		[
			await storageNotices(friend),
			s3.keys().some((key) => key.startsWith("friend/")),
		],
		[[], false],
	);
	return id;
}

async function setUpVault(
	owner: Obsidian,
	friend: Obsidian,
	s3: S3,
	id: string,
): Promise<void> {
	await friend.evaluate(
		async (settings) => {
			const plugin = app.plugins.plugins.obsync;
			Object.assign(plugin.settings, settings);
			await plugin.saveSettings();
		},
		s3Vault(s3, "friend"),
	);
	await unlock(friend, "friend-passphrase");
	check("the friend's vault syncs", await sync(friend), CLEAN);
	check(
		"the record goes to the new vault, which keeps the friend's files but not the share's",
		[
			s3.keys().includes(`friend/spaces/${id}.json.enc`),
			(await vaultHash(friend, "mine.md")) !== null,
			await vaultHash(friend, MOUNTED),
		],
		[true, true, null],
	);

	await write(owner, PLAN, "plan v4 from the owner\n");
	check("the owner pushes again", await sync(owner), CLEAN);
	await arrives(friend, MOUNTED, "plan v4 from the owner\n");
	check(
		"the friend settles with both",
		[await sync(friend), await read(friend, "mine.md")],
		[CLEAN, "the friend's own\n"],
	);
}

/** Notices on screen now that mention storage. */
function storageNotices(device: Obsidian): Promise<string[]> {
	return device.evaluate(() =>
		[...activeDocument.querySelectorAll(".notice")]
			.map((notice) => notice.textContent ?? "")
			.filter((text) => /storage/i.test(text)),
	);
}
