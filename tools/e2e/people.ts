/**
 * Who can open a share, in real Obsidians: a read-only friend's edits stay on
 * their device without an error; inviting the same name again replaces their
 * link, so the old one dies; the owner's new S3 key reaches the relay with no
 * new invite; the owner lists people and revokes one.
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
import { check, poll } from "./harness";
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
} from "./sharing";

const PLAN = "Team/plan.md";
const MOUNTED = "Shared/Team/plan.md";
const EDITING = "Edit/Team/plan.md";
const REVOKED = "This shared folder's invite is no longer valid.";

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
		const plugin = app.plugins.plugins.obsync;
		Object.assign(plugin.settings.storageConfigs.s3, {
			accessKeyId: "owner-2",
			secretAccessKey: "owner-2",
		});
		await plugin.saveSettings();
	});
	s3.revoke("owner");
	check("the owner syncs with the new key", await sync(owner), CLEAN);
	await write(friend, EDITING, "plan v3 after the new key\n");
	// The owner's device sends the new key after its refresh, without waiting on it.
	await poll("the friend pushes through the new key", async () => {
		const state = await sync(friend);
		return state.error === null && state.pendingLocal === 0 ? true : undefined;
	});
	await arrives(owner, PLAN, "plan v3 after the new key\n");
}

async function readOnly(owner: Obsidian, friend: Obsidian): Promise<void> {
	await accept(friend, await invite(owner, "Team", "Friend", true));
	check(
		"the reader pulls the share",
		await mounted(friend, MOUNTED),
		"plan v1\n",
	);
	await friend.evaluate(async (target) => {
		await app.workspace
			.getLeaf(false)
			.openFile(app.vault.getFileByPath(target));
	}, MOUNTED);
	check(
		"the reader's editor is locked, with a lock in its header",
		await friend.waitFor(
			"the locked editor",
			() => {
				const { view } = app.workspace.getLeavesOfType("markdown")[0];
				return [
					view.editor.cm.state.readOnly,
					view.editor.cm.contentDOM.contentEditable,
					Boolean(view.containerEl.querySelector(".obsync-note-lock")),
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

/** The same name, any case: one person, whose old link dies. */
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
	await closeFromSettings(friend, "Leave");
	await accept(friend, again, "Edit/Team");
	check(
		"the new link pulls the share",
		await mounted(friend, EDITING),
		"plan v1\n",
	);
	await write(friend, EDITING, "plan v2 from the friend\n");
	check("the friend pushes with the new link", await sync(friend), CLEAN);
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
		["Edit/Team", REVOKED],
	]);
}

/** Opens the share's window from the settings (unless open) and reads who has access once loaded, as [name, access]. */
async function people(owner: Obsidian): Promise<string[][]> {
	const open = await owner.evaluate(
		() => activeDocument.querySelector(".obsync-share-access") !== null,
	);
	if (!open) {
		await openSettings(owner, "Sync");
		await press(owner, "Manage");
	}
	return poll("the people", () =>
		owner.evaluate(() => {
			const list = activeDocument.querySelector(".obsync-share-access");
			if (!list || list.textContent?.includes("Loading…")) return undefined;
			return [...list.querySelectorAll(".setting-item")].map((row) => [
				row.querySelector(".setting-item-name span:not(.obsync-avatar)")
					?.textContent ?? "",
				// The role, without whether they are here now.
				row
					.querySelector(".setting-item-description")
					?.textContent?.split(",")[0] ?? "",
			]);
		}),
	);
}
