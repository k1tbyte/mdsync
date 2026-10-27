import { ESection } from "../types";
import type { SourceControlActions } from "./actions";

/** What a section's files can be sent to: one file from its row, many from the selection bar. */
export interface SectionAction {
	icon: string;
	rowLabel: string;
	text: (count: number) => string;
	cta: boolean;
	run: (actions: SourceControlActions, paths: string[]) => Promise<boolean>;
}

export const SECTION_ACTIONS: Record<ESection, ReadonlyArray<SectionAction>> = {
	[ESection.Conflicts]: [],
	[ESection.Local]: [
		{
			icon: "rotate-ccw",
			rowLabel: "Revert this file",
			text: () => "Revert",
			cta: false,
			run: (actions, paths) => actions.revertPaths(paths),
		},
		{
			icon: "upload",
			rowLabel: "Push this file",
			text: (count) => `Push ${count}`,
			cta: true,
			run: (actions, paths) => actions.pushPaths(paths),
		},
	],
	[ESection.Remote]: [
		{
			icon: "download",
			rowLabel: "Pull this file",
			text: (count) => `Pull ${count}`,
			cta: true,
			run: (actions, paths) => actions.pullPaths(paths),
		},
	],
};
