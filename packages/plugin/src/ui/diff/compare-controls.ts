import { ButtonComponent, setIcon } from "obsidian";
import type { EDiffDirection } from "@/sync/projection";
import { appendIconButton } from "@/ui/common";
import {
	CHOICE_ICON,
	choiceVerb,
	EChoiceKind,
	type HunkChoices,
} from "./choices";
import { renderCounters } from "./source-widget";

const CONTEXT: Record<EDiffDirection, string> = {
	local: "since the last sync",
	remote: "incoming",
	conflict: "with the incoming version",
	history: "against this version",
};
const HINT: Record<EDiffDirection, string> = {
	local:
		"Select a change to push or revert it. Nothing changes until you apply.",
	remote: "Select a change to pull it. Nothing changes until you apply.",
	conflict: "Select a change to accept it, or settle the whole file.",
	history: "Select a change to restore it. Nothing changes until you apply.",
};

export interface CompareHosts {
	info: HTMLElement;
	controls: HTMLElement;
	pending: HTMLElement;
}

/** Detached panel-owned content survives shell re-renders. */
export class CompareControls {
	readonly info = createSpan({ cls: "mdsync-compare-info" });
	readonly controls = createDiv({ cls: "mdsync-compare-controls" });
	readonly pending = createDiv({ cls: "mdsync-compare-pending" });
	private label: HTMLElement | null = null;
	private arrows: HTMLButtonElement[] = [];
	private pin: HTMLButtonElement | null = null;

	mount(hosts: CompareHosts): void {
		hosts.info.appendChild(this.info);
		hosts.controls.appendChild(this.controls);
		hosts.pending.appendChild(this.pending);
	}

	/** Keeps the buttons of chosen changes on the strip; off leaves only the selected change's. */
	pinToggle(enabled: boolean, change: (enabled: boolean) => void): void {
		const pin = appendIconButton(
			this.controls,
			"pin",
			"Keep buttons on chosen changes",
			() => {
				enabled = !enabled;
				show();
				change(enabled);
			},
		);
		const show = (): void => {
			pin.toggleClass("is-active", enabled);
			pin.setAttr("aria-pressed", String(enabled));
		};
		show();
		this.pin = pin;
	}

	/** The inline layout has no strip, so nothing to pin. */
	showPin(visible: boolean): void {
		if (this.pin) this.pin.hidden = !visible;
	}

	navigation(jump: (delta: number) => void): void {
		// One box, so a narrow bar can drop it whole.
		const nav = this.controls.createDiv({ cls: "mdsync-compare-nav" });
		nav.createSpan({ cls: "mdsync-diff-separator" });
		const previous = appendIconButton(
			nav,
			"chevron-up",
			"Previous change",
			() => jump(-1),
		);
		this.label = nav.createSpan({ cls: "mdsync-compare-position" });
		const next = appendIconButton(nav, "chevron-down", "Next change", () =>
			jump(1),
		);
		this.arrows = [previous, next];
	}

	update(
		counts: {
			added: number;
			removed: number;
			changes: number;
			current: number;
		},
		direction: EDiffDirection,
		actionable: boolean,
		choices: HunkChoices,
		discard: () => void,
		apply: () => void,
	): void {
		const { added, removed, changes, current } = counts;
		const changeText = `${changes} ${changes === 1 ? "change" : "changes"}`;
		this.info.empty();
		renderCounters(this.info, { added, removed });
		this.info.createSpan({
			cls: "mdsync-compare-context",
			text: `· ${changeText} ${CONTEXT[direction]}`,
		});
		for (const arrow of this.arrows) arrow.hidden = changes < 2;
		this.label?.setText(
			changes < 2
				? "1 change"
				: current < 0
					? changeText
					: `${current + 1} / ${changes}`,
		);
		this.pending.empty();
		this.pending.toggleClass("has-pending", choices.size > 0);
		for (const kind of Object.values(EChoiceKind)) {
			const count = choices.count(kind);
			if (count === 0) continue;
			const chip = this.pending.createSpan({
				cls: `mdsync-pending-kind is-${kind}`,
			});
			setIcon(chip, CHOICE_ICON[kind]);
			chip.appendText(`${count} to ${choiceVerb(direction, kind)}`);
		}
		if (actionable)
			this.pending.createSpan({
				cls: "mdsync-diff-hint",
				text: HINT[direction],
			});
		if (choices.size === 0) return;
		const buttons = this.pending.createDiv({
			cls: "mdsync-compare-choice-actions",
		});
		new ButtonComponent(buttons)
			.setButtonText("Discard choices")
			.onClick(discard);
		new ButtonComponent(buttons)
			.setButtonText(
				`Apply ${choices.size} ${choices.size === 1 ? "change" : "changes"}`,
			)
			.setCta()
			.onClick(apply);
	}
}
