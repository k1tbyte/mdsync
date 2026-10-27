import { SettingPage } from "obsidian";

export function imperativePage(
	title: string,
	render: (el: HTMLElement, refresh: () => void) => void,
): SettingPage {
	return new (class extends SettingPage {
		constructor() {
			super();
			this.title = title;
			this.containerEl.addClass("mdsync-settings");
		}

		display(): void {
			const scrollTop = this.rootEl.scrollTop;
			this.containerEl.empty();
			render(this.containerEl, () => this.display());
			this.rootEl.scrollTop = scrollTop;
		}
	})();
}
