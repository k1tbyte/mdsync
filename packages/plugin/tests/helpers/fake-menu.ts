export interface FakeItem {
	title: unknown;
	icon?: string;
	label: boolean;
	disabled: boolean;
	checked?: boolean;
	click?: () => void;
}

export class FakeMenu {
	static shown: FakeMenu[] = [];
	items: FakeItem[] = [];
	separators = 0;
	at: { position: unknown; doc: unknown } | null = null;

	addItem(build: (item: unknown) => void): this {
		const entry: FakeItem = { title: "", label: false, disabled: false };
		const item = {
			setTitle(title: unknown) {
				entry.title = title;
				return item;
			},
			setIcon(icon: string) {
				entry.icon = icon;
				return item;
			},
			setIsLabel(label: boolean) {
				entry.label = label;
				return item;
			},
			setDisabled(disabled: boolean) {
				entry.disabled = disabled;
				return item;
			},
			setChecked(checked: boolean) {
				entry.checked = checked;
				return item;
			},
			onClick(click: () => void) {
				entry.click = click;
				return item;
			},
		};
		build(item);
		this.items.push(entry);
		return this;
	}

	addSeparator(): this {
		this.separators++;
		return this;
	}

	showAtPosition(position: unknown, doc?: unknown): this {
		this.at = { position, doc };
		FakeMenu.shown.push(this);
		return this;
	}
}

interface FakeFragment {
	texts: string[];
	createSpan(options: { text?: string }): FakeFragment;
	setCssProps(): void;
	toggleClass(): void;
}

export function fragment(): FakeFragment {
	const texts: string[] = [];
	const node: FakeFragment = {
		texts,
		createSpan(options) {
			if (options.text) texts.push(options.text);
			return node;
		},
		setCssProps() {},
		toggleClass() {},
	};
	return node;
}

export function titleOf({ title }: FakeItem): string[] {
	return typeof title === "string" ? [title] : (title as FakeFragment).texts;
}
