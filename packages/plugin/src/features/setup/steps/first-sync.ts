import { setIcon } from "obsidian";
import { pluralize } from "@/core/shared";
import { alertLine, callout } from "@/core/ui";
import type { Conflict, DiffResult, SyncStatusSnapshot } from "@/features/sync";
import { actionRow, busyLine } from "../form";
import type { Wizard } from "../wizard";

const EPhase = {
	Idle: "idle",
	Comparing: "comparing",
	Compared: "compared",
	Syncing: "syncing",
	Synced: "synced",
} as const;
type EPhase = (typeof EPhase)[keyof typeof EPhase];

export interface FirstSync {
	/** Compares once: moves nothing, so the step can show what a sync would do. */
	start(): void;
	/** Compared or synced with nothing left to move. */
	done(): boolean;
	/** Its own button leads: something is left to move or to choose. */
	leads(): boolean;
	render(el: HTMLElement): void;
}

export function createFirstSync(wizard: Wizard): FirstSync {
	const { plugin } = wizard;
	const { controller } = plugin;
	let phase: EPhase = EPhase.Idle;

	const track = async (next: EPhase, run: () => Promise<void>) => {
		const unsubscribe = controller.subscribe(() => wizard.redraw());
		try {
			await run();
		} finally {
			unsubscribe();
			phase = next;
			wizard.redraw(true);
		}
	};

	const compare = (): void => {
		phase = EPhase.Comparing;
		wizard.redraw();
		void track(EPhase.Compared, () => controller.refresh());
	};

	/** The scheduled sync's own cycle: merges what it can, pulls, pushes, and leaves the rest for Changes. */
	const sync = (): void => {
		phase = EPhase.Syncing;
		wizard.redraw();
		void track(EPhase.Synced, () => controller.refreshAndAutoSync());
	};

	const openChanges = (): void => {
		wizard.close();
		void plugin.openChanges();
	};

	const renderFailed = (el: HTMLElement, snapshot: SyncStatusSnapshot) => {
		if (snapshot.error) alertLine(el).setText(snapshot.error);
		for (const { root, message } of snapshot.spaceErrors) {
			alertLine(el).setText(`Error in "${root}": ${message}`);
		}
		// A cancelled passphrase prompt ends the compare with neither an error nor a result.
		if (!snapshot.error && snapshot.spaceErrors.length === 0) {
			alertLine(el).setText("The comparison did not finish.");
		}
		actionRow(el).addButton((b) =>
			b.setButtonText("Try again").onClick(compare),
		);
	};

	const renderPreview = (el: HTMLElement, snapshot: SyncStatusSnapshot) => {
		const { pendingLocal, pendingRemote, conflicts } = snapshot;
		const open = snapshot.result?.diff.conflicts ?? [];
		const synced = phase === EPhase.Synced;
		const held =
			snapshot.result !== null &&
			syncHeld(snapshot.result.diff, (path) => controller.spaceFor(path).id);
		el.createDiv({
			cls: "mdsync-setup-note",
			text: !synced
				? "MDSync compared this vault with the storage. Nothing has moved yet."
				: conflicts > 0
					? "Files changed on both sides hold the sync until you choose."
					: "What is left waits for you in Changes.",
		});
		const counts = el.createEl("ul", { cls: "mdsync-sync-counts" });
		count(counts, "arrow-up", pendingLocal, "to upload", "changed only here");
		count(
			counts,
			"arrow-down",
			pendingRemote,
			"to download",
			"from your other devices",
		);
		count(
			counts,
			"triangle-alert",
			conflicts,
			conflicts === 1 ? "conflict" : "conflicts",
			"changed on both sides",
		).toggleClass("is-conflict", conflicts > 0);
		if (open.length > 0) {
			callout(el, "warning", conflictText(open, synced || held));
		}
		const actions = actionRow(el);
		if (synced || held) {
			actions.addButton((b) =>
				b
					.setButtonText(conflicts > 0 ? "Choose in Changes" : "Open changes")
					.setCta()
					.onClick(openChanges),
			);
			return;
		}
		actions.addButton((b) =>
			b.setButtonText("See the files").onClick(openChanges),
		);
		const files = pendingLocal + pendingRemote + conflicts;
		actions.addButton((b) =>
			b
				.setButtonText(`Sync ${pluralize(files, "file")}`)
				.setCta()
				.onClick(sync),
		);
	};

	return {
		start() {
			if (phase !== EPhase.Idle) return;
			// Called while the step renders: the busy line is drawn by that render, not a nested one.
			phase = EPhase.Comparing;
			void track(EPhase.Compared, () => controller.refresh());
		},
		done() {
			if (phase !== EPhase.Compared && phase !== EPhase.Synced) return false;
			const snapshot = controller.getSnapshot();
			return (
				!failed(snapshot) &&
				snapshot.pendingLocal + snapshot.pendingRemote + snapshot.conflicts ===
					0
			);
		},
		leads() {
			return phase !== EPhase.Idle && !this.done();
		},
		render(el) {
			const snapshot = controller.getSnapshot();
			el.createEl("h3", { text: headingOf(phase, snapshot) });
			if (phase === EPhase.Idle || phase === EPhase.Comparing) {
				busyLine(el, "Comparing this vault with the storage…");
				return;
			}
			if (phase === EPhase.Syncing) {
				busyLine(el, snapshot.progressText ?? "Syncing…");
				return;
			}
			if (failed(snapshot)) {
				renderFailed(el, snapshot);
				return;
			}
			renderPreview(el, snapshot);
		},
	};
}

/**
 * Nothing a sync would move: a conflict holds its own space only (`sync/runtime/auto-cycle.ts`), and one
 * without a common version never merges, so every pending file sits in a space held that way.
 */
export function syncHeld(
	diff: DiffResult,
	spaceOf: (path: string) => string,
): boolean {
	const held = new Set<string>();
	for (const { path, baselineHash } of diff.conflicts) {
		if (baselineHash !== null) return false;
		held.add(spaceOf(path));
	}
	return (
		held.size > 0 &&
		[...diff.localChanges, ...diff.remoteChanges].every(({ path }) =>
			held.has(spaceOf(path)),
		)
	);
}

/** No result without an error means the compare never ran, as when the passphrase prompt was cancelled. */
function failed(snapshot: SyncStatusSnapshot): boolean {
	return (
		Boolean(snapshot.error) ||
		snapshot.spaceErrors.length > 0 ||
		snapshot.result === null
	);
}

function count(
	list: HTMLElement,
	icon: string,
	value: number,
	label: string,
	hint: string,
): HTMLElement {
	const item = list.createEl("li", { cls: "mdsync-sync-count" });
	item.toggleClass("is-zero", value === 0);
	const head = item.createDiv({ cls: "mdsync-sync-count-value" });
	setIcon(head.createSpan({ cls: "mdsync-sync-count-icon" }), icon);
	head.createSpan({ text: String(value) });
	item.createDiv({ cls: "mdsync-sync-count-label", text: label });
	item.createDiv({ cls: "mdsync-sync-count-hint", text: hint });
	return item;
}

function headingOf(phase: EPhase, snapshot: SyncStatusSnapshot): string {
	if (phase !== EPhase.Synced) return "First sync";
	return snapshot.conflicts > 0
		? "Waiting for your choice"
		: "Not everything synced";
}

/** `final`: nothing merges them on its own any more, so only a choice moves the sync on. */
function conflictText(conflicts: readonly Conflict[], final: boolean): string {
	const names = namesOf(conflicts);
	const verb = conflicts.length === 1 ? "is" : "are";
	return final
		? `${names} ${verb} different here and in the storage. Choose which version to keep in Changes; nothing syncs until then.`
		: `${names} changed here and in the storage. Notes whose changes do not overlap merge on their own; anything else holds the sync until you choose in Changes.`;
}

/** Up to three paths, then how many more. */
function namesOf(conflicts: readonly Conflict[]): string {
	const shown = conflicts.slice(0, 3).map(({ path }) => path);
	const rest = conflicts.length - shown.length;
	if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
	if (shown.length === 1) return shown[0] ?? "";
	return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}
