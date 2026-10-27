import type { People, Unseen } from "@/features/presence";
import type { HubConnection } from "@/features/relay";
import type { SourceControlHost } from "@/features/source-control";

/** What the status bar and its menus need from the plugin. */
export interface StatusHost extends SourceControlHost {
	readonly unseen: Unseen;
	readonly realtime: { readonly hub: HubConnection; readonly people: People };
}
