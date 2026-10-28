import { ButtonComponent } from "obsidian";

const PAGE_SIZE = 100;

export class RowPager {
	private page = 0;
	/** The button just used: the controls are redrawn with the page, so focus moves to the new ones. */
	private refocus: string | null = null;

	slice<T>(rows: readonly T[]): readonly T[] {
		this.page = Math.min(this.page, lastPage(rows.length));
		return rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
	}

	move(delta: number, count: number): void {
		this.page = Math.max(0, Math.min(this.page + delta, lastPage(count)));
	}

	render(parent: HTMLElement, count: number, changed: () => void): void {
		if (count <= PAGE_SIZE) return;
		const controls = parent.createDiv({ cls: "mdsync-history-row-actions" });
		const buttons = new Map<string, ButtonComponent>();
		for (const [label, delta] of [
			["Previous page", -1],
			["Next page", 1],
		] as const) {
			const button = new ButtonComponent(controls)
				.setButtonText(label)
				.setDisabled(
					delta < 0 ? this.page === 0 : this.page === lastPage(count),
				)
				.onClick(() => {
					this.move(delta, count);
					this.refocus = label;
					changed();
				});
			buttons.set(label, button);
		}
		if (this.refocus) {
			const used = buttons.get(this.refocus);
			const target = used?.disabled
				? [...buttons.values()].find((button) => !button.disabled)
				: used;
			target?.buttonEl.focus({ preventScroll: true });
			this.refocus = null;
		}
		controls.createSpan({
			cls: "mdsync-history-row-meta",
			text: `${this.page * PAGE_SIZE + 1}-${Math.min((this.page + 1) * PAGE_SIZE, count)} of ${count}`,
		});
	}
}

function lastPage(count: number): number {
	return Math.max(0, Math.ceil(count / PAGE_SIZE) - 1);
}
