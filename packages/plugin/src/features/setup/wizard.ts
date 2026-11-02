import { Modal, Setting } from "obsidian";
import { asDrawer, renderKeepingFocus } from "@/core/ui";
import type { ESyncMode } from "./feature-choices";
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
import { createFeaturesStep } from "./steps/features-step";
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
	/** The preset picked on the Features step, null until then; one for every wizard of the launch. The Relay step reads it. */
	syncMode: ESyncMode | null;
	/** Join shows what the setup link brought; New, what this device starts with. */
	currentPath(): ESetupPath | null;
	/** `fromTop` when the step's content was replaced whole, not updated in place. */
	redraw(fromTop?: boolean): void;
	next(): void;
	/** Leaves a step found done with nothing asked: where this device stands if the wizard opened on it, else the next. */
	moveOn(): void;
	choose(path: ESetupPath): void;
	close(): void;
}

export interface StepView {
	render(el: HTMLElement): void;
	/** Goes back inside the step; false when it has nothing to undo. */
	back?(): boolean;
	blocksNext?(): boolean;
	/** The step's own button leads, so the footer's is not the accent one. */
	quietFooter?(): boolean;
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
	[ESetupStep.Features]: {
		label: "Features",
		icon: "sliders-horizontal",
		create: createFeaturesStep,
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

/** Shared by every wizard of a launch: a relay deploy outlives its wizard and asks the latest pick when it answers. */
let pickedSyncMode: ESyncMode | null = null;

class SetupWizardModal extends Modal implements Wizard {
	get syncMode(): ESyncMode | null {
		return pickedSyncMode;
	}
	set syncMode(mode: ESyncMode | null) {
		pickedSyncMode = mode;
	}
	private path: ESetupPath | null;
	private step: ESetupStep;
	private view: StepView;
	private opened = false;
	/** The step chosen by where this device stands, until the person moves. */
	private landing: ESetupStep | null;
	private stepper: Stepper | null = null;
	private bodyEl: HTMLElement | null = null;

	constructor(
		readonly plugin: SetupHost,
		step: ESetupStep,
		landed: boolean,
		private readonly onClosed: () => void,
	) {
		super(plugin.app);
		this.step = step;
		this.landing = landed ? step : null;
		this.path = pathOf(step, null);
		this.view = STEPS[step].create(this);
	}

	onOpen(): void {
		this.opened = true;
		this.titleEl.setText("Set up MDSync");
		this.modalEl.addClass("mdsync-setup");
		asDrawer(this);
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

	currentPath(): ESetupPath | null {
		return this.path;
	}

	redraw(fromTop = false): void {
		if (!this.opened || !this.stepper || !this.bodyEl) return;
		const body = this.bodyEl;
		this.stepper.update(this.stepperItems());
		renderKeepingFocus(body, () => this.draw(body));
		if (fromTop) this.contentEl.scrollTop = 0;
	}

	moveOn(): void {
		if (this.landing === this.step) this.go(firstStep(this.plugin));
		else this.next();
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
		this.landing = null;
		this.path = pathOf(step, this.path);
		this.step = step;
		this.view = STEPS[step].create(this);
		this.redraw(true);
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
		// Until the step is done its own button moves on; a bare disabled Next would not say why.
		if (!done || this.view.blocksNext?.() === true) return;
		footer.addButton((b) => {
			b.setButtonText(last ? "Done" : "Next").onClick(() => this.next());
			if (!this.view.quietFooter?.()) b.setCta();
		});
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
	current = new SetupWizardModal(
		plugin,
		step ?? firstStep(plugin),
		step === undefined,
		onClosed,
	);
	current.open();
}
