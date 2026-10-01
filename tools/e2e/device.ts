/** What a scenario does to one Obsidian through the plugin, its menus and its modals. */

import type { Obsidian } from "./obsidian";

// biome-ignore lint/suspicious/noExplicitAny: the renderer's app is untyped here.
declare const app: any;
/** Obsidian mounts modals and notices here, which need not be `document`. */
declare const activeDocument: Document;

/** Modal helpers search the topmost modal first: an older one may still be open beneath. */

/** How long a modal step may take to render. */
const MODAL_WAIT_MS = 30_000;

/** What `sync` reports once a device has nothing left to move. */
export const CLEAN = { error: null, conflicts: 0, pendingLocal: 0, remote: 0 };

export async function loaded(device: Obsidian): Promise<void> {
	await device.waitFor(
		"plugin loaded",
		() => app.plugins.plugins.obsync.spaces !== undefined,
		Boolean,
	);
}

/** Waits for the plugin to finish loading, then sets its vault passphrase. */
export async function unlock(
	device: Obsidian,
	passphrase: string,
): Promise<void> {
	await loaded(device);
	await device.evaluate(
		(value) => app.plugins.plugins.obsync.passphrase.replacePassphrase(value),
		passphrase,
	);
}

/** A full sync, then a fresh compare to report what is left. */
export function sync(device: Obsidian): Promise<typeof CLEAN> {
	return device.evaluate(async () => {
		const { controller } = app.plugins.plugins.obsync;
		await controller.refreshAndAutoSync();
		await controller.refresh();
		const { error, conflicts, pendingLocal, pendingRemote } =
			controller.getSnapshot();
		return { error, conflicts, pendingLocal, remote: pendingRemote };
	});
}

export function read(device: Obsidian, path: string): Promise<string | null> {
	return device.evaluate(async (target) => {
		const file = app.vault.getFileByPath(target);
		return file ? app.vault.read(file) : null;
	}, path);
}

export function write(
	device: Obsidian,
	path: string,
	text: string,
): Promise<void> {
	return device.evaluate(
		([target, content]) =>
			app.vault.modify(app.vault.getFileByPath(target), content),
		[path, text],
	);
}

/** Right-clicks `folder` in the file explorer and picks the item titled `title`. */
export function clickMenuItem(
	device: Obsidian,
	folder: string,
	title: string,
): Promise<void> {
	return device.evaluate(
		([path, wanted]) => {
			const items: { title?: string; click?: () => void }[] = [];
			const menu = {
				addItem(build: (item: unknown) => void) {
					const item: { title?: string; click?: () => void } = {};
					const api: unknown = new Proxy(item, {
						get: (target, key) => (value: never) => {
							if (key === "setTitle") target.title = value;
							if (key === "onClick") target.click = value;
							return api;
						},
					});
					build(api);
					items.push(item);
					return menu;
				},
				addSeparator: () => menu,
			};
			app.workspace.trigger(
				"file-menu",
				menu,
				app.vault.getFolderByPath(path),
				"file-explorer",
			);
			const found = items.find((item) => item.title === wanted);
			if (!found?.click) throw new Error(`no "${wanted}" in the menu`);
			found.click();
		},
		[folder, title],
	);
}

/** Types into the open modal's setting named `name`, once it shows up. */
export function fill(
	device: Obsidian,
	name: string,
	value: string,
): Promise<void> {
	return device.evaluate(
		({ label, text, wait }) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + wait;
				const look = () => {
					const input = [
						...activeDocument.querySelectorAll(".modal .setting-item"),
					]
						.reverse()
						.find(
							(row) =>
								row.querySelector(".setting-item-name")?.textContent === label,
						)
						?.querySelector("input");
					if (input) {
						input.value = text;
						input.dispatchEvent(new Event("input"));
						return resolve();
					}
					if (Date.now() > deadline) {
						// What is on screen instead: the modal's text and any notices.
						const seen = [...activeDocument.querySelectorAll(".modal, .notice")]
							.map((el) => el.textContent)
							.join(" | ");
						return reject(new Error(`no "${label}"; on screen: ${seen}`));
					}
					setTimeout(look, 200);
				};
				look();
			}),
		{ label: name, text: value, wait: MODAL_WAIT_MS },
	);
}

/** Clicks the open modal's button with `text`, once it shows up. */
export function press(device: Obsidian, text: string): Promise<void> {
	return device.evaluate(
		({ label, wait }) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + wait;
				const look = () => {
					const button = [...activeDocument.querySelectorAll(".modal button")]
						.reverse()
						.find((each) => each.textContent === label);
					if (button instanceof HTMLButtonElement) {
						button.click();
						return resolve();
					}
					if (Date.now() > deadline) {
						// What is on screen instead: the modal's text and any notices.
						const seen = [...activeDocument.querySelectorAll(".modal, .notice")]
							.map((el) => el.textContent)
							.join(" | ");
						return reject(new Error(`no "${label}"; on screen: ${seen}`));
					}
					setTimeout(look, 200);
				};
				look();
			}),
		{ label: text, wait: MODAL_WAIT_MS },
	);
}

/** The value in the open modal's setting named `name`, once it shows up. */
export function field(device: Obsidian, name: string): Promise<string> {
	return device.evaluate(
		({ label, wait }) =>
			new Promise<string>((resolve, reject) => {
				const deadline = Date.now() + wait;
				const look = () => {
					const value = [
						...activeDocument.querySelectorAll(".modal .setting-item"),
					]
						.reverse()
						.find(
							(row) =>
								row.querySelector(".setting-item-name")?.textContent === label,
						)
						?.querySelector("input")?.value;
					if (value) return resolve(value);
					if (Date.now() > deadline) {
						// What is on screen instead: the modal's text and any notices.
						const seen = [...activeDocument.querySelectorAll(".modal, .notice")]
							.map((el) => el.textContent)
							.join(" | ");
						return reject(new Error(`no "${label}"; on screen: ${seen}`));
					}
					setTimeout(look, 200);
				};
				look();
			}),
		{ label: name, wait: MODAL_WAIT_MS },
	);
}

export async function openSettings(
	device: Obsidian,
	tab: string,
): Promise<void> {
	await device.evaluate(() => {
		app.setting.open();
		app.setting.openTabById("obsync");
	});
	await press(device, tab);
}

export function closeSettings(device: Obsidian): Promise<void> {
	return device.evaluate(() => app.setting.close());
}

/** Answers the confirm titled `<action> …` with its `action` button. */
export function confirm(device: Obsidian, action: string): Promise<void> {
	return device.evaluate(
		({ label, wait }) =>
			new Promise<void>((resolve, reject) => {
				const deadline = Date.now() + wait;
				const look = () => {
					const modal = [...activeDocument.querySelectorAll(".modal")].find(
						(each) =>
							each
								.querySelector(".modal-title")
								?.textContent?.startsWith(label),
					);
					const button = [...(modal?.querySelectorAll("button") ?? [])].find(
						(each) => each.textContent === label,
					);
					if (button instanceof HTMLButtonElement) {
						button.click();
						return resolve();
					}
					if (Date.now() > deadline) {
						return reject(new Error(`no "${label}" confirm`));
					}
					setTimeout(look, 200);
				};
				look();
			}),
		{ label: action, wait: MODAL_WAIT_MS },
	);
}

export function toggle(device: Obsidian, name: string): Promise<void> {
	return device.evaluate((label) => {
		const row = [...activeDocument.querySelectorAll(".modal .setting-item")]
			.reverse()
			.find(
				(each) =>
					each.querySelector(".setting-item-name")?.textContent === label,
			);
		const control = row?.querySelector(".checkbox-container");
		if (!(control instanceof HTMLElement))
			throw new Error(`no "${label}" toggle`);
		control.click();
	}, name);
}

/** Every modal, settings included; Escape per poll, as their close buttons ignore synthetic clicks. */
export async function closeModals(device: Obsidian): Promise<void> {
	await device.waitFor(
		"the modals closed",
		() => {
			activeDocument.body.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
			);
			return activeDocument.querySelectorAll(".modal").length;
		},
		(open: number) => open === 0,
	);
}
