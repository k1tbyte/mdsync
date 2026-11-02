import type { DiffHost } from "@/features/diff";
import type { ESetupStep } from "@/features/setup";
import type { SpacesHost } from "@/features/spaces";

/** What the source control view needs from the plugin. */
export interface SourceControlHost extends SpacesHost, DiffHost {
	openSetup(step?: ESetupStep): void;
}
