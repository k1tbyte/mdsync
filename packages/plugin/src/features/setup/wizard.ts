import { Modal, Setting } from "obsidian";
import { renderKeepingFocus } from "@/core/ui";
import type { SetupHost } from "./host";
import {
	ESetupPath,
	ESetupStep,
	firstStep,
	isStepDone,
	PATH_STEPS,
} from "./step-state";
import {
	createStepper,
	EStepState,
	type Stepper,
	type StepperItem,
	stepStates,
} from "./stepper";
import { createImportStep } from "./steps/import-step";
import { createPassphraseStep } from "./steps/passphrase-step";
import { createReadyStep } from "./steps/ready-step";
import { createRelayStep } from "./steps/relay-step";
import { createStartStep } from "./steps/start-step";
import { createStorageStep } from "./steps/storage-step";

export interface Wizard {
	readonly plugin: SetupHost;
	/** A late result moves on only from the step that is still on screen. */
	isShowing(view: StepView): boolean;
	/** Not `isOpen`: Obsidian's Modal already has that as a boolean field. */
	isLive(): boolean;
	redraw(): void;
	next(): void;
	choose(path: ESetupPath): void;
	close(): void;
}

export interface StepView {
	render(el: HTMLElement): void;
	/** Goes back inside the step; false when it has nothing to undo. */
	back?(): boolean;
	blocksNext?(): boolean;
}

interface StepSpec {
	label: string;
	icon: string;
	optional?: boolean;
	create(wizard: Wizard): StepView;
}

const STEPS: Record<ESetupStep, StepSpec> = {
	[ESetupStep.Start]: {
		label: "Start",
		icon: "sparkles",
		create: createStartStep,
	},
	[ESetupStep.Storage]: {
		label: "Storage",
		icon: "hard-drive",
		create: createStorageStep,
	},
	[ESetupStep.Passphrase]: {
		label: "Passphrase",
		icon: "key-round",
		create: createPassphraseStep,
	},
	[ESetupStep.Import]: {
		label: "Setup link",
		icon: "link",
		create: createImportStep,
	},
	[ESetupStep.Relay]: {
		label: "Relay",
		icon: "radio-tower",
		optional: true,
		create: createRelayStep,
	},
	[ESetupStep.Ready]: {
		label: "Sync",
		icon: "refresh-cw",
		create: createReadyStep,
	},
};

class SetupWizardModal extends Modal implements Wizard {
	private path: ESetupPath | null;
	private step: ESetupStep;
	private view: StepView;
	private opened = false;
	private stepper: Stepper | null = null;
	private bodyEl: HTMLElement | null = null;

	constructor(
		readonly plugin: SetupHost,
		step: ESetupStep,
		private readonly onClosed: () => void,
	) {
		super(plugin.app);
		this.step = step;
		this.path = pathOf(step, null);
		this.view = STEPS[step].create(this);
	}

	onOpen(): void {
		this.opened = true;
		this.titleEl.setText("Set up MDSync");
		this.modalEl.addClass("mdsync-setup");
		this.stepper = createStepper(this.contentEl);
		this.bodyEl = this.contentEl.createDiv();
		this.redraw();
	}

	onClose(): void {
		this.opened = false;
		this.stepper = null;
		this.bodyEl = null;
		this.contentEl.empty();
		if (current === this) current = null;
		this.onClosed();
	}

	isShowing(view: StepView): boolean {
		return this.opened && this.view === view;
	}

	isLive(): boolean {
		return this.opened;
	}

	redraw(): void {
		if (!this.opened || !this.stepper || !this.bodyEl) return;
		const body = this.bodyEl;
		this.stepper.update(this.stepperItems());
		renderKeepingFocus(body, () => this.draw(body));
	}

	next(): void {
		const steps = this.steps();
		const following = steps[steps.indexOf(this.step) + 1];
		if (following) this.go(following);
		else this.close();
	}

	choose(path: ESetupPath): void {
		this.path = path;
		this.go(PATH_STEPS[path][0] ?? ESetupStep.Ready);
	}

	go(step: ESetupStep): void {
		this.path = pathOf(step, this.path);
		this.step = step;
		this.view = STEPS[step].create(this);
		this.contentEl.scrollTop = 0;
		this.redraw();
	}

	private steps(): readonly ESetupStep[] {
		return this.path ? PATH_STEPS[this.path] : [];
	}

	private back(): void {
		if (this.view.back?.()) {
			this.redraw();
			return;
		}
		const steps = this.steps();
		this.go(steps[steps.indexOf(this.step) - 1] ?? ESetupStep.Start);
	}

	private draw(parent: HTMLElement): void {
		parent.empty();
		this.view.render(parent.createDiv({ cls: "mdsync-setup-body" }));
		this.drawFooter(parent);
	}

	private stepperItems(): StepperItem[] {
		const steps = this.steps();
		const states = stepStates(steps, this.step, (step) =>
			isStepDone(this.plugin, step),
		);
		return steps.map((step, index) => ({
			id: step,
			label: STEPS[step].label,
			icon: STEPS[step].icon,
			state: states[index] ?? EStepState.Ahead,
		}));
	}

	private drawFooter(parent: HTMLElement): void {
		const footer = new Setting(parent);
		footer.settingEl.addClass("mdsync-setup-footer");
		if (!this.path) {
			footer.addButton((b) =>
				b.setButtonText("Not now").onClick(() => this.close()),
			);
			return;
		}
		const steps = this.steps();
		const last = steps.indexOf(this.step) === steps.length - 1;
		const done = isStepDone(this.plugin, this.step);
		footer.addButton((b) => {
			b.setButtonText("Back").onClick(() => this.back());
			b.buttonEl.addClass("mdsync-setup-back");
		});
		if (STEPS[this.step].optional && !done) {
			footer.addButton((b) =>
				b.setButtonText("Skip").onClick(() => this.next()),
			);
		}
		footer.addButton((b) =>
			b
				.setButtonText(last ? "Done" : "Next")
				.setCta()
				.setDisabled(!done || this.view.blocksNext?.() === true)
				.onClick(() => this.next()),
		);
	}
}

/** The path a step belongs to, keeping the current one when it has the step. */
function pathOf(step: ESetupStep, path: ESetupPath | null): ESetupPath | null {
	if (step === ESetupStep.Start) return null;
	if (path && PATH_STEPS[path].includes(step)) return path;
	return step === ESetupStep.Import ? ESetupPath.Join : ESetupPath.New;
}

let current: SetupWizardModal | null = null;

export function closeSetupWizard(): void {
	current?.close();
}

/** One wizard at a time: asking again moves the open one to `step`. */
export function openSetupWizard(
	plugin: SetupHost,
	step: ESetupStep | undefined,
	onClosed: () => void,
): void {
	// Settings is a document of its own: a wizard left in another one is hidden, or went away with it.
	const shown = current?.containerEl;
	if (shown?.isConnected && shown.ownerDocument === activeDocument) {
		if (step) current?.go(step);
		return;
	}
	current?.close();
	current = new SetupWizardModal(plugin, step ?? firstStep(plugin), onClosed);
	current.open();
}
