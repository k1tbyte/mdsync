import { type App, ButtonComponent, setIcon } from "obsidian";
import { openPluginSettings } from "@/core/hub";
import { OFFLINE_MESSAGE } from "@/core/shared";
import { callout } from "@/core/ui";

interface StateAction {
	text: string;
	cta?: boolean;
	run: () => void;
}

export interface EmptyStateSpec {
	icon: string;
	title: string;
	text: string;
	tone?: "accent" | "muted" | "success";
	action?: StateAction;
}

/** A tab with nothing to list: a centred icon, a title and a line. */
export function renderEmptyState(
	parent: HTMLElement,
	spec: EmptyStateSpec,
): HTMLElement {
	const el = parent.createDiv({
		cls: `mdsync-empty-state is-${spec.tone ?? "accent"}`,
	});
	setIcon(el.createSpan({ cls: "mdsync-empty-state-icon" }), spec.icon);
	el.createDiv({ cls: "mdsync-empty-state-title", text: spec.title });
	el.createDiv({ cls: "mdsync-empty-state-desc", text: spec.text });
	if (spec.action) stateButton(el, spec.action);
	return el;
}

export function renderLoadError(
	parent: HTMLElement,
	title: string,
	error: string,
	retry: () => void,
): void {
	if (error === OFFLINE_MESSAGE) {
		renderEmptyState(parent, {
			icon: "cloud-off",
			tone: "muted",
			title: "You're offline",
			text: "This loads once the connection is back.",
			action: { text: "Try again", run: retry },
		});
		return;
	}
	stateButton(callout(parent, "error", error, title), {
		text: "Try again",
		run: retry,
	});
}

/** A spinner over rows shaped like the ones coming. */
export function renderLoading(parent: HTMLElement): void {
	const el = parent.createDiv({ cls: "mdsync-tab-loading" });
	el.setAttr("aria-busy", "true");
	el.createDiv({ cls: "mdsync-tab-loading-line", text: "Loading…" });
	for (let i = 0; i < 5; i++) el.createDiv({ cls: "mdsync-skeleton-row" });
}

export function renderHistoryOff(
	parent: HTMLElement,
	app: App,
	text: string,
): void {
	renderEmptyState(parent, {
		icon: "timer-off",
		tone: "muted",
		title: "History is off",
		text,
		action: { text: "Open settings", run: () => openPluginSettings(app) },
	});
}

function stateButton(parent: HTMLElement, action: StateAction): void {
	const button = new ButtonComponent(parent)
		.setButtonText(action.text)
		.onClick(action.run);
	if (action.cta) button.setCta();
}
