export interface Segments {
	el: HTMLElement;
	refresh(): void;
}

let groups = 0;

/** Native radios keep arrow-key navigation; saving locks the whole choice. */
export function renderSegments<T>(
	parent: HTMLElement,
	name: string,
	options: readonly { value: T; text: string }[],
	current: () => T,
	choose: (value: T) => void | Promise<void>,
	labelledBy?: string,
): Segments {
	const group = parent.createDiv({
		cls: "mdsync-segments",
		attr: { role: "radiogroup" },
	});
	if (labelledBy) group.setAttr("aria-labelledby", labelledBy);
	// Radios of one name share a document: two windows of one choice would uncheck each other.
	const radioName = `${name}-${++groups}`;
	const inputs = options.map(({ value, text }) => {
		const label = group.createEl("label", { cls: "mdsync-segment" });
		const input = label.createEl("input", {
			type: "radio",
			attr: { name: radioName },
		});
		label.createSpan({ text });
		input.addEventListener("change", async () => {
			for (const each of inputs) each.disabled = true;
			try {
				await choose(value);
			} finally {
				for (const each of inputs) each.disabled = false;
				refresh();
				// Disabling drops keyboard focus; do not steal it back from another control.
				if (activeDocument.activeElement === activeDocument.body) {
					inputs.find((each) => each.checked)?.focus();
				}
			}
		});
		return input;
	});
	const refresh = (): void => {
		const now = current();
		options.forEach(({ value }, i) => {
			const input = inputs[i];
			if (input) input.checked = value === now;
		});
	};
	refresh();
	return { el: group, refresh };
}
