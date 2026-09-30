import { vi } from "vitest";

import type { Person } from "@/presence/people";
import type { Participant } from "@/storage";
import {
	type ShareAccess,
	ShareModal,
	type ShareWindow,
} from "@/ui/shares/share-modal";
import { FakeEl, type FakeModal } from "./fake-obsidian-dom";

export const ALICE: Participant = { id: "a", label: "Alice", readOnly: false };
export const BEA: Participant = { id: "b", label: "Bea", readOnly: true };
export const CY: Participant = { id: "c", label: "Cy", readOnly: false };

export const person = (
	key: string,
	name: string,
	note: string | null = null,
): Person => ({ key, name, note, idle: false });

export const settle = () =>
	new Promise<void>((resolve) => setTimeout(resolve, 0));

export function stubDom(): void {
	vi.stubGlobal("createFragment", () => new FakeEl("fragment"));
}

export function ownerAccess(people: Participant[] = [ALICE, BEA, CY]) {
	return {
		people: vi.fn(async () => people),
		revoke: vi.fn(async () => true),
		invite: vi.fn(async () => ({
			link: "obsidian://link",
			password: "pw-123",
		})),
	} satisfies ShareAccess;
}

export function makeShare(overrides: Partial<ShareWindow> = {}) {
	const listeners = new Set<() => void>();
	const unsubscribe = vi.fn();
	const share: ShareWindow = {
		name: "Team",
		summary: 'Yours, in "Team".',
		warning: null,
		here: () => [],
		note: () => null,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				unsubscribe();
			};
		},
		openNote: vi.fn(),
		access: null,
		paused: null,
		setPaused: vi.fn(async () => {}),
		closeLabel: "Stop sharing",
		close: vi.fn(async () => true),
		onClosed: vi.fn(),
		...overrides,
	};
	return { share, listeners, unsubscribe };
}

export async function open(
	share: ShareWindow,
): Promise<ShareModal & FakeModal> {
	const modal = new ShareModal({} as never, share) as ShareModal & FakeModal;
	modal.open();
	await settle();
	return modal;
}

export const buttons = (root: FakeEl, text?: string) =>
	root.find(
		(el) => el.tag === "button" && (text === undefined || el.text === text),
	);

export function button(modal: FakeModal, text: string): FakeEl {
	const found = buttons(modal.modalEl, text)[0];
	if (!found) throw new Error(`no "${text}" button`);
	return found;
}

export const list = (modal: FakeModal) =>
	modal.contentEl.find((el) => el.hasClass("obsync-share-access"))[0] as FakeEl;

export const rows = (modal: FakeModal) =>
	list(modal)
		.find((el) => el.hasClass("setting-item"))
		.map((row) => ({
			name: row
				.find((el) => el.tag === "span" && !el.hasClass("obsync-avatar"))
				.at(-1)?.text,
			detail: row.find((el) => el.hasClass("setting-item-description"))[0]
				?.text,
			actions: buttons(row).map((el) => el.text || el.attrs.get("aria-label")),
		}));

export const notes = (modal: FakeModal) =>
	list(modal)
		.children.filter((el) => el.tag === "p")
		.map((el) => el.text);
