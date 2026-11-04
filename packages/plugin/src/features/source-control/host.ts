import type { DiffHost } from "@/features/diff";
import type { ESetupStep } from "@/features/setup";
import type { SpacesHost } from "@/features/spaces";

export interface SourceControlHost extends SpacesHost, DiffHost {
	openSetup(step?: ESetupStep): void;
}
