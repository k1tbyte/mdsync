import { type Plugin, setIcon } from "obsidian";

import type { PluginHost } from "@/plugin/host";
import { canSync } from "@/settings/model";
import { formatRelativeTime, pluralize } from "@/shared";
import type { SyncStatusSnapshot } from "@/sync/controller";
import { makeActivatable } from "./common/activatable";
import { mountRelayStatus } from "./live/status/relay-status";
import { openStatusMenu, syncHeadline } from "./status-menu";

/**
 * One item: where sync stands, then the relay and who is in shared notes; selecting it opens their menu.
 * Returns a repaint for what no snapshot announces, such as finishing setup.
 */
export function registerStatusBar(plugin: Plugin & PluginHost): () => void {
	const { controller } = plugin;
	const root = plugin.addStatusBarItem();
	root.addClass("mdsync-status-bar", "mod-clickable");
	makeActivatable(root, null, () => openStatusMenu(plugin, root));
	const sync = root.createSpan({ cls: "mdsync-status-sync" });
	const relay = root.createSpan({ cls: "mdsync-status-relay mdsync-hidden" });
	// Each half has its own tooltip; the button's name is both, or it would hide them.
	const name = (): void => {
		root.setAttr(
			"aria-label",
			[sync, relay]
				.filter((half) => !half.hasClass("mdsync-hidden"))
				.map((half) => half.getAttr("aria-label"))
				.join("\n"),
		);
	};
	mountRelayStatus(plugin, relay, name);

	const render = (snapshot: SyncStatusSnapshot): void => {
		const offline = !navigator.onLine;
		sync.empty();
		sync.toggleClass("is-error", hasError(snapshot) && !offline);
		sync.toggleClass("is-offline", offline);
		sync.setAttr("aria-label", tooltip(plugin, snapshot, offline));
		renderSync(sync, snapshot, offline, canSync(plugin.settings));
		name();
	};

	render(controller.getSnapshot());
	plugin.register(controller.subscribe(render));
	// A dropped connection must not read as a broken remote.
	const renderCurrent = (): void => render(controller.getSnapshot());
	plugin.registerDomEvent(window, "online", renderCurrent);
	plugin.registerDomEvent(window, "offline", renderCurrent);
	return renderCurrent;
}

function renderSync(
	el: HTMLElement,
	snapshot: SyncStatusSnapshot,
	offline: boolean,
	setUp: boolean,
): void {
	const { pendingLocal, pendingRemote, conflicts } = snapshot;
	if (offline) {
		part(
			el,
			"cloud-off",
			pendingLocal > 0 ? `Offline · ${pendingLocal} waiting` : "Offline",
		);
		return;
	}
	if (!setUp) {
		part(el, "cloud-off", "Set up sync");
		return;
	}
	if (snapshot.error) {
		part(el, "circle-alert", "Sync stopped");
		return;
	}
	if (snapshot.busy) {
		el.createSpan({ cls: "mdsync-status-spinner" });
		el.createSpan({ text: snapshot.progressText ?? "Syncing…" });
		return;
	}
	if (snapshot.spaceErrors.length > 0) {
		part(
			el,
			"circle-alert",
			`${pluralize(snapshot.spaceErrors.length, "shared folder")} failed`,
		);
	}
	if (!snapshot.result) {
		part(el, "cloud", "Not compared");
		return;
	}
	if (conflicts > 0) {
		part(el, "triangle-alert", pluralize(conflicts, "conflict")).addClass(
			"is-conflict",
		);
	}
	if (pendingLocal > 0) part(el, "arrow-up", String(pendingLocal));
	if (pendingRemote > 0) part(el, "arrow-down", String(pendingRemote));
	if (!el.hasChildNodes()) part(el, "cloud-check", "Synced");
}

function part(parent: HTMLElement, icon: string, text: string): HTMLElement {
	const el = parent.createSpan({ cls: "mdsync-status-part" });
	setIcon(el, icon);
	el.createSpan({ text });
	return el;
}

function tooltip(
	plugin: PluginHost,
	snapshot: SyncStatusSnapshot,
	offline: boolean,
): string {
	if (offline) {
		return "No network connection. MDSync will sync once it is back.";
	}
	if (snapshot.error) return `MDSync error: ${snapshot.error}`;
	if (hasError(snapshot)) {
		const failed = snapshot.spaceErrors.map(
			({ root, message }) => `"${root}": ${message}`,
		);
		return `MDSync error in ${failed.join("; ")}`;
	}
	const headline = `MDSync: ${syncHeadline(plugin, snapshot)}`;
	return snapshot.lastCompareAt
		? `${headline}. Compared ${formatRelativeTime(snapshot.lastCompareAt)}`
		: headline;
}

/** A shared folder that failed counts: the rest syncs, it does not. */
function hasError(snapshot: SyncStatusSnapshot): boolean {
	return Boolean(snapshot.error) || snapshot.spaceErrors.length > 0;
}
