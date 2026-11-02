import type { LinksHost } from "@/features/links";
import type { Unseen } from "@/features/presence";
import type { SpacesHost } from "@/features/spaces";

/** What the file tree marks need from the plugin: they offer share and link actions. */
export interface ExplorerHost extends SpacesHost, LinksHost {
	readonly unseen: Unseen;
}
