/**
 * Live editing in a shared folder, in real Obsidians: the owner and a
 * participant type into one note of the share, each at its own path, in the
 * share's room on the owner's relay; a sync afterwards is no conflict. What
 * one changes shows as new in the other's tree until opened.
 */

import { CLEAN, clickMenuItem, closeModals, read, sync, write } from "./device";
import { converged, open, textOn, type } from "./editor";
import { check, poll } from "./harness";
import type { Obsidian } from "./obsidian";
import { accept, invite, mounted, runSharing, shareFolder } from "./sharing";

const PLAN = "Team/plan.md";
const MOUNTED = "Shared/Team/plan.md";
const NOTES = "Team/notes.md";
/** Long enough to scroll any window: the followed cursor goes down it. */
const FOLLOWED = "a line to follow\n".repeat(80);

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;

await runSharing(
	"live share e2e",
	{ owner: { [PLAN]: "plan v1\n", [NOTES]: "notes v1\n" }, friend: {} },
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
		check(
			"the friend sees the owner in the note without opening it",
			await friend.waitFor(
				"the owner in the note",
				() =>
					app.plugins.plugins.obsync.realtime.people
						.inNote("Shared/Team/plan.md")
						.map((person: { name: string }) => person.name),
				(names) => names.length > 0,
			),
			["Owner"],
		);
		check(
			"the friend's tree shows the owner on the note and a headcount on the share",
			await friend.waitFor(
				"tree presence",
				() => {
					const rows =
						app.workspace.getLeavesOfType("file-explorer")[0].view.fileItems;
					for (const folder of ["Shared", "Shared/Team"]) {
						if (rows[folder].collapsed) rows[folder].setCollapsed(false, false);
					}
					const note = rows["Shared/Team/plan.md"].selfEl;
					const root = rows["Shared/Team"].selfEl;
					return [
						note.querySelector(".obsync-people-badge .obsync-avatar")
							?.textContent,
						root.querySelector(".obsync-share-badge.is-joined")?.textContent,
					];
				},
				([face, count]) => face === "O" && count === "1",
			),
			["O", "1"],
		);
		await friend.shot(
			"tree-presence",
			".workspace-leaf-content[data-type='file-explorer']",
		);
		check(
			"a collapsed folder gathers the people inside it",
			await friend.waitFor(
				"people on the collapsed folder",
				() => {
					const rows =
						app.workspace.getLeavesOfType("file-explorer")[0].view.fileItems;
					rows["Shared/Team"].setCollapsed(true, false);
					return rows["Shared/Team"].selfEl.querySelector(
						".obsync-people-badge .obsync-avatar",
					)?.textContent;
				},
				(face) => face === "O",
			),
			"O",
		);
		await friend.shot(
			"tree-collapsed",
			".workspace-leaf-content[data-type='file-explorer']",
		);
		check(
			"the owner's tree marks the folder as shared by them",
			await owner.waitFor(
				"owned share badge",
				() =>
					Boolean(
						app.workspace
							.getLeavesOfType("file-explorer")[0]
							.view.fileItems.Team.selfEl.querySelector(
								".obsync-share-badge.is-owned",
							),
					),
				(marked) => marked,
			),
			true,
		);
		await open(friend, MOUNTED);
		check(
			"the owner's header shows the friend in a live note",
			await owner.waitFor(
				"header presence",
				() => {
					const header = app.workspace
						.getLeavesOfType("markdown")[0]
						.view.containerEl.querySelector(".obsync-note-presence");
					return [
						header?.querySelector(".obsync-live-dot")?.className,
						[...(header?.querySelectorAll(".obsync-avatar") ?? [])].map(
							(face) => face.textContent,
						),
					];
				},
				([dot, faces]) => dot === "obsync-live-dot is-live" && faces.length > 0,
			),
			["obsync-live-dot is-live", ["F"]],
		);
		await clickMenuItem(owner, "Team", "Obsync: Manage sharing");
		check(
			"the owner's share window lists the friend here, in the note",
			await owner.waitFor(
				"the friend in the share window",
				() =>
					[...document.querySelectorAll(".obsync-share-modal .setting-item")]
						.map((row) => row.textContent ?? "")
						.find((text) => text.includes("In plan.md")),
				// Present people show first; their access follows from the broker.
				(row) => row?.endsWith("Revoke") === true,
			),
			"FFriendCan edit - In plan.mdRevoke",
		);
		await owner.shot("share-window", ".obsync-share-modal");
		await closeModals(owner);
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
		await owner.shot(
			"header-presence",
			".workspace-leaf.mod-active .view-header",
		);
		await owner.shot("status-bar", ".status-bar");
		// y-codemirror moves a cursor only while its window has focus, which typing here never gives.
		await friend.evaluate(() => {
			const end = { type: null, tname: "body", item: null, assoc: 0 };
			app.plugins.plugins.obsync.realtime.live
				.roomOf("Shared/Team/plan.md")
				.awareness.setLocalStateField("cursor", { anchor: end, head: end });
		});
		await owner.waitFor(
			"the friend's cursor at the end",
			() =>
				[
					...app.plugins.plugins.obsync.realtime.live
						.roomOf("Team/plan.md")
						.awareness.getStates()
						.values(),
				].some(
					(state) =>
						state.user?.name === "Friend" && state.cursor?.head.item === null,
				),
			(there) => there,
		);
		check(
			"the owner's scrollbar marks the friend's cursor",
			await owner.waitFor(
				"the scrollbar mark",
				() =>
					app.workspace
						.getLeavesOfType("markdown")[0]
						.view.containerEl.querySelector(".obsync-scroll-mark")
						?.getAttribute("aria-label"),
				(name) => name === "Friend",
			),
			"Friend",
		);
		await owner.shot("scroll-marks", ".workspace-leaf.mod-active");
		if (process.env.E2E_SHOTS) {
			await owner.evaluate(() =>
				app.workspace
					.getLeavesOfType("markdown")[0]
					.view.containerEl.querySelector(".obsync-note-presence")
					.click(),
			);
			await owner.shot("header-menu", ".menu");
			await owner.evaluate(() =>
				document.body.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
				),
			);
		}
		check(
			"follow cursor puts the owner where the friend is",
			await owner.evaluate(() => {
				const { editor, containerEl } =
					app.workspace.getLeavesOfType("markdown")[0].view;
				editor.setCursor(editor.offsetToPos(0));
				containerEl.querySelector(".obsync-note-presence").click();
				const item = [...document.querySelectorAll(".menu .menu-item")].find(
					(each) => each.textContent?.includes("follow cursor"),
				) as HTMLElement | undefined;
				if (!item) throw new Error("no follow cursor in the header menu");
				item.click();
				return (
					editor.posToOffset(editor.getCursor()) === editor.getValue().length
				);
			}),
			true,
		);
		await follows(owner, friend);
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

		await friend.evaluate(() =>
			app.workspace.getLeavesOfType("markdown")[0].detach(),
		);
		check(
			"closing the note takes the friend out of it",
			await owner.waitFor(
				"the friend gone from the note",
				() =>
					app.plugins.plugins.obsync.realtime.people.inNote("Team/plan.md")
						.length,
				(count) => count === 0,
			),
			0,
		);

		await write(friend, "Shared/Team/notes.md", "notes by the friend\n");
		check("the friend pushes a note", await sync(friend), CLEAN);
		check("the owner pulls it", await sync(owner), CLEAN);
		check(
			"the owner's tree marks the note new, by the friend",
			await owner.waitFor(
				"the new dot",
				() => {
					const rows =
						app.workspace.getLeavesOfType("file-explorer")[0].view.fileItems;
					if (rows.Team.collapsed) rows.Team.setCollapsed(false, false);
					return rows["Team/notes.md"].selfEl
						.querySelector(".obsync-unseen-dot")
						?.getAttribute("aria-label");
				},
				(label) => label !== undefined,
			),
			"Changed by Friend, just now",
		);
		await owner.shot(
			"tree-unseen",
			".workspace-leaf-content[data-type='file-explorer']",
		);
		await open(owner, NOTES);
		check(
			"opening it clears the dot",
			await owner.waitFor(
				"the dot gone",
				() =>
					app.workspace
						.getLeavesOfType("file-explorer")[0]
						.view.fileItems["Team/notes.md"].selfEl.querySelector(
							".obsync-unseen-dot",
						) === null,
				(gone) => gone,
			),
			true,
		);
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

/** The owner follows the friend's cursor down a long insert, until the owner scrolls. */
async function follows(owner: Obsidian, friend: Obsidian): Promise<void> {
	const block = (add: boolean) =>
		friend.evaluate(
			({ add, long }) => {
				const { editor } = app.workspace.getLeavesOfType("markdown")[0].view;
				const end = editor.getValue().length;
				if (add) {
					editor.replaceRange(long, editor.offsetToPos(end));
					// As a typist's caret: after the text, in the editor and in the room.
					const last = editor.offsetToPos(editor.getValue().length);
					editor.setCursor(last);
					const head = { type: null, tname: "body", item: null, assoc: 0 };
					app.plugins.plugins.obsync.realtime.live
						.roomOf("Shared/Team/plan.md")
						.awareness.setLocalStateField("cursor", { anchor: head, head });
				} else {
					editor.replaceRange(
						"",
						editor.offsetToPos(end - long.length),
						editor.offsetToPos(end),
					);
				}
			},
			{ add, long: FOLLOWED },
		);
	const states = () =>
		owner.evaluate(() => {
			const { containerEl } = app.workspace.getLeavesOfType("markdown")[0].view;
			containerEl.querySelector(".obsync-note-presence").click();
			const found = [
				...document.querySelectorAll(".menu .obsync-person-state"),
			];
			document.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
			return found.map((each) => each.textContent);
		});
	await block(true);
	check(
		"following, the owner's view goes where the friend types",
		(await owner.waitFor(
			"the owner's view scrolled",
			() =>
				app.workspace.getLeavesOfType("markdown")[0].view.editor.cm.scrollDOM
					.scrollTop,
			(top: number) => top > 0,
		)) > 0,
		true,
	);
	check("the menu says whom the owner follows", await states(), ["following"]);
	await owner.evaluate(() =>
		app.workspace
			.getLeavesOfType("markdown")[0]
			.view.contentEl.dispatchEvent(new Event("wheel")),
	);
	check("the owner's own scroll ends it", await states(), ["follow cursor"]);
	await block(false);
	await converged(owner, friend);
}
