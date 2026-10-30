import { keymap } from "@codemirror/view";
import { setIcon } from "obsidian";
import { appendIconButton } from "@/core/ui";

export function changeNavigation(jump: (delta: number) => void) {
	return keymap.of(
		["F7", "Shift-F7"].map((key, index) => ({
			key,
			run: () => {
				jump(index === 0 ? 1 : -1);
				return true;
			},
		})),
	);
}

/** The change `delta` away, wrapping round; from none selected (-1), forward is the first and back the last. */
export function stepIndex(current: number, delta: number, total: number) {
	if (total === 0) return -1;
	if (current < 0) return delta > 0 ? 0 : total - 1;
	return (current + delta + total) % total;
}

/** Arrows with the position between them, in one box so a narrow bar can drop it whole. */
export function renderChangeNav(
	parent: HTMLElement,
	jump: (delta: number) => void,
): (current: number, total: number) => void {
	const nav = parent.createDiv({ cls: "mdsync-compare-nav" });
	nav.createSpan({ cls: "mdsync-diff-separator" });
	const arrows = [
		appendIconButton(nav, "chevron-up", "Previous change", () => jump(-1)),
	];
	const label = nav.createSpan({ cls: "mdsync-compare-position" });
	arrows.push(
		appendIconButton(nav, "chevron-down", "Next change", () => jump(1)),
	);
	return (current, total) => {
		for (const arrow of arrows) arrow.hidden = total < 2;
		const all = `${total} ${total === 1 ? "change" : "changes"}`;
		label.setText(total < 2 || current < 0 ? all : `${current + 1} / ${total}`);
	};
}

/** One icon button beside a change, in a divider or a source block header. */
export interface RailAction {
	icon: string;
	label: string;
	shortLabel?: string;
	run(): void;
	/** A pending choice that Apply will carry out. */
	active?: boolean;
	cls?: string;
}

export function renderRailButton(
	parent: HTMLElement,
	action: RailAction,
): HTMLButtonElement {
	const button = parent.createEl("button", {
		cls: ["mdsync-rail-btn", ...(action.cls ? [action.cls] : [])],
	});
	button.type = "button";
	button.setAttr("aria-label", action.label);
	if (action.active !== undefined) {
		button.setAttr("aria-pressed", String(action.active));
	}
	button.toggleClass("is-active", action.active === true);
	if (action.icon) setIcon(button, action.icon);
	if (action.shortLabel) {
		button.addClass("has-label");
		button.createSpan({ cls: "mdsync-rail-label", text: action.shortLabel });
	}
	// Inside CodeMirror a mousedown would move the caret and steal focus.
	button.addEventListener("mousedown", (event) => event.preventDefault());
	button.addEventListener("click", (event) => {
		event.preventDefault();
		event.stopPropagation();
		action.run();
	});
	return button;
}
