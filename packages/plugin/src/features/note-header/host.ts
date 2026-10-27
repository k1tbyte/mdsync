import type { LiveSessions } from "@/features/live";
import type { People } from "@/features/presence";
import type { HubConnection } from "@/features/relay";
import type { SpacesHost } from "@/features/spaces";

/** What the note header needs from the plugin. */
export interface NoteHeaderHost extends SpacesHost {
	readonly realtime: {
		readonly hub: HubConnection;
		readonly people: People;
		readonly live: LiveSessions;
	};
}
