/** The handle clears before `task` runs, so the task may schedule the next frame itself. */
export function frameTask(task: () => void): {
	schedule(): void;
	cancel(): void;
} {
	let frame: number | null = null;
	return {
		schedule() {
			frame ??= window.requestAnimationFrame(() => {
				frame = null;
				task();
			});
		},
		cancel() {
			if (frame === null) return;
			window.cancelAnimationFrame(frame);
			frame = null;
		},
	};
}
