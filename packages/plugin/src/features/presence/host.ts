import type { App } from "obsidian";
import type { LiveSessions } from "@/features/live";
import type { People } from "./people";

export interface PresenceHost {
	readonly app: App;
	readonly realtime: { readonly live: LiveSessions; readonly people: People };
}
