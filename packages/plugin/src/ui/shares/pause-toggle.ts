import { notifyError, serial } from "@/ui/common";

/** Shows the flip at once and never waits on the save; a failed save flips it back. */
export function pauseToggle(
	paused: boolean,
	save: (paused: boolean) => Promise<void>,
	show: (paused: boolean) => void,
): () => Promise<void> {
	let current = paused;
	return serial(async () => {
		const next = !current;
		current = next;
		show(next);
		try {
			await save(next);
		} catch (err) {
			current = !next;
			show(current);
			notifyError("Could not change pause", err);
		}
	});
}
