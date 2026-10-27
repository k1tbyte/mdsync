import type { DiffHost } from "@/features/diff";
import type { HubConnection } from "@/features/relay";
import type { ESetupStep } from "@/features/setup";
import type { SpacesHost } from "@/features/spaces";

/** What the source control view needs from the plugin. */
export interface SourceControlHost extends SpacesHost, DiffHost {
	readonly realtime: SpacesHost["realtime"] & { readonly hub: HubConnection };
	openSetup(step?: ESetupStep): void;
}
