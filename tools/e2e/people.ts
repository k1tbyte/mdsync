/**
 * Who can open a share, in real Obsidians: read-only followers, re-invites replacing a link, a new S3 key
 * reaching the relay, listing and revoking.
 */

import {
	CLEAN,
	closeModals,
	confirm,
	openSettings,
	press,
	read,
	sync,
	write,
} from "./device";
import { open, textOn, type } from "./editor";
import { check, poll } from "./harness";
import type { Obsidian } from "./obsidian";
import type { S3 } from "./s3";
import {
	accept,
	arrives,
	invite,
	mounted,
	renew,
	runSharing,
	shareFolder,
	spaceErrors,
} from "./sharing";

const PLAN = "Team/plan.md";
const MOUNTED = "Shared/Team/plan.md";
const REVOKED = "This shared folder's invite is no longer valid.";
const TYPED = "typed live\n";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
declare const activeDocument: Document;

await runSharing(
	"people e2e",
	{ owner: { [PLAN]: "plan v1\n" }, friend: { "mine.md": "mine\n" } },
	async (owner, friend, s3) => {
		await shareFolder(owner, s3, "Team");
		await readOnly(owner, friend);
		await inviteAgain(owner, friend);
		await rotate(owner, friend, s3);
		await revoke(owner, friend);
	},
);

/** The owner swaps S3 keys and deletes the old one; the friend keeps working. */
async function rotate(
	owner: Obsidian,
	friend: Obsidian,
	s3: S3,
): Promise<void> {
	await owner.evaluate(async () => {
		const plugin = app.plugins.plugins.mdsync;
		Object.assign(plugin.settings.storageConfigs.s3, {
			accessKeyId: "owner-2",
			secretAccessKey: "owner-2",
		});
		await plugin.saveSettings();
	});
	s3.revoke("owner");
	check("the owner syncs with the new key", await sync(owner), CLEAN);
	await write(friend, MOUNTED, "plan v3 after the new key\n");
	// The owner's device sends the new key after its refresh, without waiting on it.
	await pushes(friend, "the friend pushes through the new key");
	await arrives(owner, PLAN, "plan v3 after the new key\n");
}

async function readOnly(owner: Obsidian, friend: Obsidian): Promise<void> {
	await accept(friend, await invite(owner, "Team", "Friend", true));
	check(
		"the reader pulls the share",
		await mounted(friend, MOUNTED),
		"plan v1\n",
	);
	await follows(owner, friend);
	check(
		"the reader's editor is locked, with a lock in its header",
		await friend.waitFor(
			"the locked editor",
			() => {
				const { view } = app.workspace.getLeavesOfType("markdown")[0];
				return [
					view.editor.cm.state.readOnly,
					view.editor.cm.contentDOM.contentEditable,
					Boolean(view.containerEl.querySelector(".mdsync-note-lock")),
				];
			},
			([readOnly, editable, lock]) =>
				readOnly === true && editable === "false" && lock === true,
		),
		[true, "false", true],
	);
	await friend.shot("read-only", ".workspace-leaf.mod-active");

	await write(friend, MOUNTED, "the reader's edit\n");
	await write(friend, "mine.md", "mine, edited\n");
	check(
		"the reader's own vault syncs; the share edit waits, with no error",
		[await sync(friend), await spaceErrors(friend)],
		[{ ...CLEAN, pendingLocal: 1 }, []],
	);
	check("the owner syncs", await sync(owner), CLEAN);
	check(
		"the owner's folder is untouched",
		await read(owner, PLAN),
		"plan v1\n",
	);
}

/** The reader's open note follows the room: the owner's typing shows with no sync. */
async function follows(owner: Obsidian, friend: Obsidian): Promise<void> {
	await open(owner, PLAN);
	await open(friend, MOUNTED);
	await type(owner, "end", TYPED);
	check(
		"the reader sees the owner type, with no sync",
		await textOn(friend, (text) => text.endsWith(TYPED)),
		`plan v1\n${TYPED}`,
	);
	await friend.shot("read-only-live", ".workspace-leaf.mod-active");
	await owner.evaluate(async () => {
		const [leaf] = app.workspace.getLeavesOfType("markdown");
		leaf.view.editor.setValue("plan v1\n");
		await leaf.view.save();
		leaf.detach();
	});
	check(
		"the owner's revert reaches the reader",
		await textOn(friend, (text) => text === "plan v1\n"),
		"plan v1\n",
	);
}

/** The same name, any case: one person, whose old link dies and whose new one takes over their folder. */
async function inviteAgain(owner: Obsidian, friend: Obsidian): Promise<void> {
	const again = await invite(owner, "Team", "friend");
	check("the owner sees one person, now editing", await people(owner), [
		["friend", "Can edit"],
	]);
	await closeModals(owner);

	check("the friend syncs past the dead link", await sync(friend), CLEAN);
	check("the dead link is named", await spaceErrors(friend), [
		["Shared/Team", REVOKED],
	]);
	await renew(friend, again);
	// Now an editor: the edit the reader left waiting goes up, on the same
	// baseline, once the room of the note it has open agrees.
	await pushes(friend, "the new link takes over the folder");
	check("the friend settles on the new link", await sync(friend), CLEAN);
	await arrives(owner, PLAN, "the reader's edit\n");
	await write(friend, MOUNTED, "plan v2 from the friend\n");
	// The note it has open went live with the link: its room must agree first.
	await pushes(friend, "the friend pushes with the new link");
	await arrives(owner, PLAN, "plan v2 from the friend\n");
}

async function revoke(owner: Obsidian, friend: Obsidian): Promise<void> {
	await people(owner);
	await press(owner, "Revoke");
	await confirm(owner, "Revoke");
	// The list reloads after the revoke; wait for it rather than read the old one.
	await poll("nobody is left", async () =>
		(await people(owner)).length === 0 ? true : undefined,
	);
	await closeModals(owner);

	check("the friend syncs past the revoked share", await sync(friend), CLEAN);
	check("the revoked share is named", await spaceErrors(friend), [
		["Shared/Team", REVOKED],
	]);
}

/** Syncs until nothing waits, as a push can wait on its room or a new key. */
async function pushes(device: Obsidian, label: string): Promise<void> {
	await poll(label, async () => {
		const state = await sync(device);
		return state.error === null && state.pendingLocal === 0 ? true : undefined;
	});
}

/** Opens the share's window from the settings (unless open) and reads who has access once loaded, as [name, access]. */
async function people(owner: Obsidian): Promise<string[][]> {
	const open = await owner.evaluate(
		() => activeDocument.querySelector(".mdsync-share-access") !== null,
	);
	if (!open) {
		await openSettings(owner, "Sync");
		await press(owner, "Manage");
	}
	return poll("the people", () =>
		owner.evaluate(() => {
			const list = activeDocument.querySelector(".mdsync-share-access");
			if (!list || list.textContent?.includes("Loading…")) return undefined;
			return [...list.querySelectorAll(".setting-item")].map((row) => [
				row.querySelector(".setting-item-name span:not(.mdsync-avatar)")
					?.textContent ?? "",
				// The role, without where they are now.
				row
					.querySelector(".setting-item-description")
					?.textContent?.split(" - ")[0] ?? "",
			]);
		}),
	);
}
