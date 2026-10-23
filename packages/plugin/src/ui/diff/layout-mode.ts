import { randomId } from "@/crypto";
import { renderSegments, type Segments } from "@/ui/common";

const COMBINED_BELOW_PX = 900;

/** Automatic below a width, or forced from a toolbar button while there is room for both layouts. */
export class LayoutMode {
	private readonly control: Segments;
	private readonly observer: ResizeObserver;
	private forceCombined = false;
	private current = false;

	constructor(
		private readonly root: HTMLElement,
		toolbar: HTMLElement,
		private readonly onLayout: (combined: boolean, changed: boolean) => void,
	) {
		this.control = renderSegments(
			toolbar,
			`layout-${randomId()}`,
			[
				{ value: false, text: "Side by side" },
				{ value: true, text: "Inline" },
			],
			() => this.current,
			(combined) => {
				this.forceCombined = combined;
				this.refresh();
			},
		);
		this.control.el.addClasses(["is-compact", "mdsync-layout-btn"]);
		this.observer = new ResizeObserver(() => this.refresh());
		this.observer.observe(root);
	}

	get combined(): boolean {
		return this.current;
	}

	refresh(): void {
		const auto = this.root.clientWidth < COMBINED_BELOW_PX;
		const combined = this.forceCombined || auto;
		this.root.toggleClass("is-combined", combined);
		this.control.el.hidden = auto;
		const changed = combined !== this.current;
		this.current = combined;
		this.control.refresh();
		this.onLayout(combined, changed);
	}

	destroy(): void {
		this.observer.disconnect();
	}
}
