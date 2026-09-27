/**
 * Someone else's share, in real Obsidians: the owner shares a folder and
 * invites through the relay's broker; a participant with a vault of their own
 * opens the link, and edits cross both ways without the participant ever
 * holding the owner's storage credentials. Neither side syncs by hand to get
 * the other's edit: a push signals the share's channel on the owner's relay.
 */

import { CLEAN, read, sync, write } from "./device";
import { check } from "./harness";
import type { Obsidian } from "./obsidian";
import type { S3 } from "./s3";
import {
	accept,
	arrives,
	closeFromSettings,
	invite,
	mounted,
	runSharing,
	shareFolder,
	spaceErrors,
	vaultHash,
} from "./sharing";

const PLAN = "Team/plan.md";
const MOUNTED = "Shared/Team/plan.md";
const REJOINED = "Rejoined/Team/plan.md";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runSharing(
	"invite e2e",
	{
		owner: { [PLAN]: "plan v1\n", "notes.md": "the owner's own\n" },
		friend: { "mine.md": "the friend's own\n" },
	},
	async (owner, friend, s3) => {
		await editsCross(owner, friend, s3);
		await rejoin(owner, friend);
		await shareCloses(owner, friend, s3);
	},
);

async function editsCross(
	owner: Obsidian,
	friend: Obsidian,
	s3: S3,
): Promise<void> {
	const id = await shareFolder(owner, s3, "Team");
	const sent = await invite(owner, "Team", "Friend");
	check(
		"the invite goes through the relay",
		sent.link.startsWith("obsidian://obsync-share?d="),
		true,
	);

	await accept(friend, sent);
	check(
		"the friend pulls the share into its folder",
		await mounted(friend, MOUNTED),
		"plan v1\n",
	);
	check("the friend settles", await sync(friend), CLEAN);

	await write(friend, MOUNTED, "plan v2 from the friend\n");
	check("the friend pushes into the share", await sync(friend), CLEAN);
	await arrives(owner, PLAN, "plan v2 from the friend\n");
	check("the owner settles", await sync(owner), CLEAN);

	await write(owner, PLAN, "plan v3 from the owner\n");
	check("the owner pushes", await sync(owner), CLEAN);
	await arrives(friend, MOUNTED, "plan v3 from the owner\n");
	check("the friend settles", await sync(friend), CLEAN);

	const keys = s3.keys();
	check(
		"each keeps its own vault; the share stays in the owner's bucket prefix",
		[
			await read(friend, "notes.md"),
			await read(owner, "mine.md"),
			keys.includes(`friend/spaces/${id}.json.enc`),
			keys.some((key) => key.startsWith("friend/shares/")),
		],
		[null, null, true, false],
	);
	check(
		"the friend never holds the owner's credentials",
		await friend.evaluate(() =>
			JSON.stringify(app.plugins.plugins.obsync.settings).includes(
				'"secretAccessKey":"owner"',
			),
		),
		false,
	);
}

/**
 * The friend leaves while the share goes on, which kills their token; invited
 * again, they open it into another folder: this device's old state of the
 * share must not read the new, empty folder as every file deleted.
 */
async function rejoin(owner: Obsidian, friend: Obsidian): Promise<void> {
	await closeFromSettings(friend, "Leave");
	check("the friend syncs after leaving", await sync(friend), CLEAN);
	check(
		"the friend keeps the folder in its own vault",
		[await read(friend, MOUNTED), (await vaultHash(friend, MOUNTED)) !== null],
		["plan v3 from the owner\n", true],
	);
	check("leaving revoked the friend's token", await brokerStatus(friend), 401);

	await accept(friend, await invite(owner, "Team", "Friend"), "Rejoined/Team");
	check(
		"the friend pulls the share again, into the new folder",
		await mounted(friend, REJOINED),
		"plan v3 from the owner\n",
	);
	check("the friend settles again", await sync(friend), CLEAN);
}

/**
 * The owner stops sharing, which deletes the share's objects: the friend's
 * vault syncs on and names the lost share; the friend leaves it, and both keep the folder in their own vault.
 */
async function shareCloses(
	owner: Obsidian,
	friend: Obsidian,
	s3: S3,
): Promise<void> {
	const frozen = await vaultHash(owner, PLAN);
	await closeFromSettings(owner, "Stop sharing");
	check("the owner syncs the folder with its vault", await sync(owner), CLEAN);
	check(
		"the share's objects are gone from the owner's bucket",
		s3.keys().some((key) => key.startsWith("owner/shares/")),
		false,
	);
	check(
		"the owner's vault takes the folder's newest text",
		(await vaultHash(owner, PLAN)) !== frozen,
		true,
	);

	await write(friend, "mine.md", "the friend's own, edited\n");
	check(
		"the friend's vault syncs past the lost share",
		await sync(friend),
		CLEAN,
	);
	check("the lost share is named", await spaceErrors(friend), [
		["Rejoined/Team", "This shared folder's invite is no longer valid."],
	]);

	await closeFromSettings(friend, "Leave");
	check(
		"the friend syncs the folder with its vault",
		await sync(friend),
		CLEAN,
	);
	check(
		"the friend keeps the rejoined folder in its own vault",
		(await vaultHash(friend, REJOINED)) !== null,
		true,
	);
}

/** What the broker answers the friend's (only) share token now. */
async function brokerStatus(friend: Obsidian): Promise<number> {
	const { relayUrl, token } = await friend.evaluate(
		() => app.plugins.plugins.obsync.settings.spaces[0].access,
	);
	const res = await fetch(`${relayUrl}/share/sign`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ op: "get", key: "manifest.json.enc" }),
	});
	return res.status;
}
