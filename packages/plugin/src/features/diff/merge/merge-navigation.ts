import { EditorView } from "@codemirror/view";
import { isResolved, type MergeChange } from "@/features/sync";
import { spanBounds } from "../lines/geometry";
import type { PaneScrollSync } from "../lines/scroll-sync";
import { snapToLines } from "./edit-plan";

export interface NavigationHost {
	result(): EditorView | null;
	changes(): readonly MergeChange[];
	/** Side by side the panes scroll together; inline, null, and Result scrolls alone. */
	paneSync(): PaneScrollSync | null;
	/** Raises the change on both strips and shows its position. */
	onSelect(index: number): void;
}

/** Which change is selected, and moving between changes. */
export class MergeNavigation {
	/** The selected change, or -1. */
	current = -1;

	constructor(private readonly host: NavigationHost) {}

	select(index: number): void {
		this.current = index;
		this.host.onSelect(index);
	}

	jump(delta: number): void {
		const total = this.host.changes().length;
		if (total === 0) return;
		let next = (this.current + delta + total) % total;
		if (this.current < 0) next = delta > 0 ? 0 : total - 1;
		this.reveal(next);
	}

	/** The next unresolved change after the selected one, wrapping round. */
	nextConflict(): void {
		const changes = this.host.changes();
		const total = changes.length;
		for (let step = 1; step <= total; step++) {
			const index = (Math.max(this.current, -1) + step) % total;
			const change = changes[index];
			if (change && !isResolved(change)) {
				this.reveal(index);
				return;
			}
		}
	}

	private reveal(index: number): void {
		const view = this.host.result();
		const target = this.host.changes()[index];
		if (!view || !target) return;
		// The strips show its buttons, so the keyboard reaches them with Tab.
		this.select(index);
		const sync = this.host.paneSync();
		view.dispatch({
			selection: { anchor: target.result.from },
			effects: sync
				? []
				: EditorView.scrollIntoView(target.result.from, { y: "center" }),
		});
		if (sync) {
			const span = snapToLines(view.state.doc, target.result);
			sync.revealIn(view, spanBounds(view, span).top);
		}
		view.focus();
	}
}
