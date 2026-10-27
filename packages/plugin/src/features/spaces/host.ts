import type { RelayStatus } from "@/core/hub";
import type { CursorFollow, People } from "@/features/presence";
import type { SyncHost } from "@/features/sync";
import type { SpaceRecords } from "./records";

/** What shared folders need from the plugin. */
export interface SpacesHost extends SyncHost {
	readonly spaces: SpaceRecords;
	readonly follows: CursorFollow;
	readonly realtime: {
		readonly people: People;
		readonly hub: { statusOf(spaceId: string): RelayStatus };
	};
}
