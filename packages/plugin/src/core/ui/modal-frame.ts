import { type Modal, setIcon } from "obsidian";

export interface ModalHead {
	icon: string;
	title: string;
	sub?: string;
	tone?: "accent" | "danger";
}

/** Icon tile, title and a line under it; on a phone the window rises as a sheet. Returns that line for more parts. */
export function renderModalHead(
	modal: Modal,
	{ icon, title, sub, tone = "accent" }: ModalHead,
): HTMLElement {
	asDrawer(modal);
	const { modalEl, titleEl } = modal;
	if (!modalEl.hasClass("mdsync-modal")) watchTyping(modalEl);
	modalEl.addClass("mdsync-modal");
	titleEl.empty();
	titleEl.addClass("mdsync-modal-head");
	setIcon(titleEl.createSpan({ cls: `mdsync-modal-tile is-${tone}` }), icon);
	const text = titleEl.createDiv({ cls: "mdsync-modal-head-text" });
	text.createDiv({ cls: "mdsync-modal-name", text: title });
	const line = text.createDiv({ cls: "mdsync-modal-sub" });
	if (sub) line.createSpan({ text: sub });
	return line;
}

/** The phone keyboard leaves little room: while a field is typed in, the whole sheet scrolls. */
function watchTyping(modalEl: HTMLElement): void {
	// Read from the focus, not the events: WebKit sends no focusout for a field a redraw removes.
	const sync = (): void => {
		const focused = modalEl.doc.activeElement;
		modalEl.toggleClass(
			"is-typing",
			focused !== null &&
				modalEl.contains(focused) &&
				focused.matches('input:not([type="radio"]), textarea'),
		);
	};
	modalEl.addEventListener("focusin", sync);
	modalEl.addEventListener("focusout", () => modalEl.removeClass("is-typing"));
	new MutationObserver(sync).observe(modalEl, {
		childList: true,
		subtree: true,
	});
}

/** On a phone the window rises from the bottom as a sheet. */
export function asDrawer(modal: Modal): void {
	modal.modalEl.addClass("mdsync-drawer");
	modal.containerEl.addClass("mdsync-drawer-host");
}

/** A small capitals heading; returned for a count that changes or a control it names. */
export function modalSection(parent: HTMLElement, title: string): HTMLElement {
	return parent.createDiv({ cls: "mdsync-modal-section", text: title });
}

/** Hidden while empty, so a caller can fill it later. */
export function modalHint(parent: HTMLElement, text = ""): HTMLElement {
	return parent.createDiv({ cls: "mdsync-modal-hint", text });
}

export function modalWarning(parent: HTMLElement, text: string): HTMLElement {
	return parent.createDiv({ cls: "mdsync-modal-warning", text });
}

/** Rows of `.mdsync-modal-row` in one bordered card. */
export function modalCard(parent: HTMLElement): HTMLElement {
	return parent.createDiv({ cls: "mdsync-modal-card" });
}

/** Under the scrolling content. A leading destructive button stands apart on the left. */
export function modalFooter(modal: Modal): HTMLElement {
	return modal.modalEl.createDiv({
		cls: "modal-button-container mdsync-modal-footer",
	});
}
