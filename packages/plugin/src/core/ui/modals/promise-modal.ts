import type { Modal } from "obsidian";

/** The promise always settles, so a dismissed modal never leaves its caller waiting forever. */
export function openPromiseModal<T>(
	create: (answer: (value: T) => void) => Modal,
	dismissed: T,
): Promise<T> {
	return new Promise<T>((resolve) => {
		let settled = false;
		const settle = (value: T): void => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const modal = create(settle);
		const close = modal.onClose.bind(modal);
		modal.onClose = (): void => {
			close();
			settle(dismissed);
		};
		modal.open();
	});
}
