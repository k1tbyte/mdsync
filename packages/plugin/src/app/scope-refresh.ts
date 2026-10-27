import type { MdsyncSettings } from "@/core/settings";
import { canSync, type SyncController } from "@/features/sync";

const SCOPE_REFRESH_DEBOUNCE_MS = 800;

export interface ScopeRefresh {
	schedule(reason?: string): void;
	cancel(): void;
}

/** A scope change drops the comparison at once and compares again once the changes settle. */
export function createScopeRefresh(
	controller: () => SyncController,
	settings: () => MdsyncSettings,
): ScopeRefresh {
	let timer: number | null = null;
	const cancel = (): void => {
		if (timer === null) return;
		window.clearTimeout(timer);
		timer = null;
	};
	return {
		cancel,
		schedule(reason = "Sync scope changed.") {
			const sync = controller();
			const snapshot = sync.getSnapshot();
			// A first refresh still running read the old scope: drop it too.
			if (
				!snapshot.result &&
				snapshot.lastCompareAt === null &&
				!snapshot.busy
			) {
				return;
			}
			sync.invalidate(reason);
			if (!canSync(settings())) return;
			cancel();
			timer = window.setTimeout(() => {
				timer = null;
				void sync.refresh();
			}, SCOPE_REFRESH_DEBOUNCE_MS);
		},
	};
}
