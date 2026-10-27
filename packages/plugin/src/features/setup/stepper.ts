import { setIcon } from "obsidian";

export const EStepState = {
	Done: "done",
	Current: "current",
	/** Passed without finishing: an optional step left out. */
	Skipped: "skipped",
	Ahead: "ahead",
} as const;
export type EStepState = (typeof EStepState)[keyof typeof EStepState];

/** Only a step before the current one can be done or skipped. */
export function stepStates<T>(
	steps: readonly T[],
	current: T,
	isDone: (step: T) => boolean,
): EStepState[] {
	const at = steps.indexOf(current);
	return steps.map((step, index) => {
		if (index === at) return EStepState.Current;
		if (index > at) return EStepState.Ahead;
		return isDone(step) ? EStepState.Done : EStepState.Skipped;
	});
}

export interface StepperItem {
	id: string;
	label: string;
	icon: string;
	state: EStepState;
}

export interface Stepper {
	update(items: readonly StepperItem[]): void;
}

/** Keeps its elements between updates, so a step reached fills in by CSS transition instead of reappearing. */
export function createStepper(parent: HTMLElement): Stepper {
	const list = parent.createEl("ol", {
		cls: "mdsync-stepper",
		attr: { "aria-label": "Setup steps" },
	});
	let shown = "";
	return {
		update(items) {
			list.toggleClass("is-hidden", items.length === 0);
			const ids = items.map((item) => item.id).join();
			if (ids !== shown) {
				shown = ids;
				list.empty();
				items.forEach((item, index) => {
					buildStep(list, item, index);
				});
			}
			items.forEach((item, index) => {
				const step = list.children[index];
				if (step instanceof HTMLElement) paintStep(step, item);
			});
		},
	};
}

function buildStep(list: HTMLElement, item: StepperItem, index: number): void {
	const step = list.createEl("li", { cls: "mdsync-step" });
	step.setCssProps({ "--mdsync-step-index": String(index) });
	const dot = step.createSpan({ cls: "mdsync-step-dot" });
	dot.setAttr("aria-hidden", "true");
	setIcon(dot.createSpan({ cls: "mdsync-step-icon" }), item.icon);
	setIcon(dot.createSpan({ cls: "mdsync-step-check" }), "check");
	step.createSpan({ cls: "mdsync-step-label", text: item.label });
}

const STATE_SPOKEN: Partial<Record<EStepState, string>> = {
	[EStepState.Done]: "done",
	[EStepState.Skipped]: "skipped",
	[EStepState.Ahead]: "upcoming",
};

function paintStep(step: HTMLElement, item: StepperItem): void {
	step.className = `mdsync-step is-${item.state}`;
	if (item.state !== EStepState.Ahead) step.addClass("is-reached");
	if (item.state === EStepState.Current) step.setAttr("aria-current", "step");
	else step.removeAttribute("aria-current");
	// The check mark is hidden from screen readers, so the state is spoken here.
	const spoken = STATE_SPOKEN[item.state];
	if (spoken) step.setAttr("aria-label", `${item.label}, ${spoken}`);
	else step.removeAttribute("aria-label");
}
