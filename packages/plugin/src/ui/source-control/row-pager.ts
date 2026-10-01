import { ButtonComponent } from "obsidian";

const PAGE_SIZE = 100;

export class RowPager {
	private page = 0;

	slice<T>(rows: readonly T[]): readonly T[] {
		this.page = Math.min(this.page, lastPage(rows.length));
		return rows.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE);
	}

	move(delta: number, count: number): void {
		this.page = Math.max(0, Math.min(this.page + delta, lastPage(count)));
	}

	render(parent: HTMLElement, count: number, changed: () => void): void {
		if (count <= PAGE_SIZE) return;
		const controls = parent.createDiv({ cls: "obsync-history-row-actions" });
		for (const [label, delta] of [
			["Previous page", -1],
			["Next page", 1],
		] as const) {
			new ButtonComponent(controls)
				.setButtonText(label)
				.setDisabled(
					delta < 0 ? this.page === 0 : this.page === lastPage(count),
				)
				.onClick(() => {
					this.move(delta, count);
					changed();
				});
		}
		controls.createSpan({
			cls: "obsync-history-row-meta",
			text: `${this.page * PAGE_SIZE + 1}-${Math.min((this.page + 1) * PAGE_SIZE, count)} of ${count}`,
		});
	}
}

function lastPage(count: number): number {
	return Math.max(0, Math.ceil(count / PAGE_SIZE) - 1);
}
