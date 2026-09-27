/**
 * Live editing in a shared folder, in real Obsidians: the owner and a
 * participant type into one note of the share, each at its own path, in the
 * share's room on the owner's relay; a sync afterwards is no conflict.
 */

import { CLEAN, read, sync } from "./device";
import { converged, open, textOn, type } from "./editor";
import { check, poll } from "./harness";
import type { Obsidian } from "./obsidian";
import { accept, invite, mounted, runSharing, shareFolder } from "./sharing";

const PLAN = "Team/plan.md";
const MOUNTED = "Shared/Team/plan.md";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runSharing(
	"live share e2e",
	{ owner: { [PLAN]: "plan v1\n" }, friend: {} },
	async (owner, friend, s3) => {
		const id = await shareFolder(owner, s3, "Team");
		await accept(friend, await invite(owner, "Team", "Friend"));
		check(
			"the friend pulls the share",
			await mounted(friend, MOUNTED),
			"plan v1\n",
		);
		check("the friend settles", await sync(friend), CLEAN);

		await open(owner, PLAN);
		await open(friend, MOUNTED);
		check(
			"both join the share's room, not their vault's",
			[await roomSpace(owner, PLAN), await roomSpace(friend, MOUNTED)],
			[id, id],
		);

		await type(owner, "end", "typed by the owner\n");
		check(
			"the friend sees the owner type",
			await textOn(friend, (text) => text.includes("typed by the owner")),
			"plan v1\ntyped by the owner\n",
		);
		await Promise.all([
			type(owner, "start", "AAAA "),
			type(friend, "end", "BBBB\n"),
		]);
		const together = await converged(owner, friend);
		check(
			"concurrent typing keeps both sides",
			[together.startsWith("AAAA plan"), together.endsWith("BBBB\n")],
			[true, true],
		);
		check(
			"each sees the other's cursor",
			await friend.waitFor(
				"remote cursor",
				() =>
					app.plugins.plugins.obsync.realtime.live
						.roomOf("Shared/Team/plan.md")
						?.awareness.getStates().size,
				(size) => size === 2,
			),
			2,
		);

		check(
			"the owner sees the friend's cursor under the name it was invited by",
			await owner.waitFor(
				"remote cursor name",
				() =>
					app.workspace
						.getLeavesOfType("markdown")[0]
						.view.editor.cm.contentDOM.querySelector(".cm-ySelectionInfo")
						?.textContent,
				(name) => name === "Friend",
			),
			"Friend",
		);
		await friend.evaluate(() =>
			app.commands.executeCommandById("obsync:toggle-live-authors"),
		);
		const tinted = await friend.waitFor(
			"the owner's text tinted",
			() =>
				[
					...app.workspace
						.getLeavesOfType("markdown")[0]
						.view.editor.cm.contentDOM.querySelectorAll('[title="Owner"]'),
				]
					.map((span) => span.textContent)
					.join(""),
			(text) => text.includes("typed by the owner"),
		);
		check(
			"authors shown: only the owner's text is tinted for the friend",
			[tinted.includes("AAAA"), tinted.includes("BBBB")],
			[true, false],
		);

		await Promise.all([
			saved(owner, PLAN, together),
			saved(friend, MOUNTED, together),
		]);
		check("the owner pushes the room's text", await sync(owner), CLEAN);
		check("the friend's copy is no conflict", await sync(friend), CLEAN);
	},
);

function roomSpace(device: Obsidian, path: string): Promise<string | null> {
	return device.evaluate(
		(target) => app.plugins.plugins.obsync.realtime.live.spaceOf(target),
		path,
	);
}

function saved(device: Obsidian, path: string, text: string): Promise<true> {
	return poll(`${path} saved`, async () =>
		(await read(device, path)) === text ? true : undefined,
	);
}
