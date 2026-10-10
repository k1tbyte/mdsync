import { errorMessage } from "@/shared";

import type { Wizard } from "./wizard";

export interface ActionState {
	busy: boolean;
	error: string;
}

export async function runAction(
	wizard: Pick<Wizard, "redraw">,
	state: ActionState,
	task: () => Promise<unknown>,
	describe: (err: unknown) => string = errorMessage,
): Promise<boolean> {
	if (state.busy) return false;
	state.busy = true;
	state.error = "";
	wizard.redraw();
	try {
		await task();
		return true;
	} catch (err) {
		state.error = describe(err);
		return false;
	} finally {
		state.busy = false;
		wizard.redraw();
	}
}
