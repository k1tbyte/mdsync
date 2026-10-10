import { Modal, Setting } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { renderKeepingFocus } from "@/ui/common";

import { createImportStep } from "./import-step";
import { createPassphraseStep } from "./passphrase-step";
import { createReadyStep } from "./ready-step";
import { createRelayStep } from "./relay-step";
import { createStartStep } from "./start-step";
import {
	ESetupPath,
	ESetupStep,
	firstStep,
	isStepDone,
	PATH_STEPS,
} from "./steps";
import { createStorageStep } from "./storage-step";

export interface Wizard {
	readonly plugin: PluginHost;
	/** A late result moves on only from the step that is still on screen. */
	isShowing(view: StepView): boolean;
	redraw(): void;
	next(): void;
	choose(path: ESetupPath): void;
	close(): void;
}

export interface StepView {
	render(el: HTMLElement): void;
	/** Goes back inside the step; false when it has nothing to undo. */
	back?(): boolean;
}

interface StepSpec {
	label: string;
	optional?: boolean;
	create(wizard: Wizard): StepView;
}

const STEPS: Record<ESetupStep, StepSpec> = {
	[ESetupStep.Start]: { label: "Start", create: createStartStep },
	[ESetupStep.Storage]: { label: "Storage", create: createStorageStep },
	[ESetupStep.Passphrase]: {
		label: "Passphrase",
		create: createPassphraseStep,
	},
	[ESetupStep.Import]: { label: "Setup link", create: createImportStep },
	[ESetupStep.Relay]: {
		label: "Relay",
		optional: true,
		create: createRelayStep,
	},
	[ESetupStep.Ready]: { label: "Sync", create: createReadyStep },
};

class SetupWizardModal extends Modal implements Wizard {
	private path: ESetupPath | null;
	private step: ESetupStep;
	private view: StepView;
	private opened = false;

	constructor(
		readonly plugin: PluginHost,
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
		this.redraw();
	}

	onClose(): void {
		this.opened = false;
		this.contentEl.empty();
		if (current === this) current = null;
		this.onClosed();
	}

	isShowing(view: StepView): boolean {
		return this.opened && this.view === view;
	}

	redraw(): void {
		if (!this.opened) return;
		renderKeepingFocus(this.contentEl, () => this.draw());
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

	private draw(): void {
		const { contentEl } = this;
		contentEl.empty();
		if (this.path) this.drawStepper(contentEl);
		this.view.render(contentEl.createDiv({ cls: "mdsync-setup-body" }));
		this.drawFooter(contentEl);
	}

	private drawStepper(parent: HTMLElement): void {
		const list = parent.createEl("ol", { cls: "mdsync-setup-steps" });
		const steps = this.steps();
		const at = steps.indexOf(this.step);
		steps.forEach((step, index) => {
			const item = list.createEl("li", { text: STEPS[step].label });
			if (index === at) {
				item.addClass("is-current");
				item.setAttr("aria-current", "step");
			} else if (index < at && isStepDone(this.plugin, step)) {
				item.addClass("is-done");
			}
		});
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
		footer.addButton((b) => b.setButtonText("Back").onClick(() => this.back()));
		if (STEPS[this.step].optional && !done) {
			footer.addButton((b) =>
				b.setButtonText("Skip").onClick(() => this.next()),
			);
		}
		footer.addButton((b) =>
			b
				.setButtonText(last ? "Done" : "Next")
				.setCta()
				.setDisabled(!done)
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

/** One wizard at a time: asking again moves the open one to `step`. */
export function openSetupWizard(
	plugin: PluginHost,
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
